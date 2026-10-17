/**
 * companyBroker: the authenticated local command channel between a follower and
 * the workspace owner.
 *
 * Every case drives the real broker over a real named pipe / Unix socket with a
 * real socket client, because the properties under test are transport
 * properties: what crosses a pipe, what a peer is allowed to learn from a
 * refused handshake, and what happens to a command whose answer never arrives.
 * A mocked net layer would pass all of them.
 *
 * Timing: the only real waits are `waitFor`, which polls a condition with a
 * deadline and names what it awaited, and the two deadline cases
 * (`requestTimeoutMs`, an uncertain response) which exercise the deadline on
 * purpose.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type {
  CompanyBrokerEvent,
  CompanyBrokerHandle,
  CompanyBrokerRequest,
} from '../src/company/companyBroker.js';
import {
  COMPANY_BROKER_MAX_FRAME_BYTES,
  COMPANY_BROKER_MIN_NONCE_LENGTH,
  COMPANY_BROKER_PROTOCOL_VERSION,
  createCompanyBrokerServer,
  isLocalBrokerEndpoint,
  resolveCompanyBrokerEndpoint,
  sendCompanyBrokerRequest,
} from '../src/company/companyBroker.js';
import { CompanyError } from '../src/company/companyError.js';
import { COMPANY_MAX_PROMPT_BYTES } from '../src/company/constants.js';

// ── Test harness ───────────────────────────────────────────────

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
} {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: Error) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Poll a condition until it holds; the failure names what was awaited. */
async function waitFor(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    if (condition()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

const settleAfter = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Raw newline-JSON peer, so a case can send what a correct client never would. */
interface RawClient {
  readonly frames: Record<string, unknown>[];
  readonly socket: net.Socket;
  send(value: unknown): void;
  sendRaw(text: string): void;
  waitForFrame(
    predicate: (frame: Record<string, unknown>) => boolean,
    what: string,
  ): Promise<Record<string, unknown>>;
  close(): void;
}

function openRawClient(endpoint: string): Promise<RawClient> {
  const connected = deferred<RawClient>();
  const socket = net.createConnection(endpoint);
  const frames: Record<string, unknown>[] = [];
  let buffer = '';

  socket.setEncoding('utf8');
  socket.on('data', (chunk) => {
    buffer += chunk;
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf('\n');
      if (!line) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof parsed !== 'object' || parsed === null) continue;
      const frame = parsed as Record<string, unknown>;
      frames.push(frame);
    }
  });
  socket.once('error', connected.reject);
  socket.once('connect', () => {
    connected.resolve({
      frames,
      socket,
      send: (value) => socket.write(`${JSON.stringify(value)}\n`),
      sendRaw: (text) => socket.write(text),
      waitForFrame: (predicate, what) => {
        const existing = frames.find(predicate);
        if (existing) return Promise.resolve(existing);
        return waitFor(() => frames.some(predicate), what).then(() => {
          const frame = frames.find(predicate);
          if (!frame) throw new Error(`missing the frame awaited by ${what}`);
          return frame;
        });
      },
      close: () => socket.destroy(),
    });
  });
  return connected.promise;
}

/** A request frame as a correct client writes it. */
function requestFrame(id: string, command: string, params?: unknown): Record<string, unknown> {
  return { v: COMPANY_BROKER_PROTOCOL_VERSION, t: 'request', id, command, params };
}

function resultErrorCode(frame: Record<string, unknown>): string | undefined {
  const error = frame['error'];
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}

function isErrorResult(frame: Record<string, unknown>, code: string): boolean {
  return frame['t'] === 'result' && frame['ok'] === false && resultErrorCode(frame) === code;
}

describe('company broker', () => {
  let socketDir: string;
  let nonce: string;
  let brokers: CompanyBrokerHandle[] = [];
  let rawClients: RawClient[] = [];
  let impostors: net.Server[] = [];
  let events: CompanyBrokerEvent[] = [];
  let calls: CompanyBrokerRequest[] = [];
  let handler: (request: CompanyBrokerRequest) => Promise<unknown> | unknown;

  beforeEach(() => {
    socketDir = fs.mkdtempSync(path.join(os.tmpdir(), 'company-broker-'));
    nonce = randomBytes(24).toString('hex');
    brokers = [];
    rawClients = [];
    impostors = [];
    events = [];
    calls = [];
    handler = (request) => ({
      command: request.command,
      params: request.params,
      id: request.requestId,
    });
  });

  afterEach(async () => {
    for (const client of rawClients) client.close();
    rawClients = [];
    for (const broker of brokers) await broker.dispose();
    brokers = [];
    for (const impostor of impostors) {
      await new Promise<void>((resolve) => impostor.close(() => resolve()));
    }
    impostors = [];
    fs.rmSync(socketDir, { recursive: true, force: true });
  });

  async function startBroker(
    overrides: Partial<Parameters<typeof createCompanyBrokerServer>[0]> = {},
  ): Promise<CompanyBrokerHandle> {
    const broker = await createCompanyBrokerServer({
      endpoint: resolveCompanyBrokerEndpoint(socketDir, nonce),
      nonce,
      onRequest: (request) => {
        calls.push(request);
        return handler(request);
      },
      onEvent: (event) => events.push(event),
      ...overrides,
    });
    brokers.push(broker);
    return broker;
  }

  /** The id the owner saw for one dispatched command. */
  function dispatchedId(command: string): string {
    const call = calls.find((entry) => entry.command === command);
    if (!call) throw new Error(`no command named ${command} was dispatched`);
    return call.requestId;
  }

  /** A raw peer that completed the handshake, for protocol-level cases. */
  async function openAuthenticatedPeer(broker: CompanyBrokerHandle): Promise<RawClient> {
    const client = await openRawClient(broker.endpoint);
    rawClients.push(client);
    client.send({ v: COMPANY_BROKER_PROTOCOL_VERSION, t: 'hello', nonce });
    await client.waitForFrame((frame) => frame['t'] === 'ack', 'the handshake ack');
    return client;
  }

  /** A second process listening on the endpoint without knowing the nonce. */
  async function startImpostor(at: string): Promise<{ received: string[] }> {
    const impostorNonce = randomBytes(24).toString('hex');
    const received: string[] = [];
    const server = net.createServer((socket) => {
      socket.on('data', (chunk) => {
        received.push(String(chunk));
        socket.write(
          `${JSON.stringify({
            v: COMPANY_BROKER_PROTOCOL_VERSION,
            t: 'ack',
            nonce: impostorNonce,
          })}\n`,
        );
      });
      socket.on('error', () => undefined);
    });
    impostors.push(server);
    await new Promise<void>((resolve) => server.listen(at, resolve));
    return { received };
  }

  // ── Authorized round trip ───────────────────────────────────

  it('answers a follower that presents the instance nonce', async () => {
    const broker = await startBroker();

    const result = await sendCompanyBrokerRequest({
      endpoint: broker.endpoint,
      nonce,
      command: 'snapshot',
      params: { scope: 'hot' },
    });

    expect(result.value).toEqual({
      command: 'snapshot',
      params: { scope: 'hot' },
      id: result.requestId,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ command: 'snapshot', params: { scope: 'hot' } });
    expect(events.map((event) => event.code)).toContain('request_completed');
  });

  it('reports the request id a caller can dedupe with', async () => {
    const broker = await startBroker();

    const minted = await sendCompanyBrokerRequest({
      endpoint: broker.endpoint,
      nonce,
      command: 'refresh',
    });
    const supplied = await sendCompanyBrokerRequest({
      endpoint: broker.endpoint,
      nonce,
      command: 'refresh',
      requestId: 'company-command-42',
    });

    expect(minted.requestId).not.toBe(supplied.requestId);
    expect(minted.requestId.length).toBeGreaterThan(0);
    expect(supplied.requestId).toBe('company-command-42');
    expect(calls.map((call) => call.requestId)).toEqual([minted.requestId, 'company-command-42']);
  });

  it('correlates concurrent commands answered out of order', async () => {
    const slow = deferred<unknown>();
    handler = (request) =>
      request.command === 'slow' ? slow.promise : Promise.resolve({ answered: request.command });
    const broker = await startBroker();

    const slowCall = sendCompanyBrokerRequest({
      endpoint: broker.endpoint,
      nonce,
      command: 'slow',
    });
    const fastCall = sendCompanyBrokerRequest({
      endpoint: broker.endpoint,
      nonce,
      command: 'fast',
    });

    // The fast command answers first; neither promise may take the other's.
    const fast = await fastCall;
    expect(fast.value).toEqual({ answered: 'fast' });
    expect(fast.requestId).toBe(dispatchedId('fast'));
    slow.resolve({ answered: 'slow' });
    const late = await slowCall;
    expect(late.value).toEqual({ answered: 'slow' });
    expect(late.requestId).toBe(dispatchedId('slow'));
    expect(fast.requestId).not.toBe(late.requestId);
  });

  it('carries a prompt at the company intake limit inside one frame', async () => {
    handler = (request) => {
      const params = request.params;
      const text =
        typeof params === 'object' && params !== null && 'text' in params ? params.text : '';
      return { received: String(text).length };
    };

    const broker = await startBroker();
    const text = 'a'.repeat(COMPANY_MAX_PROMPT_BYTES);

    const result = await sendCompanyBrokerRequest({
      endpoint: broker.endpoint,
      nonce,
      command: 'submit_prompt',
      params: { text },
    });

    expect(result.value).toEqual({ received: COMPANY_MAX_PROMPT_BYTES });
  });

  // ── Refusals ───────────────────────────────────────────────

  it('refuses a peer presenting the wrong nonce and keeps serving the endpoint', async () => {
    const broker = await startBroker();

    await expect(
      sendCompanyBrokerRequest({
        endpoint: broker.endpoint,
        nonce: randomBytes(24).toString('hex'),
        command: 'snapshot',
      }),
    ).rejects.toMatchObject({ code: 'company_broker_unauthorized' });

    expect(calls).toHaveLength(0);
    expect(events.map((event) => event.code)).toContain('peer_refused');
    // The refusal cost one connection, not the channel.
    await expect(
      sendCompanyBrokerRequest({ endpoint: broker.endpoint, nonce, command: 'snapshot' }),
    ).resolves.toMatchObject({ value: { command: 'snapshot' } });
  });

  it('refuses a nonce too short to be a secret before connecting', async () => {
    const broker = await startBroker();

    await expect(
      sendCompanyBrokerRequest({ endpoint: broker.endpoint, nonce: 'short', command: 'snapshot' }),
    ).rejects.toMatchObject({ code: 'company_broker_unauthorized' });

    expect(broker.connections).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('does not disclose a command to an impostor that cannot prove the nonce', async () => {
    const endpoint = resolveCompanyBrokerEndpoint(socketDir, nonce);
    const impostor = await startImpostor(endpoint);

    await expect(
      sendCompanyBrokerRequest({ endpoint, nonce, command: 'submit_prompt' }),
    ).rejects.toMatchObject({ code: 'company_broker_unauthorized' });

    // The impostor received the handshake and nothing else: a peer that cannot
    // prove it holds the nonce never learns what it would have been asked.
    await waitFor(() => impostor.received.length > 0, 'the impostor to be contacted');
    const transcript = impostor.received.join('');
    expect(transcript).toContain('"hello"');
    expect(transcript).not.toContain('submit_prompt');
  });

  it('never dispatches a command that arrives before the handshake', async () => {
    const broker = await startBroker();
    const client = await openRawClient(broker.endpoint);
    rawClients.push(client);

    client.send(requestFrame('early-1', 'snapshot'));

    const refusal = await client.waitForFrame(
      (frame) => frame['t'] === 'error',
      'the pre-handshake refusal',
    );
    expect(resultErrorCode(refusal)).toBe('company_broker_unauthorized');
    expect(calls).toHaveLength(0);
    expect(events.map((event) => event.code)).toContain('unauthenticated_request');

    // Only that frame was dropped: the connection can still handshake.
    client.send({ v: COMPANY_BROKER_PROTOCOL_VERSION, t: 'hello', nonce });
    await client.waitForFrame((frame) => frame['t'] === 'ack', 'the handshake after the refusal');
  });

  it('refuses a handshake with no nonce, and one on another wire version', async () => {
    const broker = await startBroker();
    const anonymous = await openRawClient(broker.endpoint);
    rawClients.push(anonymous);
    anonymous.send({ v: COMPANY_BROKER_PROTOCOL_VERSION, t: 'hello' });
    await anonymous.waitForFrame((frame) => frame['t'] === 'error', 'the anonymous refusal');
    expect(events.map((event) => event.code)).toContain('peer_refused');

    const future = await openRawClient(broker.endpoint);
    rawClients.push(future);
    future.send({ v: COMPANY_BROKER_PROTOCOL_VERSION + 1, t: 'hello', nonce });
    await waitFor(
      () => events.some((event) => event.code === 'version_mismatch'),
      'the version refusal',
    );
    expect(future.frames.some((frame) => frame['t'] === 'ack')).toBe(false);
    expect(events.map((event) => event.code)).toContain('version_mismatch');
    expect(calls).toHaveLength(0);
  });

  it('refuses a second handshake on an authenticated connection', async () => {
    const broker = await startBroker();
    const client = await openAuthenticatedPeer(broker);

    client.send({ v: COMPANY_BROKER_PROTOCOL_VERSION, t: 'hello', nonce });

    const refusal = await client.waitForFrame(
      (frame) => frame['t'] === 'error',
      'the duplicate-handshake refusal',
    );
    expect(resultErrorCode(refusal)).toBe('company_broker_unauthorized');
    expect(events.map((event) => event.code)).toContain('duplicate_identity');
  });

  it('ignores an unknown frame type from an authenticated peer', async () => {
    const broker = await startBroker();
    const client = await openAuthenticatedPeer(broker);

    client.send({ v: COMPANY_BROKER_PROTOCOL_VERSION, t: 'switch_session', id: 'x' });
    client.send(requestFrame('after-unknown', 'snapshot'));

    await client.waitForFrame(
      (frame) => frame['t'] === 'result' && frame['id'] === 'after-unknown',
      'the command after the unknown frame',
    );
    expect(events.map((event) => event.code)).toContain('frame_unknown_type');
    expect(calls).toHaveLength(1);
  });

  it('refuses a second command while the first is still in flight', async () => {
    const gate = deferred<unknown>();
    handler = () => gate.promise;
    const broker = await startBroker();
    const client = await openAuthenticatedPeer(broker);

    client.send(requestFrame('dup-1', 'submit_prompt'));
    await waitFor(() => broker.pendingRequests === 1, 'the first command to start');
    client.send(requestFrame('dup-1', 'submit_prompt'));

    const refusal = await client.waitForFrame(
      (frame) => isErrorResult(frame, 'company_broker_idempotent_busy'),
      'the duplicate-id refusal',
    );
    expect(refusal['id']).toBe('dup-1');
    expect(calls).toHaveLength(1);
    expect(events.map((event) => event.code)).toContain('duplicate_request_id');

    gate.resolve({ committed: true });
    const answered = await client.waitForFrame(
      (frame) => frame['t'] === 'result' && frame['id'] === 'dup-1' && frame['ok'] === true,
      'the first command to be answered',
    );
    expect(answered['value']).toEqual({ committed: true });
  });

  it('bounds requests in flight and peers connected at once', async () => {
    const gate = deferred<unknown>();
    handler = () => gate.promise;
    const broker = await startBroker({ maxPendingRequests: 1, maxConnections: 2 });
    const first = await openAuthenticatedPeer(broker);
    const second = await openAuthenticatedPeer(broker);

    first.send(requestFrame('busy-1', 'snapshot'));
    await waitFor(() => broker.pendingRequests === 1, 'the first command to start');
    second.send(requestFrame('busy-2', 'snapshot'));

    const refusal = await second.waitForFrame(
      (frame) => isErrorResult(frame, 'company_broker_too_many_requests'),
      'the in-flight refusal',
    );
    expect(refusal['id']).toBe('busy-2');
    expect(calls).toHaveLength(1);
    expect(events.map((event) => event.code)).toContain('too_many_requests');

    const extra = await openRawClient(broker.endpoint);
    rawClients.push(extra);
    await waitFor(
      () => events.some((event) => event.code === 'too_many_connections'),
      'the peer-slot refusal',
    );
    expect(extra.frames).toHaveLength(0);

    gate.resolve({ committed: true });
  });

  // ── Framing ────────────────────────────────────────────────

  it('drops a malformed frame whole and keeps serving the connection', async () => {
    const broker = await startBroker();
    const client = await openAuthenticatedPeer(broker);

    client.sendRaw('{"v":1,"t":"request",oops\n');
    client.send(requestFrame('after-garbage', 'snapshot'));

    const answer = await client.waitForFrame(
      (frame) => frame['t'] === 'result' && frame['id'] === 'after-garbage',
      'the command after the malformed frame',
    );
    expect(answer['ok']).toBe(true);
    expect(events.map((event) => event.code)).toContain('frame_malformed');
    expect(calls).toHaveLength(1);
  });

  it('drops an oversized frame and resynchronizes on the next newline', async () => {
    const broker = await startBroker();
    const client = await openAuthenticatedPeer(broker);

    client.sendRaw(
      `${'x'.repeat(COMPANY_BROKER_MAX_FRAME_BYTES + 4096)}\n` +
        `${JSON.stringify(requestFrame('after-big', 'snapshot'))}\n`,
    );

    const answer = await client.waitForFrame(
      (frame) => frame['t'] === 'result' && frame['id'] === 'after-big',
      'the command after the oversized frame',
    );
    expect(answer['ok']).toBe(true);
    expect(events.map((event) => event.code)).toContain('frame_too_large');
    expect(calls).toHaveLength(1);
  });

  it('refuses an oversized command before it reaches the channel', async () => {
    const broker = await startBroker();

    await expect(
      sendCompanyBrokerRequest({
        endpoint: broker.endpoint,
        nonce,
        command: 'submit_prompt',
        params: { text: 'a'.repeat(COMPANY_BROKER_MAX_FRAME_BYTES) },
      }),
    ).rejects.toMatchObject({ code: 'company_broker_frame_too_large' });

    expect(broker.connections).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('reports a handler failure by code and never echoes handler text', async () => {
    handler = () => {
      throw new CompanyError('company_contract_conflict', 'the prompt body was: hunter2');
    };
    const broker = await startBroker();

    const error = await sendCompanyBrokerRequest({
      endpoint: broker.endpoint,
      nonce,
      command: 'decide_contract',
    }).catch((err: unknown) => err as CompanyError);

    expect(error).toBeInstanceOf(CompanyError);
    expect((error as CompanyError).code).toBe('company_contract_conflict');
    expect((error as CompanyError).message).not.toContain('hunter2');
    expect(events.map((event) => event.code)).toContain('request_rejected');
    expect(JSON.stringify(events)).not.toContain('hunter2');
  });

  // ── Uncertain outcomes ─────────────────────────────────────

  it('does not replay a command whose answer never arrived', async () => {
    handler = () => new Promise<unknown>(() => undefined);
    const broker = await startBroker();
    const endpoint = broker.endpoint;

    const pending = sendCompanyBrokerRequest({
      endpoint,
      nonce,
      command: 'submit_prompt',
      params: { text: 'ship the release' },
    });
    await waitFor(() => broker.pendingRequests === 1, 'the command to reach the owner');

    // The owner disappears with the command in flight: the side effect may or
    // may not have been applied, and only the owner could know.
    await broker.dispose();

    await expect(pending).rejects.toMatchObject({ code: 'company_broker_server_closed' });
    expect(broker.connections).toBe(0);

    // A successor takes the address back, so a retry would have somewhere to
    // land. Asserting that nothing arrives later needs a real wait; there is
    // no event for an absence, and fake time cannot make the client's socket
    // decide to reconnect.
    const successor = await startBroker({ endpoint });
    await settleAfter(250);
    expect(calls).toHaveLength(1);
    expect(successor.connections).toBe(0);
    expect(successor.pendingRequests).toBe(0);
  });

  it('times out a command the broker never answers, without resending it', async () => {
    handler = () => new Promise<unknown>(() => undefined);
    const broker = await startBroker();

    await expect(
      sendCompanyBrokerRequest({
        endpoint: broker.endpoint,
        nonce,
        command: 'refresh',
        requestTimeoutMs: 150,
      }),
    ).rejects.toMatchObject({ code: 'company_broker_timeout' });

    expect(calls).toHaveLength(1);
  });

  it('reports an unavailable broker rather than a fabricated answer', async () => {
    const broker = await startBroker();
    const endpoint = broker.endpoint;

    await broker.dispose();

    await expect(
      sendCompanyBrokerRequest({ endpoint, nonce, command: 'snapshot' }),
    ).rejects.toMatchObject({ code: 'company_broker_unavailable' });
    expect(broker.disposed).toBe(true);
    // Disposing twice is a no-op, not a second teardown.
    await expect(broker.dispose()).resolves.toBeUndefined();
    expect(broker.connections).toBe(0);
    expect(broker.pendingRequests).toBe(0);
  });

  it('refuses a second owner on an endpoint that is already served', async () => {
    const broker = await startBroker();

    await expect(
      createCompanyBrokerServer({ endpoint: broker.endpoint, nonce, onRequest: () => null }),
    ).rejects.toMatchObject({ code: 'company_broker_unavailable' });

    // The live owner still answers; the loser never took its address.
    await expect(
      sendCompanyBrokerRequest({ endpoint: broker.endpoint, nonce, command: 'snapshot' }),
    ).resolves.toMatchObject({ value: { command: 'snapshot' } });
  });

  it.skipIf(process.platform === 'win32')('removes its socket file when disposed', async () => {
    const broker = await startBroker();
    expect(fs.existsSync(broker.endpoint)).toBe(true);

    await broker.dispose();

    expect(fs.existsSync(broker.endpoint)).toBe(false);
  });

  // ── Locality and secrecy ───────────────────────────────────

  it('refuses any endpoint that is not a local pipe or socket', async () => {
    for (const endpoint of [
      '127.0.0.1:7311',
      'tcp://127.0.0.1:7311',
      'localhost',
      'relative.sock',
    ]) {
      expect(isLocalBrokerEndpoint(endpoint)).toBe(false);
    }
    await expect(
      sendCompanyBrokerRequest({ endpoint: '127.0.0.1:7311', nonce, command: 'snapshot' }),
    ).rejects.toMatchObject({ code: 'company_broker_endpoint_not_local' });
    await expect(
      createCompanyBrokerServer({ endpoint: '127.0.0.1:7311', nonce, onRequest: () => null }),
    ).rejects.toMatchObject({ code: 'company_broker_endpoint_not_local' });
    expect(isLocalBrokerEndpoint(resolveCompanyBrokerEndpoint(socketDir, nonce))).toBe(true);
  });

  it('keeps the nonce out of the endpoint, the diagnostics and the errors', async () => {
    const endpoint = resolveCompanyBrokerEndpoint(socketDir, nonce);
    expect(endpoint).not.toContain(nonce);
    expect(nonce.length).toBeGreaterThanOrEqual(COMPANY_BROKER_MIN_NONCE_LENGTH);

    const broker = await startBroker();
    await sendCompanyBrokerRequest({ endpoint, nonce, command: 'snapshot', params: { a: 1 } });
    const refused = await sendCompanyBrokerRequest({
      endpoint,
      nonce: randomBytes(24).toString('hex'),
      command: 'snapshot',
    }).catch((err: unknown) => err as CompanyError);

    expect(JSON.stringify(events)).not.toContain(nonce);
    expect(JSON.stringify(events)).not.toContain(endpoint);
    expect((refused as CompanyError).message).not.toContain(nonce);
    expect(JSON.stringify(broker.endpoint)).not.toContain(nonce);
  });

  it('refuses a nonce and handler that are not usable configuration', async () => {
    const endpoint = resolveCompanyBrokerEndpoint(socketDir, nonce);
    await expect(
      createCompanyBrokerServer({
        endpoint,
        nonce: 'too-short',
        onRequest: () => null,
      }),
    ).rejects.toMatchObject({ code: 'company_broker_invalid_nonce' });
    await expect(
      createCompanyBrokerServer({
        endpoint,
        nonce,
        onRequest: undefined as unknown as () => null,
      }),
    ).rejects.toMatchObject({ code: 'company_broker_invalid_handler' });
  });

  it('derives a per-instance endpoint that no nonce can steer out of the namespace', () => {
    const first = resolveCompanyBrokerEndpoint(socketDir, nonce);
    const second = resolveCompanyBrokerEndpoint(socketDir, randomUUID());
    expect(first).not.toBe(second);

    // A descriptor read by a follower is attacker-shaped input: a nonce with
    // separators in it still has to land inside the owner-only namespace.
    const hostile = resolveCompanyBrokerEndpoint(socketDir, `..${path.sep}..${path.sep}escape`);
    if (process.platform === 'win32') {
      expect(hostile.toLowerCase().startsWith('\\\\.\\pipe\\')).toBe(true);
    } else {
      expect(path.dirname(hostile)).toBe(socketDir);
    }
  });
});

/**
 * ompBridge: the authenticated local channel between the coordinator (host) and
 * the OMP extension loaded into a managed session.
 *
 * Every case drives the real host implementation against the real extension
 * module over a real pipe/socket. The only fake is the OMP `ExtensionAPI` seam
 * itself, which reproduces the injected surface the extension is allowed to
 * touch: `on`, `registerTool`, `sendUserMessage`, `logger` and the injected
 * `zod` builder.
 *
 * Timing: the bridge timeout cases exercise a real deadline on purpose. Every
 * other case awaits an actual frame, socket close or answered promise; the only
 * remaining wait is `waitFor`, which polls a condition with a deadline and
 * fails with that condition named.
 */

import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type {
  OmpBridgeEvent,
  OmpBridgeHandle,
  OmpBridgePromptImage,
  OmpBridgeRpcRequest,
} from '../src/company/ompBridge.js';
import {
  COMPANY_BRIDGE_TOOL_ROLES,
  createOmpBridge,
  OMP_BRIDGE_ENV,
  OMP_BRIDGE_MAX_PENDING_RPCS,
  OMP_BRIDGE_MAX_PROMPT_IMAGES,
  OMP_BRIDGE_PROTOCOL_VERSION,
  OmpBridgeRpcError,
} from '../src/company/ompBridge.js';
import ompBridgeExtension from '../src/company/ompBridgeExtension.js';

// ── Fake OMP extension API ─────────────────────────────────────

interface FakeTool {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  execute(
    toolCallId: string,
    params: unknown,
    signalOrUpdate: unknown,
    updateOrContext: unknown,
    maybeContext: unknown,
  ): Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }>;
}

interface FakeContext {
  agent: { kind: 'main' | 'sub'; id: string; name: string; depth: number; parentId?: string };
  isIdle(): boolean;
  hasPendingMessages(): boolean;
  getAsyncJobSnapshot(): { running: unknown[]; recent: unknown[]; delivery: unknown };
  abort(): void;
  cwd: string;
  hasUI: boolean;
  mode: string;
  sessionManager: { getSessionId(): string; getSessionFile(): string | undefined };
  model?: { id: string };
  /**
   * The same-tool delegation OMP binds on a tool that re-registers a built-in.
   * Present only when a native tool of the same name exists, which is exactly
   * what the ask wrapper's fail-closed path checks.
   */
  invokeTool?: (
    params: Record<string, unknown>,
    options?: { signal?: AbortSignal },
  ) => Promise<{
    content?: { type: 'text'; text: string }[];
    details?: Record<string, unknown>;
  }>;
}

type FakeHandler = (event: unknown, ctx: FakeContext) => unknown;

class FakePi {
  readonly tools = new Map<string, FakeTool>();
  readonly handlers = new Map<string, FakeHandler[]>();
  readonly userMessages: { content: unknown; options: unknown }[] = [];
  readonly logs: { level: string; args: unknown[] }[] = [];
  readonly zod = {
    string: () => fakeSchema('string'),
    number: () => fakeSchema('number'),
    boolean: () => fakeSchema('boolean'),
    array: (element: unknown) => fakeSchema('array', element),
    record: (value: unknown) => fakeSchema('record', value),
    object: (shape: unknown) => fakeSchema('object', shape),
    union: (members: unknown) => fakeSchema('union', members),
    enum: (...values: unknown[]) => fakeSchema('enum', values),
    unknown: () => fakeSchema('unknown'),
  };

  readonly logger = {
    debug: (...args: unknown[]) => this.logs.push({ level: 'debug', args }),
    info: (...args: unknown[]) => this.logs.push({ level: 'info', args }),
    warn: (...args: unknown[]) => this.logs.push({ level: 'warn', args }),
    error: (...args: unknown[]) => this.logs.push({ level: 'error', args }),
  };

  registerTool(tool: FakeTool): void {
    this.tools.set(tool.name, tool);
  }

  on(event: string, handler: FakeHandler): void {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
  }

  sendUserMessage(content: unknown, options?: unknown): void {
    this.userMessages.push({ content, options });
  }

  /** Fire one event and return the first defined handler result (OMP semantics). */
  async emit(event: string, payload: unknown, ctx: FakeContext = makeContext()): Promise<unknown> {
    let result: unknown;
    for (const handler of this.handlers.get(event) ?? []) {
      const value = await handler(payload, ctx);
      if (value !== undefined && result === undefined) result = value;
    }
    return result;
  }

  /** Names of every event the extension subscribed to. */
  subscribedEvents(): string[] {
    return [...this.handlers.keys()].sort();
  }
}

function fakeSchema(kind: string, shape?: unknown): unknown {
  const schema: Record<string, unknown> = { kind, shape };
  for (const method of ['describe', 'optional', 'default', 'min']) schema[method] = () => schema;
  return schema;
}

function makeContext(overrides: Partial<FakeContext> = {}): FakeContext {
  return {
    agent: { kind: 'main', id: 'Main', name: 'main', depth: 0 },
    isIdle: () => true,
    hasPendingMessages: () => false,
    getAsyncJobSnapshot: () => ({ running: [], recent: [], delivery: {} }),
    abort: () => {},
    cwd: '/workspace',
    hasUI: true,
    mode: 'tui',
    sessionManager: {
      getSessionId: () => 'native-session-1',
      getSessionFile: () => '/workspace/.company/sessions/native-session-1.jsonl',
    },
    ...overrides,
  };
}

/** One ask call, in the shape the native tool declares. */
const ASK_CALL = {
  questions: [
    {
      id: 'q1',
      question: 'Which database should the service use?',
      options: [{ label: 'PostgreSQL', description: 'already provisioned' }, { label: 'SQLite' }],
    },
  ],
};

/** What the native dialog returns when the user picks the second option. */
function nativeAskResult(label: string): {
  content: { type: 'text'; text: string }[];
  details: Record<string, unknown>;
} {
  return {
    content: [{ type: 'text', text: `The user selected ${label}.` }],
    details: {
      results: [
        {
          id: 'q1',
          question: ASK_CALL.questions[0].question,
          options: ['PostgreSQL', 'SQLite'],
          multi: false,
          selectedOptions: [label],
        },
      ],
    },
  };
}

// ── Image fixtures ────────────────────────────────────────────

/** The 8-byte PNG container signature both halves check an image against. */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** A real 1x1 PNG, so the delivery cases carry actual image bytes. */
const PNG_1X1_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/**
 * Image bytes of exactly `byteLength` that start with a container signature.
 *
 * The bridge reads the signature and the size, not the codec, so a filler body
 * is what the budget and delivery cases need; a 6 MiB case costs 6 MiB.
 */
function synthesizedImage(
  mimeType: string,
  signature: readonly number[],
  byteLength: number,
): OmpBridgePromptImage {
  const bytes = Buffer.alloc(byteLength, 0x5a);
  Buffer.from(signature).copy(bytes, 0);
  return { mimeType, data: bytes.toString('base64') };
}

/** Reads the `code` of an `rpc_result` error answer, narrowing unknown frames. */
function rpcErrorCode(frame: Record<string, unknown>): string | undefined {
  const error = frame['error'];
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}

/** Narrow a bridge event union to its text member. */
function asText(event: OmpBridgeEvent): { seq: number; text: string } {
  if (event.k !== 'text') throw new Error(`expected a text event, received ${event.k}`);
  return event;
}

// ── Test harness ───────────────────────────────────────────────

interface RawClient {
  frames: Record<string, unknown>[];
  socket: net.Socket;
  send(value: unknown): void;
  sendRaw(text: string): void;
  waitFor(predicate: (frame: Record<string, unknown>) => boolean): Promise<Record<string, unknown>>;
  closed: Promise<void>;
  close(): void;
}

/**
 * Minimal deferred. `Promise.withResolvers` does not exist under this project's
 * ES2022 lib and needs Node 22, so the resolver pair is captured explicitly.
 */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: Error) => void;
} {
  let resolve: (value: T) => void = () => undefined;
  let reject: (err: Error) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function openRawClient(endpoint: string): Promise<RawClient> {
  const connected = deferred<RawClient>();
  const socket = net.createConnection(endpoint);
  const frames: Record<string, unknown>[] = [];
  const waiters: {
    predicate: (frame: Record<string, unknown>) => boolean;
    resolve: (frame: Record<string, unknown>) => void;
  }[] = [];
  const closed = deferred<void>();
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
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i].predicate(frame)) waiters.splice(i, 1)[0].resolve(frame);
      }
    }
  });
  socket.once('error', connected.reject);
  socket.once('close', () => closed.resolve());
  socket.once('connect', () => {
    connected.resolve({
      frames,
      socket,
      closed: closed.promise,
      send: (value) => socket.write(`${JSON.stringify(value)}\n`),
      sendRaw: (text) => socket.write(text),
      waitFor: (predicate) => {
        const existing = frames.find(predicate);
        if (existing) return Promise.resolve(existing);
        const waiter = deferred<Record<string, unknown>>();
        waiters.push({ predicate, resolve: waiter.resolve });
        return waiter.promise;
      },
      close: () => socket.destroy(),
    });
  });
  return connected.promise;
}

interface FakeHost {
  /** The extension loaded against this host, so its calls can be observed. */
  readonly pi: FakePi;
  readonly frames: Record<string, unknown>[];
  /** Push a host frame to the extension, bypassing every host-side check. */
  send(frame: unknown): void;
  waitFor(predicate: (frame: Record<string, unknown>) => boolean): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}

/**
 * A stand-in HOST for the extension's own gates.
 *
 * The real bridge validates an image before it is ever written, so the frames
 * the extension refuses are frames the real bridge cannot produce. Speaking the
 * host half of the protocol directly is the only way to drive those refusals —
 * and one connection at a time, because the real bridge refuses a second.
 */
async function startFakeHost(): Promise<FakeHost> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-bridge-host-'));
  const endpoint =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\omp-bridge-test-${randomBytes(8).toString('hex')}`
      : path.join(dir, 'host.sock');
  const frames: Record<string, unknown>[] = [];
  const waiters: {
    predicate: (frame: Record<string, unknown>) => boolean;
    resolve: (frame: Record<string, unknown>) => void;
  }[] = [];
  const server = net.createServer();
  let socket: net.Socket | undefined;
  let buffer = '';

  server.on('connection', (candidate) => {
    socket = candidate;
    candidate.setEncoding('utf8');
    candidate.on('data', (chunk) => {
      buffer += chunk;
      let index = buffer.indexOf('\n');
      while (index >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf('\n');
        if (!line) continue;
        const frame = JSON.parse(line) as Record<string, unknown>;
        frames.push(frame);
        if (frame['t'] === 'hello') {
          candidate.write(
            `${JSON.stringify({
              v: OMP_BRIDGE_PROTOCOL_VERSION,
              t: 'ack',
              sessionId: 'session-1',
              runEpoch: 7,
            })}\n`,
          );
        }
        for (let i = waiters.length - 1; i >= 0; i--) {
          if (waiters[i].predicate(frame)) waiters.splice(i, 1)[0].resolve(frame);
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(endpoint, resolve));

  const pi = new FakePi();
  Object.assign(process.env, {
    [OMP_BRIDGE_ENV.socket]: endpoint,
    [OMP_BRIDGE_ENV.token]: 'fake-host-nonce',
    [OMP_BRIDGE_ENV.session]: 'session-1',
    [OMP_BRIDGE_ENV.epoch]: '7',
    [OMP_BRIDGE_ENV.role]: 'qa',
  });
  ompBridgeExtension(pi as unknown as never);

  const host: FakeHost = {
    pi,
    frames,
    send: (value) => socket?.write(`${JSON.stringify(value)}\n`),
    waitFor: (predicate) => {
      const existing = frames.find(predicate);
      if (existing) return Promise.resolve(existing);
      const waiter = deferred<Record<string, unknown>>();
      waiters.push({ predicate, resolve: waiter.resolve });
      return waiter.promise;
    },
    close: async () => {
      socket?.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
  // The extension reads its endpoint at load time, so wait for the handshake
  // before a case pushes frames at it.
  await host.waitFor((frame) => frame['t'] === 'hello');
  return host;
}

/** Fake hosts the extension-side cases loaded, torn down after each test. */
const fakeHosts: FakeHost[] = [];

afterEach(async () => {
  for (const host of fakeHosts.splice(0)) await host.close();
  for (const key of Object.values(OMP_BRIDGE_ENV)) delete process.env[key];
});

const HELLO = { v: OMP_BRIDGE_PROTOCOL_VERSION, t: 'hello' } as const;

/**
 * Poll a condition until it holds, yielding to the event loop between checks so
 * socket I/O can actually be delivered. The deadline bounds the failure, and the
 * failure names what was awaited rather than reporting a bare timeout.
 */
async function waitFor(condition: () => boolean, what = 'condition'): Promise<void> {
  const deadline = Date.now() + 5000;
  for (;;) {
    if (condition()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

describe('omp bridge', () => {
  let socketDir: string;
  let bridge: OmpBridgeHandle | undefined;
  let rawClients: RawClient[] = [];
  const events: OmpBridgeEvent[] = [];

  beforeEach(() => {
    socketDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-bridge-'));
    events.length = 0;
    rawClients = [];
  });

  afterEach(async () => {
    for (const client of rawClients) client.close();
    rawClients = [];
    await bridge?.dispose();
    bridge = undefined;
    fs.rmSync(socketDir, { recursive: true, force: true });
    for (const key of Object.values(OMP_BRIDGE_ENV)) delete process.env[key];
  });

  function startBridge(
    overrides: Partial<Parameters<typeof createOmpBridge>[0]> = {},
  ): OmpBridgeHandle {
    const handle = createOmpBridge({
      sessionId: 'session-1',
      runEpoch: 7,
      role: 'worker',
      socketDir,
      rpcHandler: async () => ({ allow: true }),
      ...overrides,
    });
    handle.onEvent((event) => events.push(event));
    bridge = handle;
    return handle;
  }

  /** Point the environment at the bridge and load the real extension module. */
  function loadExtension(handle: OmpBridgeHandle, role = 'worker'): FakePi {
    const pi = new FakePi();
    Object.assign(process.env, handle.childEnv, { [OMP_BRIDGE_ENV.role]: role });
    ompBridgeExtension(pi as unknown as never);
    return pi;
  }

  /**
   * Load the real extension and wait until it has actually authenticated.
   * The host's `ready` settles when it accepts the handshake, while the
   * extension marks itself authenticated when it reads the acknowledgement, so
   * waiting on an event only an authenticated extension can send closes that
   * gap without guessing at a delay.
   */
  async function startExtension(handle: OmpBridgeHandle, role = 'worker'): Promise<FakePi> {
    const pi = loadExtension(handle, role);
    await handle.ready;
    // The host settles `ready` when it accepts the handshake, while the
    // extension marks itself authenticated when it reads the acknowledgement —
    // one more turn. Re-emitting until the host observes the event is the
    // observable signal that the extension is live, so no delay is guessed.
    await waitFor(() => {
      void pi.emit('session_start', { type: 'session_start' });
      return events.some((event) => event.k === 'session' && event.phase === 'started');
    }, 'the extension to authenticate');
    return pi;
  }

  async function authenticatedClient(handle: OmpBridgeHandle): Promise<RawClient> {
    const client = await openRawClient(handle.endpoint);
    rawClients.push(client);
    client.send({
      ...HELLO,
      sessionId: handle.sessionId,
      runEpoch: handle.runEpoch,
      nonce: handle.nonce,
    });
    await client.waitFor((frame) => frame['t'] === 'ack');
    return client;
  }

  // ── Handshake ───────────────────────────────────────────────

  it('resolves ready only after an authenticated extension handshake', async () => {
    const handle = startBridge();
    expect(handle.endpoint).not.toBe('');
    expect(handle.nonce).toHaveLength(64);

    // Nothing can settle `ready` before a client connects, so one macrotask
    // turn is enough to observe that it is still pending.
    const pending = deferred<string>();
    void handle.ready.then(() => pending.resolve('ready'));
    await new Promise((resolve) => setImmediate(resolve));
    expect(await Promise.race([pending.promise, Promise.resolve('pending')])).toBe('pending');

    const pi = await startExtension(handle);
    await handle.ready;
    await waitFor(
      () => events.some((event) => event.k === 'session' && event.phase === 'started'),
      'the session_started event',
    );

    expect(events.find((event) => event.k === 'session')).toMatchObject({
      phase: 'started',
      nativeSessionId: 'native-session-1',
      nativeSessionPath: '/workspace/.company/sessions/native-session-1.jsonl',
    });
    expect(pi.subscribedEvents()).toContain('tool_call');
  });

  it('refuses a client that presents the wrong nonce and never becomes ready', async () => {
    const handle = startBridge();
    let ready = false;
    // The disposal rejection is expected here; only the settling matters.
    void handle.ready.then(
      () => {
        ready = true;
      },
      () => undefined,
    );

    const client = await openRawClient(handle.endpoint);
    rawClients.push(client);
    client.send({
      ...HELLO,
      sessionId: 'session-1',
      runEpoch: 7,
      nonce: randomBytes(32).toString('hex'),
    });
    await client.closed;

    expect(ready).toBe(false);
    expect(client.frames.filter((frame) => frame['t'] === 'ack')).toHaveLength(0);
    expect(
      events.some((event) => event.k === 'error' && event.code === 'omp_bridge_bad_handshake'),
    ).toBe(true);
  });

  it('refuses a handshake for a different session or run epoch', async () => {
    for (const wrong of [
      { sessionId: 'session-2', runEpoch: 7 },
      { sessionId: 'session-1', runEpoch: 6 },
    ]) {
      const handle = startBridge();
      const client = await openRawClient(handle.endpoint);
      rawClients.push(client);
      client.send({ ...HELLO, ...wrong, nonce: handle.nonce });
      await client.closed;
      expect(client.frames.filter((frame) => frame['t'] === 'ack')).toHaveLength(0);
      await handle.dispose();
      events.length = 0;
    }
  });

  // ── Prompt delivery ─────────────────────────────────────────

  it('delivers a prompt through the native sendUserMessage API', async () => {
    const handle = startBridge();
    const pi = await startExtension(handle, 'director');
    await handle.ready;

    await handle.sendPrompt({ requestId: 'p-1', text: 'Draft the contract for the sprint.' });
    await waitFor(() => pi.userMessages.length === 1, 'the delivered prompt');

    expect(pi.userMessages[0].content).toBe('Draft the contract for the sprint.');
    expect(pi.userMessages[0].options).toBeUndefined();
  });

  it('reassembles a prompt larger than one frame', async () => {
    const handle = startBridge();
    const pi = await startExtension(handle);
    await handle.ready;

    const text = `${'héllo wörld '.repeat(30_000)}✅`;
    expect(Buffer.byteLength(text, 'utf8')).toBeGreaterThan(256 * 1024);

    await handle.sendPrompt({ requestId: 'p-big', text });
    await waitFor(() => pi.userMessages.length === 1, 'the reassembled prompt');
    expect(pi.userMessages[0].content).toBe(text);
  });

  it('passes the requested delivery mode to the native queue semantics', async () => {
    const handle = startBridge();
    const pi = await startExtension(handle);
    await handle.ready;

    await handle.sendPrompt({
      requestId: 'p-2',
      text: 'also answer this',
      delivery: 'follow_up',
    });
    await waitFor(() => pi.userMessages.length === 1, 'the delivered prompt');
    expect(pi.userMessages[0].options).toEqual({ deliverAs: 'followUp' });
  });

  it('refuses to send a prompt when the extension is gone', async () => {
    const handle = startBridge();
    loadExtension(handle);
    await handle.ready;
    await handle.dispose();

    await expect(
      handle.sendPrompt({ requestId: 'p-3', text: 'nobody listens' }),
    ).rejects.toMatchObject({ code: 'omp_bridge_disconnected' });
  });

  it('delivers a prompt image to the native session as real image content', async () => {
    const handle = startBridge();
    const pi = await startExtension(handle);
    await handle.ready;

    await handle.sendPrompt({
      requestId: 'p-img',
      text: 'What does this screenshot show?',
      images: [{ mimeType: 'image/png', data: PNG_1X1_BASE64 }],
    });

    // The ack is the proof of delivery, so the assertion after it can be
    // synchronous: no polling, no guessed delay.
    expect(pi.userMessages).toHaveLength(1);
    expect(pi.userMessages[0].options).toBeUndefined();
    expect(pi.userMessages[0].content).toEqual([
      { type: 'text', text: 'What does this screenshot show?' },
      { type: 'image', mimeType: 'image/png', data: PNG_1X1_BASE64 },
    ]);
  });

  it('delivers several images and the text once, in one native message', async () => {
    const handle = startBridge();
    const pi = await startExtension(handle);
    await handle.ready;
    const jpeg = synthesizedImage('image/jpeg', [0xff, 0xd8, 0xff, 0xe0], 64);

    await handle.sendPrompt({
      requestId: 'p-many',
      text: 'Compare these two captures.',
      images: [
        { mimeType: 'image/png', data: PNG_1X1_BASE64 },
        { mimeType: 'image/jpeg', data: jpeg.data },
      ],
    });

    // One message, and the text appears exactly once: a second delivery would
    // make the model answer the same prompt twice.
    expect(pi.userMessages).toHaveLength(1);
    expect(pi.userMessages[0].content).toEqual([
      { type: 'text', text: 'Compare these two captures.' },
      { type: 'image', mimeType: 'image/png', data: PNG_1X1_BASE64 },
      { type: 'image', mimeType: 'image/jpeg', data: jpeg.data },
    ]);
  });

  it('reassembles a long prompt that carries an image past the frame cap', async () => {
    const handle = startBridge();
    const pi = await startExtension(handle);
    await handle.ready;
    const text = `${'long prompt body '.repeat(30_000)}done`;
    expect(Buffer.byteLength(text, 'utf8')).toBeGreaterThan(256 * 1024);
    // Past the cap on its own once base64-inflated, so this takes the digested
    // chunk sequence rather than one frame.
    const image = synthesizedImage('image/png', [...PNG_SIGNATURE], 400 * 1024);

    await handle.sendPrompt({
      requestId: 'p-big-img',
      text,
      images: [{ mimeType: 'image/png', data: image.data }],
    });

    expect(pi.userMessages).toHaveLength(1);
    expect(pi.userMessages[0].content).toEqual([
      { type: 'text', text },
      { type: 'image', mimeType: 'image/png', data: image.data },
    ]);
  });

  it('refuses a malformed or unaccepted image before any delivery', async () => {
    const png = synthesizedImage('image/png', [...PNG_SIGNATURE], 32);
    const cases: {
      readonly label: string;
      readonly code: string;
      readonly image: OmpBridgePromptImage;
    }[] = [
      {
        label: 'a media type the runtime does not accept',
        code: 'omp_bridge_image_type_unsupported',
        image: { mimeType: 'image/bmp', data: png.data },
      },
      {
        label: 'data that is not canonical base64',
        code: 'omp_bridge_image_data_malformed',
        image: { mimeType: 'image/png', data: `${PNG_1X1_BASE64.slice(0, -4)}!` },
      },
      {
        label: 'bytes that are not the container the type declares',
        code: 'omp_bridge_image_mime_mismatch',
        image: {
          mimeType: 'image/png',
          data: Buffer.from('%PDF-1.7 not an image').toString('base64'),
        },
      },
      {
        label: 'an image larger than one attachment may be',
        code: 'omp_bridge_image_too_large',
        image: {
          mimeType: 'image/png',
          data: synthesizedImage('image/png', [...PNG_SIGNATURE], 6 * 1024 * 1024 + 1).data,
        },
      },
    ];

    for (const { label, code, image } of cases) {
      const handle = startBridge();
      const pi = await startExtension(handle);
      await handle.ready;

      await expect(
        handle.sendPrompt({ requestId: `p-bad-${code}`, text: 'look', images: [image] }),
        label,
      ).rejects.toMatchObject({ code });
      // Refused before the socket is touched: nothing reached the session, and
      // nothing about the image was logged either.
      expect(pi.userMessages, label).toHaveLength(0);
      await handle.dispose();
      bridge = undefined;
      events.length = 0;
    }
  });

  it('refuses a prompt carrying more images than the bridge allows', async () => {
    const handle = startBridge();
    const pi = await startExtension(handle);
    await handle.ready;
    const one = { mimeType: 'image/png', data: PNG_1X1_BASE64 };

    await expect(
      handle.sendPrompt({
        requestId: 'p-many-images',
        text: 'nine',
        images: Array.from({ length: OMP_BRIDGE_MAX_PROMPT_IMAGES + 1 }, () => one),
      }),
    ).rejects.toMatchObject({ code: 'omp_bridge_image_too_many' });
    expect(pi.userMessages).toHaveLength(0);
  });

  it('refuses a prompt composed for another run epoch', async () => {
    const handle = startBridge();
    const pi = await startExtension(handle);
    await handle.ready;

    await expect(
      handle.sendPrompt({ requestId: 'p-stale', text: 'stale', runEpoch: 6 }),
    ).rejects.toMatchObject({ code: 'omp_bridge_stale_run_identity' });
    expect(pi.userMessages).toHaveLength(0);
  });

  it('correlates a native delivery failure to the host instead of resolving', async () => {
    const handle = startBridge();
    const pi = await startExtension(handle);
    await handle.ready;
    pi.sendUserMessage = () => {
      throw new Error('session is closed');
    };

    await expect(
      handle.sendPrompt({ requestId: 'p-throw', text: 'does this land?' }),
    ).rejects.toMatchObject({ code: 'omp_bridge_prompt_delivery_failed' });
    // A refusal is static: the native message may quote the content it choked
    // on, so neither it nor the prompt text may reach the host or a log.
    const logged = pi.logs.map((entry) => entry.args.join(' ')).join('\n');
    expect(logged).not.toContain('session is closed');
    expect(logged).not.toContain('does this land?');
  });

  it('refuses a host image frame whose bytes are not the container it declares', async () => {
    const host = await startFakeHost();
    fakeHosts.push(host);

    host.send({
      v: OMP_BRIDGE_PROTOCOL_VERSION,
      t: 'prompt',
      id: 'p-hostile',
      text: 'describe this',
      images: [{ mimeType: 'image/png', data: Buffer.from('GIF89a').toString('base64') }],
    });
    const refusal = await host.waitFor(
      (frame) => frame['t'] === 'prompt_result' && frame['id'] === 'p-hostile',
    );

    // The model is never handed bytes labelled a picture they are not, and the
    // host learns why instead of waiting out its own deadline.
    expect(refusal['ok']).toBe(false);
    expect(rpcErrorCode(refusal)).toBe('omp_bridge_image_mime_mismatch');
    expect(host.pi.userMessages).toHaveLength(0);
  });

  it('answers one delivery per prompt and nothing else', async () => {
    const host = await startFakeHost();
    fakeHosts.push(host);

    host.send({
      v: OMP_BRIDGE_PROTOCOL_VERSION,
      t: 'prompt',
      id: 'p-ack',
      text: 'hello',
      images: [{ mimeType: 'image/png', data: PNG_1X1_BASE64 }],
    });
    const answer = await host.waitFor((frame) => frame['t'] === 'prompt_result');

    expect(answer).toMatchObject({ id: 'p-ack', ok: true, sessionId: 'session-1', runEpoch: 7 });
    expect(host.pi.userMessages).toHaveLength(1);
    expect(
      host.frames.filter((frame) => frame['t'] === 'prompt_result' && frame['id'] === 'p-ack'),
    ).toHaveLength(1);
  });

  it('drops a prompt chunk sequence whose digest does not match its bytes', async () => {
    const host = await startFakeHost();
    fakeHosts.push(host);
    const body = Buffer.from(JSON.stringify({ v: 1, text: 'tampered', images: [] }), 'utf8');

    host.send({
      v: OMP_BRIDGE_PROTOCOL_VERSION,
      t: 'prompt_begin',
      id: 'p-tampered',
      totalBytes: body.length,
      mode: 'structured',
      imageCount: 0,
    });
    host.send({
      v: OMP_BRIDGE_PROTOCOL_VERSION,
      t: 'prompt_chunk',
      id: 'p-tampered',
      offset: 0,
      data: body.toString('base64'),
    });
    host.send({
      v: OMP_BRIDGE_PROTOCOL_VERSION,
      t: 'prompt_end',
      id: 'p-tampered',
      totalBytes: body.length,
      digest: '0'.repeat(64),
    });

    await waitFor(
      () => host.pi.logs.some((entry) => entry.args.join(' ').includes('digest does not match')),
      'the digest mismatch report',
    );
    expect(host.pi.userMessages).toHaveLength(0);
  });

  it('refuses a prompt whose structured body is not the prompt it announced', async () => {
    const host = await startFakeHost();
    fakeHosts.push(host);
    const body = Buffer.from(
      JSON.stringify({ v: 1, text: 'one image is missing', images: [] }),
      'utf8',
    );

    host.send({
      v: OMP_BRIDGE_PROTOCOL_VERSION,
      t: 'prompt_begin',
      id: 'p-short',
      totalBytes: body.length,
      mode: 'structured',
      imageCount: 2,
    });
    host.send({
      v: OMP_BRIDGE_PROTOCOL_VERSION,
      t: 'prompt_chunk',
      id: 'p-short',
      offset: 0,
      data: body.toString('base64'),
    });
    host.send({
      v: OMP_BRIDGE_PROTOCOL_VERSION,
      t: 'prompt_end',
      id: 'p-short',
      totalBytes: body.length,
      digest: createHash('sha256').update(body).digest('hex'),
    });

    const refusal = await host.waitFor((frame) => frame['t'] === 'prompt_result');
    // The text could have been delivered as a note about a missing attachment;
    // it is refused whole instead, so nothing pretends the image arrived.
    expect(refusal['ok']).toBe(false);
    expect(rpcErrorCode(refusal)).toBe('omp_bridge_prompt_malformed');
    expect(host.pi.userMessages).toHaveLength(0);
  });

  // ── RPC correlation and bounds ───────────────────────────────

  it('correlates concurrent authorization calls by request id', async () => {
    const seen: OmpBridgeRpcRequest[] = [];
    const handle = startBridge({
      rpcHandler: async (request) => {
        seen.push(request);
        if (request.method !== 'authorize_tool') return { allow: true };
        return new Promise((resolve) => {
          setTimeout(
            () => resolve({ allow: request.toolName === 'read', reason: 'not allowed here' }),
            request.toolName === 'read' ? 60 : 0,
          );
        });
      },
    });
    const pi = await startExtension(handle);
    await handle.ready;
    const ctx = makeContext();

    const writeGate = pi.emit(
      'tool_call',
      { toolName: 'write', toolCallId: 'call-w', input: { path: 'a.ts' } },
      ctx,
    );
    const readGate = pi.emit(
      'tool_call',
      { toolName: 'read', toolCallId: 'call-r', input: { path: 'b.ts' } },
      ctx,
    );

    // The slow answer arrives last; each caller still gets its own decision.
    await expect(writeGate).resolves.toMatchObject({
      block: true,
      reason: expect.stringContaining('not allowed here'),
    });
    await expect(readGate).resolves.toBeUndefined();

    expect(seen).toHaveLength(2);
    expect(new Set(seen.map((request) => request.id)).size).toBe(2);
    expect(seen[0]).toMatchObject({
      method: 'authorize_tool',
      toolName: 'write',
      toolCallId: 'call-w',
      input: { path: 'a.ts' },
      sessionId: 'session-1',
      runEpoch: 7,
    });
  });

  it('rejects a duplicate request id and a call beyond the pending bound', async () => {
    const seen: OmpBridgeRpcRequest[] = [];
    const handle = startBridge({
      rpcHandler: async (request) => {
        seen.push(request);
        return new Promise(() => {});
      },
    });
    const client = await authenticatedClient(handle);

    const call = (id: string) => ({
      v: OMP_BRIDGE_PROTOCOL_VERSION,
      t: 'rpc',
      id,
      method: 'authorize_tool',
      params: {
        sessionId: 'session-1',
        runEpoch: 7,
        toolCallId: `call-${id}`,
        toolName: 'write',
        input: { path: 'a.ts' },
      },
    });

    client.send(call('dup'));
    client.send(call('dup'));
    const duplicate = await client.waitFor(
      (frame) =>
        frame['t'] === 'rpc_result' && rpcErrorCode(frame) === 'omp_bridge_duplicate_request_id',
    );
    expect(duplicate['ok']).toBe(false);

    for (let i = 0; i < OMP_BRIDGE_MAX_PENDING_RPCS; i++) client.send(call(`bulk-${i}`));
    const overflow = await client.waitFor(
      (frame) =>
        frame['t'] === 'rpc_result' && rpcErrorCode(frame) === 'omp_bridge_too_many_pending',
    );
    expect(overflow['ok']).toBe(false);
    expect(overflow['id']).toBe(`bulk-${OMP_BRIDGE_MAX_PENDING_RPCS - 1}`);

    expect(seen).toHaveLength(OMP_BRIDGE_MAX_PENDING_RPCS);
    expect(handle.pendingRpcs).toBe(OMP_BRIDGE_MAX_PENDING_RPCS);
  });

  it('answers a failing handler as a decision error rather than a crash', async () => {
    const handle = startBridge({
      rpcHandler: async () => {
        throw new OmpBridgeRpcError('omp_bridge_permission_denied', 'outside the workspace');
      },
    });
    const pi = await startExtension(handle);
    await handle.ready;

    const gate = await pi.emit('tool_call', {
      toolName: 'bash',
      toolCallId: 'call-1',
      input: { command: 'rm -rf /' },
    });
    expect(gate).toMatchObject({
      block: true,
      reason: expect.stringContaining('outside the workspace'),
    });
  });

  it('dispatches an authorize_tool request carried on the real wire', async () => {
    const seen: OmpBridgeRpcRequest[] = [];
    const handle = startBridge({
      rpcHandler: async (request) => {
        seen.push(request);
        return { allow: true };
      },
    });
    const client = await authenticatedClient(handle);

    client.send({
      v: OMP_BRIDGE_PROTOCOL_VERSION,
      t: 'rpc',
      id: 'wire-1',
      method: 'authorize_tool',
      params: {
        sessionId: handle.sessionId,
        runEpoch: handle.runEpoch,
        toolCallId: 'call-wire',
        toolName: 'bash',
        input: { command: 'npm test' },
        agentKind: 'main',
      },
    });
    const answer = await client.waitFor(
      (frame) => frame['t'] === 'rpc_result' && frame['id'] === 'wire-1',
    );

    expect(answer['ok']).toBe(true);
    expect(answer['result']).toEqual({ allow: true });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      id: 'wire-1',
      method: 'authorize_tool',
      toolCallId: 'call-wire',
      toolName: 'bash',
      input: { command: 'npm test' },
      agentKind: 'main',
      sessionId: handle.sessionId,
      runEpoch: handle.runEpoch,
    });
  });

  it('dispatches a subagent spawn request carried on the real wire', async () => {
    const seen: OmpBridgeRpcRequest[] = [];
    const handle = startBridge({
      rpcHandler: async (request) => {
        seen.push(request);
        return { allow: false, reason: 'read-only child required' };
      },
    });
    const client = await authenticatedClient(handle);

    client.send({
      v: OMP_BRIDGE_PROTOCOL_VERSION,
      t: 'rpc',
      id: 'wire-2',
      method: 'authorize_subagent',
      params: {
        sessionId: handle.sessionId,
        runEpoch: handle.runEpoch,
        agent: 'coder',
        invocationKind: 'task',
        patterns: ['openai-codex/gpt-6-luna:xhigh'],
      },
    });
    const answer = await client.waitFor(
      (frame) => frame['t'] === 'rpc_result' && frame['id'] === 'wire-2',
    );

    expect(answer['result']).toEqual({ allow: false, reason: 'read-only child required' });
    expect(seen[0]).toMatchObject({
      method: 'authorize_subagent',
      agent: 'coder',
      invocationKind: 'task',
      patterns: ['openai-codex/gpt-6-luna:xhigh'],
    });
  });

  it('refuses a company tool that claims a role this run does not have', async () => {
    let calls = 0;
    const handle = startBridge({
      role: 'worker',
      rpcHandler: async () => {
        calls += 1;
        return { accepted: true };
      },
    });
    const client = await authenticatedClient(handle);

    client.send({
      v: OMP_BRIDGE_PROTOCOL_VERSION,
      t: 'rpc',
      id: 'wire-3',
      method: 'company_tool',
      params: {
        sessionId: handle.sessionId,
        runEpoch: handle.runEpoch,
        toolCallId: 'call-3',
        toolName: 'company_judge_result',
        role: 'judge',
        payload: { verdict: 'passed' },
      },
    });
    const answer = await client.waitFor(
      (frame) => frame['t'] === 'rpc_result' && frame['id'] === 'wire-3',
    );

    expect(answer['ok']).toBe(false);
    expect(rpcErrorCode(answer)).toBe('omp_bridge_role_mismatch');
    expect(calls).toBe(0);
  });

  it('refuses a company tool that belongs to another role before the handler runs', async () => {
    let calls = 0;
    const handle = startBridge({
      role: 'worker',
      rpcHandler: async () => {
        calls += 1;
        return { accepted: true };
      },
    });
    const client = await authenticatedClient(handle);

    // The forged frame claims this run's own role, so only the tool→role map
    // can refuse it.
    client.send({
      v: OMP_BRIDGE_PROTOCOL_VERSION,
      t: 'rpc',
      id: 'wire-3b',
      method: 'company_tool',
      params: {
        sessionId: handle.sessionId,
        runEpoch: handle.runEpoch,
        toolCallId: 'call-3b',
        toolName: 'company_judge_result',
        role: handle.role,
        payload: { verdict: 'passed' },
      },
    });
    const answer = await client.waitFor(
      (frame) => frame['t'] === 'rpc_result' && frame['id'] === 'wire-3b',
    );

    expect(answer['ok']).toBe(false);
    expect(rpcErrorCode(answer)).toBe('omp_bridge_tool_role_forbidden');
    expect(calls).toBe(0);
    expect(handle.pendingRpcs).toBe(0);
  });

  it('refuses a company tool this bridge does not offer', async () => {
    let calls = 0;
    const handle = startBridge({
      role: 'worker',
      rpcHandler: async () => {
        calls += 1;
        return { accepted: true };
      },
    });
    const client = await authenticatedClient(handle);

    client.send({
      v: OMP_BRIDGE_PROTOCOL_VERSION,
      t: 'rpc',
      id: 'wire-3c',
      method: 'company_tool',
      params: {
        sessionId: handle.sessionId,
        runEpoch: handle.runEpoch,
        toolCallId: 'call-3c',
        toolName: 'company_run_shell',
        role: handle.role,
        payload: { command: 'rm -rf /' },
      },
    });
    const answer = await client.waitFor(
      (frame) => frame['t'] === 'rpc_result' && frame['id'] === 'wire-3c',
    );

    expect(answer['ok']).toBe(false);
    expect(rpcErrorCode(answer)).toBe('omp_bridge_unknown_tool');
    expect(calls).toBe(0);
  });

  it('gives an unauthenticated caller no decision and no event data', async () => {
    let calls = 0;
    const handle = startBridge({
      rpcHandler: async () => {
        calls += 1;
        return { allow: true, secret: 'must never reach an unauthenticated peer' };
      },
    });
    const stranger = await openRawClient(handle.endpoint);
    rawClients.push(stranger);

    // No hello: an authorization request must be refused outright.
    stranger.send({
      v: OMP_BRIDGE_PROTOCOL_VERSION,
      t: 'rpc',
      id: 'anon-1',
      method: 'authorize_tool',
      params: {
        sessionId: handle.sessionId,
        runEpoch: handle.runEpoch,
        toolCallId: 'call-anon',
        toolName: 'write',
        input: { path: 'a.ts' },
      },
    });
    await waitFor(
      () =>
        events.some((event) => event.k === 'error' && event.code === 'omp_bridge_unauthenticated'),
      'the unauthenticated-frame error',
    );

    // The answer, if any, must not carry the handler's result.
    expect(stranger.frames.filter((frame) => frame['t'] === 'rpc_result')).toHaveLength(0);
    expect(JSON.stringify(stranger.frames)).not.toContain('must never reach');

    // Events the stranger injects are not forwarded to host subscribers.
    const before = events.length;
    stranger.send({
      v: OMP_BRIDGE_PROTOCOL_VERSION,
      t: 'event',
      event: { k: 'text', seq: 99, text: 'injected from an unauthenticated peer' },
    });
    await waitFor(() => events.length > before, 'the unauthenticated-event error');
    expect(events.filter((event) => event.k === 'text')).toHaveLength(0);
    expect(calls).toBe(0);
    expect(handle.pendingRpcs).toBe(0);
  });

  it('refuses a request whose method is not one the host owns', async () => {
    let calls = 0;
    const handle = startBridge({
      rpcHandler: async () => {
        calls += 1;
        return { allow: true };
      },
    });
    const client = await authenticatedClient(handle);

    client.send({
      v: OMP_BRIDGE_PROTOCOL_VERSION,
      t: 'rpc',
      id: 'wire-4',
      method: 'run_shell',
      params: { sessionId: handle.sessionId, runEpoch: handle.runEpoch, command: 'rm -rf /' },
    });
    await waitFor(
      () =>
        events.some((event) => event.k === 'error' && event.code === 'omp_bridge_malformed_frame'),
      'the malformed-frame error',
    );
    expect(calls).toBe(0);
    expect(handle.pendingRpcs).toBe(0);
  });

  it('stays unauthenticated when the acknowledgement names another run', async () => {
    const handle = startBridge();
    const held: net.Socket[] = [];
    const impostor = net.createServer((socket) => {
      held.push(socket);
      socket.once('data', () => {
        socket.write(
          `${JSON.stringify({
            v: OMP_BRIDGE_PROTOCOL_VERSION,
            t: 'ack',
            sessionId: 'someone-elses-session',
            runEpoch: 99,
          })}\n`,
        );
      });
      socket.on('error', () => undefined);
    });
    // The bridge speaks the same local transport in production, so the impostor
    // listens on that kind of endpoint rather than a TCP port.
    const impostorEndpoint =
      process.platform === 'win32'
        ? String.raw`\\.\pipe\omp-bridge-impostor-${randomBytes(6).toString('hex')}`
        : path.join(socketDir, `impostor-${randomBytes(6).toString('hex')}.sock`);
    await new Promise<void>((resolve) => impostor.listen(impostorEndpoint, resolve));

    const pi = new FakePi();
    Object.assign(process.env, handle.childEnv, {
      [OMP_BRIDGE_ENV.socket]: impostorEndpoint,
      [OMP_BRIDGE_ENV.connectAttempts]: '1',
      [OMP_BRIDGE_ENV.connectRetryMs]: '1',
    });
    ompBridgeExtension(pi as unknown as never);
    await waitFor(
      () => pi.logs.some((entry) => entry.level === 'warn'),
      'the mismatched acknowledgement to be refused',
    );

    const gate = await pi.emit('tool_call', {
      toolName: 'write',
      toolCallId: 'call-1',
      input: { path: 'a.ts' },
    });
    expect(gate).toMatchObject({ block: true, reason: expect.stringContaining('not connected') });
    // The extension keeps its half of the pipe open, so the server would wait
    // on it forever; the sockets are destroyed before it is closed.
    for (const socket of held) socket.destroy();
    await new Promise<void>((resolve) => impostor.close(() => resolve()));
  });

  // ── Malformed, oversized and stale frames ───────────────────

  it('drops a malformed frame and keeps serving the connection', async () => {
    const handle = startBridge();
    const client = await openRawClient(handle.endpoint);
    rawClients.push(client);

    client.sendRaw('{"v":1,"t":"hello",oops\n');
    await waitFor(
      () =>
        events.some((event) => event.k === 'error' && event.code === 'omp_bridge_malformed_frame'),
      'the malformed-frame error',
    );

    client.send({ ...HELLO, sessionId: 'session-1', runEpoch: 7, nonce: handle.nonce });
    const ack = await client.waitFor((frame) => frame['t'] === 'ack');
    expect(ack['sessionId']).toBe('session-1');
  });

  it('drops an oversized frame and resynchronizes on the next one', async () => {
    const handle = startBridge();
    const client = await openRawClient(handle.endpoint);
    rawClients.push(client);

    client.sendRaw(
      `${JSON.stringify({ v: 1, t: 'event', event: { k: 'text', seq: 1, text: 'x'.repeat(300 * 1024) } })}\n`,
    );
    await waitFor(
      () =>
        events.some((event) => event.k === 'error' && event.code === 'omp_bridge_frame_too_large'),
      'the oversized-frame error',
    );

    client.send({ ...HELLO, sessionId: 'session-1', runEpoch: 7, nonce: handle.nonce });
    await client.waitFor((frame) => frame['t'] === 'ack');
    expect(events.filter((event) => event.k === 'text')).toHaveLength(0);
  });

  it('refuses a request carrying a stale run identity', async () => {
    let calls = 0;
    const handle = startBridge({
      rpcHandler: async () => {
        calls += 1;
        return { allow: true };
      },
    });
    const client = await authenticatedClient(handle);

    client.send({
      v: OMP_BRIDGE_PROTOCOL_VERSION,
      t: 'rpc',
      id: 'stale-1',
      method: 'authorize_tool',
      params: {
        sessionId: 'session-1',
        runEpoch: 3,
        toolCallId: 'call-1',
        toolName: 'write',
        input: {},
      },
    });
    await waitFor(
      () =>
        events.some(
          (event) => event.k === 'error' && event.code === 'omp_bridge_stale_run_identity',
        ),
      'the stale-identity error',
    );
    expect(calls).toBe(0);
  });

  // ── Lifecycle ───────────────────────────────────────────────

  it('rejects every outstanding call when the bridge is disposed', async () => {
    const handle = startBridge({ rpcHandler: async () => new Promise(() => {}) });
    const pi = await startExtension(handle);
    await handle.ready;

    const gate = pi.emit('tool_call', {
      toolName: 'write',
      toolCallId: 'call-1',
      input: { path: 'a.ts' },
    });
    await waitFor(() => handle.pendingRpcs === 1, 'the pending authorization');

    await handle.dispose();
    await expect(gate).resolves.toMatchObject({
      block: true,
      reason: expect.stringContaining('omp_bridge_disconnected'),
    });
    expect(handle.pendingRpcs).toBe(0);
  });

  // A real deadline on purpose: this is the timeout the gate is supposed to
  // fail closed on, so the fake clock would test nothing.
  it('blocks the call when the host never answers in time', async () => {
    const handle = startBridge({
      rpcTimeoutMs: 60,
      rpcHandler: async () => new Promise(() => {}),
    });
    const pi = await startExtension(handle);
    await handle.ready;

    const gate = await pi.emit('tool_call', {
      toolName: 'write',
      toolCallId: 'call-1',
      input: { path: 'a.ts' },
    });
    expect(gate).toMatchObject({
      block: true,
      reason: expect.stringContaining('omp_bridge_rpc_timeout'),
    });
  });

  it('blocks the call closed when no bridge is configured at all', async () => {
    const pi = new FakePi();
    process.env[OMP_BRIDGE_ENV.connectAttempts] = '1';
    process.env[OMP_BRIDGE_ENV.connectRetryMs] = '1';
    ompBridgeExtension(pi as unknown as never);
    await waitFor(
      () => pi.logs.some((entry) => entry.level === 'error'),
      'the connect failure to be reported',
    );

    const gate = await pi.emit('tool_call', {
      toolName: 'write',
      toolCallId: 'call-1',
      input: { path: 'a.ts' },
    });
    expect(gate).toMatchObject({ block: true });
  });

  it('keeps the user process alive when the bridge drops mid-run', async () => {
    const handle = startBridge();
    const pi = await startExtension(handle);
    await handle.ready;
    await handle.dispose();

    // Settles only once the client has actually observed the closed socket.
    await expect(
      pi.emit('tool_call', { toolName: 'write', toolCallId: 'c1', input: {} }),
    ).resolves.toMatchObject({ block: true });

    await expect(
      pi.emit('message_update', {
        type: 'message_update',
        message: { role: 'assistant' },
        assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'still talking' },
      }),
    ).resolves.toBeUndefined();
    expect(pi.logs.some((entry) => entry.level === 'error')).toBe(true);
  });

  // ── Tool gating ─────────────────────────────────────────────

  it('authorizes every native tool call with its exact identity', async () => {
    const seen: OmpBridgeRpcRequest[] = [];
    const handle = startBridge({
      rpcHandler: async (request) => {
        seen.push(request);
        return { allow: true, input: { path: 'narrowed.ts' } };
      },
    });
    const pi = await startExtension(handle);
    await handle.ready;

    const gate = await pi.emit('tool_call', {
      toolName: 'write',
      toolCallId: 'call-42',
      input: { path: 'wide.ts', content: 'x' },
    });
    expect(gate).toEqual({ input: { path: 'narrowed.ts' } });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      method: 'authorize_tool',
      toolName: 'write',
      toolCallId: 'call-42',
      input: { path: 'wide.ts', content: 'x' },
      sessionId: 'session-1',
      runEpoch: 7,
    });
  });

  it('treats an unknown authorization answer as a refusal', async () => {
    const handle = startBridge({ rpcHandler: async () => 'yes please' });
    const pi = await startExtension(handle);
    await handle.ready;

    const gate = await pi.emit('tool_call', { toolName: 'write', toolCallId: 'c', input: {} });
    expect(gate).toMatchObject({ block: true });
  });

  it('does not double-gate the company tools that ask the host anyway', async () => {
    const seen: string[] = [];
    const handle = startBridge({
      rpcHandler: async (request) => {
        seen.push(request.method);
        return { accepted: true };
      },
    });
    const pi = await startExtension(handle);
    await handle.ready;

    expect(pi.tools.get('company_task_result')).toBeDefined();
    await pi.emit('tool_call', {
      toolName: 'company_task_result',
      toolCallId: 'call-1',
      input: { payload: {} },
    });
    expect(seen).toEqual([]);
  });

  it('asks the host before a native subagent spawn and blocks a refusal', async () => {
    const seen: OmpBridgeRpcRequest[] = [];
    const handle = startBridge({
      rpcHandler: async (request) => {
        seen.push(request);
        return { allow: false, reason: 'no model lease free' };
      },
    });
    const pi = await startExtension(handle);
    await handle.ready;

    const result = await pi.emit('before_subagent_spawn', {
      type: 'before_subagent_spawn',
      agent: 'explore',
      invocationKind: 'task',
      modelRole: 'task',
      patterns: ['openrouter/stealth/space-bunny-alpha:max'],
    });
    expect(result).toMatchObject({
      block: true,
      reason: expect.stringContaining('no model lease free'),
    });
    expect(seen[0]).toMatchObject({
      method: 'authorize_subagent',
      agent: 'explore',
      invocationKind: 'task',
      sessionId: 'session-1',
      runEpoch: 7,
    });
  });

  // ── Company tool registration ───────────────────────────────

  it('registers every company tool the plan gives the bridge', async () => {
    const handle = startBridge();
    const pi = await startExtension(handle);
    await handle.ready;

    expect([...pi.tools.keys()].sort()).toEqual([
      'ask',
      'company_architecture_review',
      'company_ask_user',
      'company_judge_result',
      'company_qa_result',
      'company_report',
      'company_submit_contract',
      'company_task_result',
      'company_verify',
    ]);
  });

  it('offers each company tool to the role that owns it', async () => {
    expect(COMPANY_BRIDGE_TOOL_ROLES).toEqual({
      company_submit_contract: 'director',
      company_architecture_review: 'advisor',
      company_task_result: 'worker',
      company_qa_result: 'qa',
      company_verify: 'qa',
      company_judge_result: 'judge',
      company_report: 'judge',
      company_ask_user: '*',
    });

    for (const [tool, owner] of Object.entries(COMPANY_BRIDGE_TOOL_ROLES)) {
      const handle = startBridge({ role: owner === '*' ? 'worker' : owner });
      const pi = await startExtension(handle, handle.role);
      await handle.ready;
      const definition = pi.tools.get(tool);
      expect(definition, `${tool} must be registered`).toBeDefined();
      await handle.dispose();
      bridge = undefined;
    }
  });

  it('authorizes a QA verifier RPC the host registry would otherwise refuse', async () => {
    const requests: OmpBridgeRpcRequest[] = [];
    const handle = startBridge({
      role: 'qa',
      rpcHandler: async (request) => {
        requests.push(request);
        return { status: 'passed', evidenceId: 'evidence-1' };
      },
    });
    const pi = await startExtension(handle, 'qa');
    await handle.ready;

    const result = await pi.tools
      .get('company_verify')!
      .execute(
        'call-verify',
        { payload: { taskId: 'task-1', attemptId: 'attempt-1', commandId: 'cmd-1' } },
        undefined,
        undefined,
        makeContext(),
      );

    // The answer names the evidence, so the host answered rather than the host
    // role gate refusing a tool its own QA brief promises.
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('evidence-1');
    expect(requests).toEqual([
      {
        id: expect.any(String),
        method: 'company_tool',
        toolCallId: 'call-verify',
        toolName: 'company_verify',
        role: 'qa',
        sessionId: 'session-1',
        runEpoch: 7,
        payload: { taskId: 'task-1', attemptId: 'attempt-1', commandId: 'cmd-1' },
      },
    ]);
  });

  // ── Native ask ⇄ durable Question ───────────────────────────

  /** What a delegated native `ask` resolves with. */
  interface NativeAskResult {
    content?: { type: 'text'; text: string }[];
    details?: Record<string, unknown>;
  }

  /** What a case can observe and drive on a delegation. */
  interface NativeAskProbe {
    params?: Record<string, unknown>;
    signal?: AbortSignal;
    /** Answer the dialog the way a keystroke would. */
    answer(result: NativeAskResult): void;
  }

  /** A delegation standing in for the native ask, and the context carrying it. */
  interface NativeAskFixture {
    readonly probe: NativeAskProbe;
    readonly context: FakeContext;
  }

  /**
   * A delegation that behaves like the native ask: it waits for the user, and
   * rejects when the wrapper closes the dialog it opened. Nothing here renders
   * a keyboard — what is under test is that the wrapper drives a real
   * delegated call rather than a dialog of its own.
   */
  function nativeAskFixture(): NativeAskFixture {
    const dialog = deferred<NativeAskResult>();
    const probe: NativeAskProbe = {
      answer: (result) => dialog.resolve(result),
    };
    return {
      probe,
      context: makeContext({
        invokeTool: (params, options) => {
          probe.params = params;
          probe.signal = options?.signal;
          options?.signal?.addEventListener('abort', () =>
            dialog.reject(new Error('ToolAbortError')),
          );
          return dialog.promise;
        },
      }),
    };
  }

  it('publishes a durable question before the native dialog opens', async () => {
    const requests: OmpBridgeRpcRequest[] = [];
    const handle = startBridge({
      rpcHandler: async (request) => {
        requests.push(request);
        return { questionId: 'question-1' };
      },
    });
    const pi = await startExtension(handle);
    await handle.ready;
    const { probe, context } = nativeAskFixture();

    const call = pi.tools.get('ask')!.execute('call-ask', ASK_CALL, undefined, undefined, context);
    await waitFor(() => probe.params !== undefined, 'the native dialog');

    // The durable record exists before a dialog can, so a board answer always
    // has a question to attach to — and the dialog receives the real arguments.
    expect(requests[0]).toMatchObject({
      method: 'publish_question',
      toolCallId: 'call-ask',
      questions: [
        {
          id: 'q1',
          question: 'Which database should the service use?',
          options: [
            { label: 'PostgreSQL', description: 'already provisioned' },
            { label: 'SQLite' },
          ],
        },
      ],
    });
    expect(probe.params).toEqual(ASK_CALL);
    expect(probe.signal?.aborted).toBe(false);

    // Nothing in this case answers it; only a cancellation closes the dialog.
    await handle.cancelQuestion({ questionId: 'question-1', code: 'test_teardown' });
    await waitFor(() => probe.signal?.aborted === true, 'the cancelled dialog');
    await call;
  });

  it('answers from the board and closes the native dialog with that same answer', async () => {
    const requests: OmpBridgeRpcRequest[] = [];
    const handle = startBridge({
      rpcHandler: async (request) => {
        requests.push(request);
        return { questionId: 'question-2' };
      },
    });
    const pi = await startExtension(handle);
    await handle.ready;
    const { probe, context } = nativeAskFixture();

    // Started, not awaited: the tool is waiting for exactly what comes next.
    const call = pi.tools
      .get('ask')!
      .execute('call-ask-2', ASK_CALL, undefined, undefined, context);
    await waitFor(() => probe.signal !== undefined, 'the native dialog');

    await handle.answerQuestion({
      questionId: 'question-2',
      answer: { selectedOptions: ['SQLite'], multi: false },
    });

    const result = await call;

    // The dialog is cancelled — never answered with something else — and the
    // model reads exactly what the user chose, and where they chose it.
    await waitFor(() => probe.signal?.aborted === true, 'the cancelled dialog');
    expect(result.content[0].text).toContain('SQLite');
    expect(result.content[0].text).toContain('board');
    // The host already persisted this answer, so nothing answers it twice.
    expect(requests.filter((request) => request.method === 'answer_question')).toHaveLength(0);
  });

  it('records a terminal answer against the same durable question', async () => {
    const requests: OmpBridgeRpcRequest[] = [];
    const handle = startBridge({
      rpcHandler: async (request) => {
        requests.push(request);
        return request.method === 'publish_question'
          ? { questionId: 'question-3' }
          : { status: 'recorded' };
      },
    });
    const pi = await startExtension(handle);
    await handle.ready;
    const { probe, context } = nativeAskFixture();
    probe.answer(nativeAskResult('PostgreSQL'));

    const result = await pi.tools
      .get('ask')!
      .execute('call-ask-3', ASK_CALL, undefined, undefined, context);

    expect(requests.find((request) => request.method === 'answer_question')).toMatchObject({
      method: 'answer_question',
      toolCallId: 'call-ask-3',
      questionId: 'question-3',
      answer: { selectedOptions: ['PostgreSQL'], multi: false },
    });
    // The native tool's own text is what the model reads.
    expect(result.content[0].text).toBe('The user selected PostgreSQL.');
  });

  it('gives the model the recorded board answer when the board already won', async () => {
    const handle = startBridge({
      rpcHandler: async (request) => {
        if (request.method === 'publish_question') return { questionId: 'question-4' };
        // The durable record already holds a board answer that differs from the
        // one the terminal produced a moment later.
        return {
          status: 'already_resolved',
          answer: { selectedOptions: ['SQLite'], multi: false },
        };
      },
    });
    const pi = await startExtension(handle);
    await handle.ready;
    const { probe, context } = nativeAskFixture();
    probe.answer(nativeAskResult('PostgreSQL'));

    const result = await pi.tools
      .get('ask')!
      .execute('call-ask-4', ASK_CALL, undefined, undefined, context);

    // First answer wins: the model acts on the recorded one, not the later one.
    expect(result.content[0].text).toContain('SQLite');
    expect(result.content[0].text).not.toContain('PostgreSQL');
  });

  it('withdraws a cancelled question instead of reading it as an answer', async () => {
    const requests: OmpBridgeRpcRequest[] = [];
    const handle = startBridge({
      rpcHandler: async (request) => {
        requests.push(request);
        return { questionId: 'question-5' };
      },
    });
    const pi = await startExtension(handle);
    await handle.ready;
    const { probe, context } = nativeAskFixture();
    probe.answer({
      content: [{ type: 'text', text: '' }],
      details: { results: [], cancelled: true },
    });

    const result = await pi.tools
      .get('ask')!
      .execute('call-ask-5', ASK_CALL, undefined, undefined, context);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/cancelled/i);
    // The durable question is withdrawn — not left pending forever, and not
    // answered with whatever the dialog defaulted to.
    expect(requests.find((request) => request.method === 'cancel_question')).toMatchObject({
      questionId: 'question-5',
      code: 'omp_native_ask_cancelled',
    });
    expect(requests.filter((request) => request.method === 'answer_question')).toHaveLength(0);
  });

  it('refuses the ask outright when the session exposes no native ask', async () => {
    const requests: OmpBridgeRpcRequest[] = [];
    const handle = startBridge({
      rpcHandler: async (request) => {
        requests.push(request);
        return { questionId: 'question-6' };
      },
    });
    const pi = await startExtension(handle);
    await handle.ready;

    // No delegation means no native ask behind this name. Answering anyway
    // would be a keyboard the user cannot actually press.
    const result = await pi.tools
      .get('ask')!
      .execute('call-ask-6', ASK_CALL, undefined, undefined, makeContext());

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/no native ask tool/i);
    expect(requests).toHaveLength(0);
  });

  it('refuses a question or answer that does not have the shape a record needs', async () => {
    // No extension here: the raw authenticated client is the peer, which is how
    // the frame the host writes is observed directly.
    const handle = startBridge();
    const client = await authenticatedClient(handle);

    // An answer that selected nothing and typed nothing is not a decision.
    await expect(
      handle.answerQuestion({
        questionId: 'question-7',
        answer: { selectedOptions: [], multi: false },
      }),
    ).rejects.toMatchObject({ code: 'omp_bridge_question_malformed' });
    // A restart mints a new epoch, so the answer that run was waiting on is no
    // longer answerable here.
    await expect(
      handle.answerQuestion({
        questionId: 'question-7',
        answer: { selectedOptions: ['SQLite'], multi: false },
        runEpoch: 6,
      }),
    ).rejects.toMatchObject({ code: 'omp_bridge_stale_run_identity' });

    // A cancellation travels as its own frame and carries no answer at all.
    await handle.cancelQuestion({ questionId: 'question-7', code: 'user_closed' });
    const frame = await client.waitFor((candidate) => candidate['t'] === 'question_cancel');
    expect(frame).toMatchObject({
      sessionId: 'session-1',
      runEpoch: 7,
      questionId: 'question-7',
      code: 'user_closed',
    });
    expect(frame['answer']).toBeUndefined();

    // An accepted board answer names the question and the answer, and nothing else.
    await handle.answerQuestion({
      questionId: 'question-7',
      answer: { selectedOptions: ['SQLite'], customInput: 'in a temp dir', multi: false },
    });
    const answer = await client.waitFor((candidate) => candidate['t'] === 'question_result');
    expect(answer).toMatchObject({
      sessionId: 'session-1',
      runEpoch: 7,
      questionId: 'question-7',
      answer: { selectedOptions: ['SQLite'], customInput: 'in a temp dir', multi: false },
    });
  });

  it('lets a role reach only its own company tools', async () => {
    const requests: OmpBridgeRpcRequest[] = [];
    const handle = startBridge({
      rpcHandler: async (request) => {
        requests.push(request);
        return { accepted: true, contractId: 'contract-1' };
      },
    });
    const pi = await startExtension(handle, 'worker');
    await handle.ready;

    const own = pi.tools.get('company_task_result');
    const foreign = pi.tools.get('company_judge_result');
    expect(own).toBeDefined();
    expect(foreign).toBeDefined();

    const ok = await own!.execute(
      'call-1',
      { payload: { taskId: 'task-1' } },
      undefined,
      undefined,
      makeContext(),
    );
    expect(ok.isError).toBeUndefined();
    expect(ok.content[0].text).toContain('contract-1');

    const denied = await foreign!.execute(
      'call-2',
      { payload: {} },
      undefined,
      undefined,
      makeContext(),
    );
    expect(denied.isError).toBe(true);
    expect(denied.content[0].text).toMatch(/judge/i);

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      method: 'company_tool',
      toolName: 'company_task_result',
      toolCallId: 'call-1',
      role: 'worker',
      payload: { taskId: 'task-1' },
    });
  });

  it('refuses a company tool issued from a native subagent', async () => {
    let calls = 0;
    const handle = startBridge({
      rpcHandler: async () => {
        calls += 1;
        return { accepted: true };
      },
    });
    const pi = await startExtension(handle, 'qa');
    await handle.ready;

    const subContext = makeContext({
      agent: { kind: 'sub', id: '0-explore', name: 'explore', depth: 1, parentId: 'Main' },
    });
    const result = await pi.tools
      .get('company_qa_result')!
      .execute('call-1', { payload: {} }, undefined, undefined, subContext);

    expect(result.isError).toBe(true);
    expect(calls).toBe(0);
  });

  it('reports a company tool failure to the model instead of throwing', async () => {
    const handle = startBridge({
      rpcHandler: async () => {
        throw new OmpBridgeRpcError('omp_bridge_unknown_task', 'task PA-T0009 is not assigned');
      },
    });
    const pi = await startExtension(handle, 'worker');
    await handle.ready;

    const result = await pi.tools
      .get('company_task_result')!
      .execute('call-1', { payload: {} }, undefined, undefined, makeContext());
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('task PA-T0009 is not assigned');
  });

  // ── Events ──────────────────────────────────────────────────

  it('streams ordered text, tool, session and usage events', async () => {
    const handle = startBridge();
    const pi = await startExtension(handle, 'worker');
    await handle.ready;
    const ctx = makeContext();

    await pi.emit('session_start', { type: 'session_start' }, ctx);
    for (const delta of ['Building ', 'the ', 'thing']) {
      await pi.emit(
        'message_update',
        {
          type: 'message_update',
          message: { role: 'assistant' },
          assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta },
        },
        ctx,
      );
    }
    await pi.emit('message_end', { type: 'message_end', message: { role: 'assistant' } }, ctx);
    await pi.emit(
      'message_end',
      {
        type: 'message_end',
        message: {
          role: 'assistant',
          model: 'gpt-6-luna',
          provider: 'openai-codex',
          responseId: 'resp-9',
          usage: {
            input: 10,
            output: 20,
            cacheRead: 30,
            cacheWrite: 40,
            totalTokens: 100,
            contextTokens: 55,
            cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3 },
          },
        },
      },
      ctx,
    );
    await pi.emit(
      'tool_execution_start',
      { type: 'tool_execution_start', toolCallId: 'c1', toolName: 'write', args: {} },
      ctx,
    );
    await pi.emit(
      'tool_execution_end',
      {
        type: 'tool_execution_end',
        toolCallId: 'c1',
        toolName: 'write',
        result: {},
        isError: false,
      },
      ctx,
    );
    await pi.emit('agent_end', { type: 'agent_end', messages: [] }, ctx);
    await pi.emit('session_shutdown', { type: 'session_shutdown' }, ctx);

    await waitFor(
      () => events.some((event) => event.k === 'session' && event.phase === 'shutdown'),
      'the session_shutdown event',
    );

    const texts = events.filter((event) => event.k === 'text').map(asText);
    expect(texts.map((frame) => frame.text).join('')).toBe('Building the thing');
    expect(texts.every((frame) => Buffer.byteLength(frame.text) <= 16 * 1024)).toBe(true);
    expect(texts.map((frame) => frame.seq)).toEqual(
      [...texts.map((frame) => frame.seq)].sort((a, b) => a - b),
    );

    expect(events.filter((event) => event.k === 'tool')).toEqual([
      { k: 'tool', phase: 'start', toolCallId: 'c1', toolName: 'write' },
      { k: 'tool', phase: 'end', toolCallId: 'c1', toolName: 'write', isError: false },
    ]);

    expect(events.find((event) => event.k === 'usage')).toMatchObject({
      k: 'usage',
      model: 'gpt-6-luna',
      provider: 'openai-codex',
      nativeSessionId: 'native-session-1',
      responseId: 'resp-9',
      input: 10,
      output: 20,
      cacheRead: 30,
      cacheWrite: 40,
      totalTokens: 100,
      contextTokens: 55,
      costUsd: 3,
    });

    expect(events.filter((event) => event.k === 'quiescent')).toEqual([
      { k: 'quiescent', idle: true },
    ]);
  });

  it('reports a busy session as not quiescent while a native job runs', async () => {
    const handle = startBridge();
    const pi = await startExtension(handle);
    await handle.ready;

    await pi.emit(
      'agent_end',
      { type: 'agent_end', messages: [] },
      makeContext({
        isIdle: () => false,
        getAsyncJobSnapshot: () => ({ running: [{ id: 'job-1' }], recent: [], delivery: {} }),
      }),
    );
    await waitFor(() => events.some((event) => event.k === 'quiescent'), 'the quiescent report');
    expect(events.find((event) => event.k === 'quiescent')).toEqual({
      k: 'quiescent',
      idle: false,
    });
  });

  it('bounds one streamed delta into several ordered frames', async () => {
    const handle = startBridge();
    const pi = await startExtension(handle);
    await handle.ready;

    await pi.emit('message_update', {
      type: 'message_update',
      message: { role: 'assistant' },
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'a'.repeat(40 * 1024) },
    });
    await pi.emit('message_end', { type: 'message_end', message: { role: 'assistant' } });

    await waitFor(
      () => events.filter((event) => event.k === 'text').length >= 3,
      'the bounded text frames',
    );
    const texts = events.filter((event) => event.k === 'text').map(asText);
    expect(texts.every((frame) => Buffer.byteLength(frame.text) <= 16 * 1024)).toBe(true);
    expect(texts.map((frame) => frame.text).join('')).toBe('a'.repeat(40 * 1024));
  });
  it('aborts the active native generation only through its authenticated context', async () => {
    const handle = startBridge();
    const pi = await startExtension(handle);
    let abortCalls = 0;
    const context = makeContext({ abort: () => (abortCalls += 1) });

    await pi.emit(
      'message_update',
      {
        type: 'message_update',
        message: { role: 'assistant' },
        assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'working' },
      },
      context,
    );

    await (handle as unknown as { abort(): Promise<void> }).abort();

    expect(abortCalls).toBe(1);
  });

  it('refuses to acknowledge abort when no native generation is active', async () => {
    const handle = startBridge();
    await startExtension(handle);

    await expect((handle as unknown as { abort(): Promise<void> }).abort()).rejects.toMatchObject({
      code: 'omp_bridge_abort_failed',
    });
  });
});

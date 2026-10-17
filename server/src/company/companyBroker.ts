/**
 * companyBroker: the owner half of a follower's command channel.
 *
 * `CompanyOwnership` gives one process the owner role for a workspace. Every
 * other surface on that workspace is a follower, and a follower cannot schedule
 * work or write state — it proxies commands to the owner instead. This module
 * is the channel that makes that proxy possible, and it is deliberately a
 * reusable primitive: a server binds one explicitly supplied endpoint with one
 * instance nonce and dispatches JSON requests to one async handler; a client
 * takes an endpoint, a nonce and a request and awaits the correlated result.
 *
 * The wire is newline-delimited JSON over a Windows named pipe or an
 * owner-only Unix socket. There is no TCP, no HTTP, no port and no host: there
 * is nothing here a browser on the network can reach, and an endpoint that
 * looks like a network address is refused rather than resolved.
 *
 * Rules that shape the implementation:
 *
 *  - **The nonce authenticates the peer, never the user.** It proves one
 *    process holds the instance's secret; it says nothing about which UI client
 *    issued a command, whether that client was privileged, or whether the
 *    command is legal for the current Contract revision. The handler receives
 *    untrusted JSON and MUST re-validate the command and the originating
 *    client's privilege before acting — see `CompanyBrokerHandler`.
 *  - **Mutual authentication.** Both halves present the nonce and both check
 *    the other's, so an impostor listening on the endpoint path cannot learn
 *    the nonce or receive a command the real owner would have executed.
 *  - **No replay after an uncertain outcome.** A client connects once, sends
 *    one request and waits. A dropped connection, a timeout or a refused
 *    handshake rejects with a code; nothing is retried and nothing is re-sent,
 *    because the owner may already have applied the side effect. Callers that
 *    need exactly-once company mutations persist their request id rather than
 *    relying on a second delivery.
 *  - **Bounded frames.** One frame is at most the company prompt limit plus a
 *    fixed framing allowance. An oversized or malformed frame costs exactly
 *    that frame; the reader resynchronizes on the next newline. A payload the
 *    cap cannot carry is refused, never truncated — a prompt at the intake
 *    limit belongs in an artifact the broker references by id.
 *  - **Diagnostics carry codes, not content.** `onEvent` reports a static code
 *    and a connection counter, and no error message contains a nonce, an
 *    endpoint, a command, a parameter or a handler's own text. Host-internal
 *    detail stays in the owner process, the only process entitled to log it.
 *
 * The broker is not a sandbox. It authenticates processes inside one user
 * account; it does not stop a process that already reads the owner's files.
 */

import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import { CompanyError } from './companyError.js';
import { COMPANY_MAX_PROMPT_BYTES } from './constants.js';

/** Wire version; both halves refuse a peer that speaks another one. */
export const COMPANY_BROKER_PROTOCOL_VERSION = 1 as const;

/**
 * Framing allowance added to the prompt limit: JSON quoting, the envelope and
 * an id. Worst-case escape expansion can exceed it, and such a payload is
 * refused rather than truncated.
 */
export const COMPANY_BROKER_FRAME_OVERHEAD_BYTES = 64 * 1024;

/** One frame, on the wire, may not exceed this. */
export const COMPANY_BROKER_MAX_FRAME_BYTES =
  COMPANY_MAX_PROMPT_BYTES + COMPANY_BROKER_FRAME_OVERHEAD_BYTES;

/** Correlated requests one broker may have in flight. */
export const COMPANY_BROKER_MAX_PENDING_REQUESTS = 128;

/** Peers connected to one broker at once. */
export const COMPANY_BROKER_MAX_CONNECTIONS = 8;

/** Bounds on peer-supplied identifiers, checked before anything else. */
export const COMPANY_BROKER_MAX_REQUEST_ID_LENGTH = 128;
export const COMPANY_BROKER_MAX_COMMAND_LENGTH = 128;

/** A shorter nonce is a configuration mistake, not a secret. */
export const COMPANY_BROKER_MIN_NONCE_LENGTH = 16;

/** Deadline for reaching a peer and completing its handshake. */
export const COMPANY_BROKER_DEFAULT_CONNECT_TIMEOUT_MS = 5_000;

/** Deadline for one correlated request. */
export const COMPANY_BROKER_DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Diagnostics vocabulary. These strings, and nothing else, ever reach an
 * observer: the peer counter is a number this process assigns.
 */
export const COMPANY_BROKER_EVENT_CODES = [
  'connection_opened',
  'connection_closed',
  'peer_refused',
  'duplicate_identity',
  'frame_malformed',
  'frame_too_large',
  'frame_unknown_type',
  'version_mismatch',
  'unauthenticated_request',
  'duplicate_request_id',
  'too_many_requests',
  'too_many_connections',
  'request_completed',
  'request_rejected',
  'server_error',
  'disposed',
] as const;

export type CompanyBrokerEventCode = (typeof COMPANY_BROKER_EVENT_CODES)[number];

/**
 * A broker diagnostic. It names a condition and a peer counter — never a
 * nonce, an endpoint, a command, a parameter or a free-text message.
 */
export interface CompanyBrokerEvent {
  readonly code: CompanyBrokerEventCode;
  readonly peer: number;
}

/** Static sentences. Error messages are looked up here, never composed. */
const ERROR_TEXT: Record<string, string> = {
  disposed: 'The company broker is closed.',
  duplicate_identity: 'The connection already presented its identity.',
  endpoint_not_local: 'A company broker endpoint must be a local pipe or socket path.',
  endpoint_not_private: 'The company broker socket is not owner-only.',
  frame_malformed: 'The frame is not a well-formed broker request.',
  frame_too_large: 'The frame exceeds the company broker frame limit.',
  handler_failed: 'The company broker handler failed.',
  idempotent_busy: 'Another request with that id is still running.',
  invalid_handler: 'A company broker needs a request handler.',
  invalid_nonce: 'A company broker needs an instance nonce of at least 16 characters.',
  no_result: 'The company broker received no result for that request.',
  server_closed: 'The company broker closed before the request was answered.',
  socket_dir_missing: 'A POSIX company broker needs an existing socket directory.',
  timeout: 'The company broker request timed out.',
  too_many_connections: 'The company broker has no free peer slot.',
  too_many_requests: 'The company broker has too many requests in flight.',
  unauthorized: 'The company broker refused the identity presented.',
  unavailable: 'The company broker is not reachable.',
};

/** A correlated command, exactly as it arrives from an authenticated peer. */
export interface CompanyBrokerRequest {
  readonly requestId: string;
  readonly command: string;
  readonly params?: unknown;
}

/**
 * The owner's dispatcher.
 *
 * `request` is UNTRUSTED input. Authentication proves only that the process
 * presenting the instance nonce is speaking; it does not prove which client
 * asked, whether that client holds `privileged`, or whether the command is
 * still valid for the current Contract revision. A handler MUST therefore
 * validate the command name against its own vocabulary and re-check the
 * originating client's privilege from the proxied request context before it
 * changes any state, and MUST treat `params` as unparsed data.
 *
 * A returned value is serialized as the result. A thrown `CompanyError`
 * becomes an error answer carrying that code with a static sentence; any other
 * throw becomes `company_broker_handler_failed`. Handler text is never echoed
 * back over the pipe, so a message that happened to contain a prompt or a file
 * body stays inside the owner process.
 */
export type CompanyBrokerHandler = (request: CompanyBrokerRequest) => Promise<unknown> | unknown;

export interface CompanyBrokerServerOptions {
  /** Named pipe (Windows) or socket path (POSIX), supplied by the caller. */
  readonly endpoint: string;
  /** The owner's instance nonce, from the ownership descriptor. */
  readonly nonce: string;
  readonly onRequest: CompanyBrokerHandler;
  /** Static-code diagnostics; the default sink discards them. */
  readonly onEvent?: (event: CompanyBrokerEvent) => void;
  readonly maxPendingRequests?: number;
  readonly maxConnections?: number;
}

export interface CompanyBrokerHandle {
  readonly endpoint: string;
  /** Peers connected right now. */
  readonly connections: number;
  /** Requests dispatched and not yet answered. */
  readonly pendingRequests: number;
  readonly disposed: boolean;
  /** Stop listening, drop every peer, remove the socket file. */
  dispose(): Promise<void>;
}

/** One request issued by a follower, or by any other local peer. */
export interface CompanyBrokerClientInput {
  readonly endpoint: string;
  readonly nonce: string;
  readonly command: string;
  readonly params?: unknown;
  /** Minted when omitted; always reported back so a caller can dedupe. */
  readonly requestId?: string;
  readonly connectTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
}

export interface CompanyBrokerClientResult {
  readonly requestId: string;
  readonly value: unknown;
}

// ── Shared guards ─────────────────────────────────────────────

function isFrameObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Non-empty, length-bounded string: the only shape accepted for ids. */
function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}

/** Constant-time compare that tolerates a length mismatch. */
function secretsMatch(expected: string, presented: unknown): boolean {
  if (typeof presented !== 'string' || presented.length === 0) return false;
  const expectedBytes = Buffer.from(expected, 'utf8');
  const presentedBytes = Buffer.from(presented, 'utf8');
  if (expectedBytes.length !== presentedBytes.length) return false;
  return timingSafeEqual(expectedBytes, presentedBytes);
}

function brokerError(key: string, cause?: unknown): CompanyError {
  return new CompanyError(`company_broker_${key}`, ERROR_TEXT[key], { cause });
}

/**
 * A handler's own `CompanyError` code reaches the caller, because the follower's
 * UI has to report WHY the command was refused. Anything else — a TypeError, an
 * fs error, a rejected promise from deep inside — collapses to one opaque code.
 */
function codeOf(error: unknown): string {
  if (error instanceof CompanyError && error.code.startsWith('company_')) return error.code;
  return 'company_broker_handler_failed';
}

/**
 * The endpoint must be a local IPC address. A host:port, a URL or a relative
 * path is refused, so a broker can never end up listening on or dialling a
 * network interface.
 */
export function assertLocalBrokerEndpoint(endpoint: string): void {
  if (!isBoundedString(endpoint, 512) || endpoint.includes('\0')) {
    throw brokerError('endpoint_not_local');
  }
  if (endpoint.includes('://')) throw brokerError('endpoint_not_local');
  if (process.platform === 'win32') {
    if (!endpoint.toLowerCase().startsWith('\\\\.\\pipe\\'))
      throw brokerError('endpoint_not_local');
    return;
  }
  // POSIX: an absolute filesystem path, and never a host:port pair.
  if (!path.isAbsolute(endpoint)) throw brokerError('endpoint_not_local');
  if (/:\d+$/.test(endpoint)) throw brokerError('endpoint_not_local');
}

/**
 * Build the platform-correct endpoint for an owner broker inside a company
 * namespace. The name is derived from a hash of the nonce, so the descriptor a
 * follower reads exposes no secret and a hostile name cannot escape the
 * namespace directory.
 */
export function resolveCompanyBrokerEndpoint(socketDir: string, instanceNonce: string): string {
  const digest = createHash('sha256').update(instanceNonce, 'utf8').digest('hex').slice(0, 32);
  if (process.platform === 'win32') return `\\\\.\\pipe\\pixel-agents-company-owner-${digest}`;
  if (!isBoundedString(socketDir, 512) || !fs.existsSync(socketDir)) {
    throw brokerError('socket_dir_missing');
  }
  return path.join(socketDir, `owner-${digest}.sock`);
}

/** POSIX only: the socket stays reachable by its owner and by nobody else. */
function restrictToOwner(endpoint: string): void {
  try {
    fs.chmodSync(endpoint, 0o600);
  } catch (err) {
    throw brokerError('endpoint_not_private', err);
  }
}

/** Remove the socket file a disposed broker left behind; pipes need no cleanup. */
function removeEndpoint(endpoint: string): void {
  if (process.platform === 'win32') return;
  try {
    fs.unlinkSync(endpoint);
  } catch {
    // Never created, or already reclaimed by the owner that replaced us.
  }
}

/**
 * Split a byte stream into newline-delimited frames.
 *
 * A frame above the cap is dropped whole and the reader resynchronizes on the
 * next newline, so one oversized frame costs exactly one frame instead of the
 * channel.
 */
class FrameReader {
  private readonly decoder = new StringDecoder('utf8');
  private buffer = '';
  /** True while discarding the tail of an oversized frame. */
  private discarding = false;

  constructor(
    private readonly onFrame: (frame: unknown) => void,
    private readonly onError: (code: 'frame_malformed' | 'frame_too_large') => void,
  ) {}

  push(chunk: Buffer): void {
    this.buffer += this.decoder.write(chunk);
    let newline = this.buffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      newline = this.buffer.indexOf('\n');
      if (this.discarding) {
        this.discarding = false;
        continue;
      }
      if (line.length === 0) continue;
      // A single write can carry a whole oversized frame, so the cap is charged
      // against the completed line as well as against a partial one.
      if (Buffer.byteLength(line, 'utf8') > COMPANY_BROKER_MAX_FRAME_BYTES) {
        this.onError('frame_too_large');
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        this.onError('frame_malformed');
        continue;
      }
      this.onFrame(parsed);
    }

    // No newline yet: charge the partial frame against the cap so an endless
    // line cannot grow without bound.
    if (Buffer.byteLength(this.buffer, 'utf8') > COMPANY_BROKER_MAX_FRAME_BYTES) {
      this.onError('frame_too_large');
      this.buffer = '';
      this.discarding = true;
    }
  }
}

/** Deferred; `Promise.withResolvers` needs a newer lib than this project targets. */
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

// ── Server ────────────────────────────────────────────────────

/** Live state of one connected, possibly authenticated peer. */
interface Peer {
  readonly id: number;
  readonly socket: net.Socket;
  authenticated: boolean;
}

class CompanyBrokerServer implements CompanyBrokerHandle {
  readonly endpoint: string;

  private readonly server: net.Server;
  private readonly nonce: string;
  private readonly handler: CompanyBrokerHandler;
  private readonly emit: (event: CompanyBrokerEvent) => void;
  private readonly maxPending: number;
  private readonly maxPeers: number;
  private readonly peers = new Map<net.Socket, Peer>();
  private readonly inFlight = new Set<string>();
  private peerCounter = 0;
  private listening = false;
  private closed = false;

  constructor(options: CompanyBrokerServerOptions) {
    assertLocalBrokerEndpoint(options.endpoint);
    if (
      !isBoundedString(options.nonce, 512) ||
      options.nonce.length < COMPANY_BROKER_MIN_NONCE_LENGTH
    ) {
      throw brokerError('invalid_nonce');
    }
    if (typeof options.onRequest !== 'function') throw brokerError('invalid_handler');

    this.endpoint = options.endpoint;
    this.nonce = options.nonce;
    this.handler = options.onRequest;
    this.emit = typeof options.onEvent === 'function' ? options.onEvent : () => undefined;
    this.maxPending = options.maxPendingRequests ?? COMPANY_BROKER_MAX_PENDING_REQUESTS;
    this.maxPeers = options.maxConnections ?? COMPANY_BROKER_MAX_CONNECTIONS;

    this.server = net.createServer((socket) => this.accept(socket));
    // A listener that throws on 'error' takes the process down; every
    // post-listen failure becomes a diagnostic instead.
    this.server.on('error', () => {
      if (this.listening) this.report('server_error', 0);
    });
  }

  get connections(): number {
    return this.peers.size;
  }

  get pendingRequests(): number {
    return this.inFlight.size;
  }

  get disposed(): boolean {
    return this.closed;
  }

  /** Bind the endpoint. Rejects rather than serving on a second address. */
  async listen(): Promise<void> {
    if (this.closed) throw brokerError('disposed');
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => {
        this.server.removeListener('listening', onListening);
        reject(err);
      };
      const onListening = (): void => {
        this.server.removeListener('error', onError);
        resolve();
      };
      this.server.once('error', onError);
      this.server.once('listening', onListening);
      try {
        this.server.listen(this.endpoint);
      } catch (err) {
        this.server.removeListener('error', onError);
        this.server.removeListener('listening', onListening);
        reject(err);
      }
    });
    // Owner-only, or nothing: there is no world-reachable fallback.
    if (process.platform !== 'win32') restrictToOwner(this.endpoint);
    this.listening = true;
  }

  async dispose(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const peer of [...this.peers.values()]) peer.socket.destroy();
    this.peers.clear();
    this.inFlight.clear();
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
    });
    removeEndpoint(this.endpoint);
    this.report('disposed', 0);
  }

  // ── Connection ─────────────────────────────────────────────

  private accept(socket: net.Socket): void {
    if (this.closed) {
      socket.destroy();
      return;
    }
    if (this.peers.size >= this.maxPeers) {
      this.report('too_many_connections', this.peerCounter + 1);
      socket.destroy();
      return;
    }

    const peer: Peer = { id: ++this.peerCounter, socket, authenticated: false };
    this.peers.set(socket, peer);
    this.report('connection_opened', peer.id);

    const reader = new FrameReader(
      (frame) => this.receive(peer, frame),
      (code) => this.report(code, peer.id),
    );
    // The socket is never put in string mode, so `data` is always a Buffer.
    socket.on('data', (chunk) => reader.push(chunk as Buffer));
    socket.on('error', () => this.drop(peer));
    socket.on('close', () => this.drop(peer));
  }

  private drop(peer: Peer): void {
    if (!this.peers.delete(peer.socket)) return;
    this.report('connection_closed', peer.id);
  }

  // ── Receive ────────────────────────────────────────────────

  private receive(peer: Peer, value: unknown): void {
    if (!isFrameObject(value)) {
      this.report('frame_malformed', peer.id);
      if (!peer.authenticated) peer.socket.destroy();
      return;
    }
    if (value['v'] !== COMPANY_BROKER_PROTOCOL_VERSION) {
      // A peer on another wire version is not a peer this broker can serve.
      this.report('version_mismatch', peer.id);
      if (!peer.authenticated) peer.socket.destroy();
      return;
    }

    const type = value['t'];
    if (!isBoundedString(type, COMPANY_BROKER_MAX_COMMAND_LENGTH)) {
      this.report('frame_malformed', peer.id);
      return;
    }

    if (type === 'hello') {
      this.receiveHello(peer, value);
      return;
    }
    if (!peer.authenticated) {
      // Nothing is dispatched and nothing is interpreted: the frame is dropped
      // after a bare code, so an unauthenticated peer learns nothing about the
      // command vocabulary.
      this.report('unauthenticated_request', peer.id);
      this.write(peer, {
        v: COMPANY_BROKER_PROTOCOL_VERSION,
        t: 'error',
        error: { code: 'company_broker_unauthorized' },
      });
      return;
    }
    if (type === 'request') {
      this.receiveRequest(peer, value);
      return;
    }
    this.report('frame_unknown_type', peer.id);
  }

  private receiveHello(peer: Peer, frame: Record<string, unknown>): void {
    if (peer.authenticated || !secretsMatch(this.nonce, frame['nonce'])) {
      this.report(peer.authenticated ? 'duplicate_identity' : 'peer_refused', peer.id);
      this.write(peer, {
        v: COMPANY_BROKER_PROTOCOL_VERSION,
        t: 'error',
        error: { code: 'company_broker_unauthorized' },
      });
      peer.socket.end();
      return;
    }
    peer.authenticated = true;
    // The owner presents its own nonce, so the client authenticates the broker
    // before it discloses a command.
    this.write(peer, { v: COMPANY_BROKER_PROTOCOL_VERSION, t: 'ack', nonce: this.nonce });
  }

  private receiveRequest(peer: Peer, frame: Record<string, unknown>): void {
    const id = frame['id'];
    const command = frame['command'];
    if (
      !isBoundedString(id, COMPANY_BROKER_MAX_REQUEST_ID_LENGTH) ||
      !isBoundedString(command, COMPANY_BROKER_MAX_COMMAND_LENGTH)
    ) {
      this.report('frame_malformed', peer.id);
      return;
    }
    if (this.inFlight.has(id)) {
      // The peer reused an id that is still running: refuse the second copy
      // rather than dispatching the command twice.
      this.write(peer, {
        v: COMPANY_BROKER_PROTOCOL_VERSION,
        t: 'result',
        id,
        ok: false,
        error: { code: 'company_broker_idempotent_busy', message: ERROR_TEXT['idempotent_busy'] },
      });
      this.report('duplicate_request_id', peer.id);
      return;
    }
    if (this.inFlight.size >= this.maxPending) {
      this.write(peer, {
        v: COMPANY_BROKER_PROTOCOL_VERSION,
        t: 'result',
        id,
        ok: false,
        error: {
          code: 'company_broker_too_many_requests',
          message: ERROR_TEXT['too_many_requests'],
        },
      });
      this.report('too_many_requests', peer.id);
      return;
    }

    this.inFlight.add(id);
    const request: CompanyBrokerRequest = { requestId: id, command, params: frame['params'] };
    Promise.resolve()
      .then(() => this.handler(request))
      .then(
        (value) => {
          this.inFlight.delete(id);
          this.write(peer, {
            v: COMPANY_BROKER_PROTOCOL_VERSION,
            t: 'result',
            id,
            ok: true,
            value: value === undefined ? null : value,
          });
          this.report('request_completed', peer.id);
        },
        (error: unknown) => {
          this.inFlight.delete(id);
          this.write(peer, {
            v: COMPANY_BROKER_PROTOCOL_VERSION,
            t: 'result',
            id,
            ok: false,
            // Code only: the handler's own text stays in the owner process.
            error: { code: codeOf(error), message: ERROR_TEXT['handler_failed'] },
          });
          this.report('request_rejected', peer.id);
        },
      );
  }

  private write(peer: Peer, frame: unknown): void {
    const socket = peer.socket;
    if (this.closed || socket.destroyed) return;
    socket.write(`${JSON.stringify(frame)}\n`);
  }

  private report(code: CompanyBrokerEventCode, peer: number): void {
    try {
      this.emit({ code, peer });
    } catch {
      // A diagnostics sink must never be able to take the broker down.
    }
  }
}

/**
 * Bind an owner broker. The endpoint is supplied, never derived from the
 * caller's workspace, so the descriptor published to followers and the pipe
 * that serves them are the same address by construction.
 */
export async function createCompanyBrokerServer(
  options: CompanyBrokerServerOptions,
): Promise<CompanyBrokerHandle> {
  const server = new CompanyBrokerServer(options);
  try {
    await server.listen();
  } catch (err) {
    // The socket file is left alone: an occupied endpoint belongs to the live
    // owner, and this instance must not delete its address to retry.
    throw brokerError('unavailable', err);
  }
  return server;
}

// ── Client ────────────────────────────────────────────────────

/**
 * Send one command to an owner broker and await its result.
 *
 * Exactly one connection is made and exactly one request is written. There is
 * no reconnect and no re-send after a failure: the owner may have applied the
 * command before the channel dropped, and a duplicated side effect is worse
 * than an honest error. A caller that needs to know which side won compares the
 * reported `requestId` against its own persisted log.
 */
export async function sendCompanyBrokerRequest(
  input: CompanyBrokerClientInput,
): Promise<CompanyBrokerClientResult> {
  assertLocalBrokerEndpoint(input.endpoint);
  if (!isBoundedString(input.nonce, 512) || input.nonce.length < COMPANY_BROKER_MIN_NONCE_LENGTH) {
    throw brokerError('unauthorized');
  }
  if (!isBoundedString(input.command, COMPANY_BROKER_MAX_COMMAND_LENGTH)) {
    throw brokerError('frame_malformed');
  }
  const requestId = isBoundedString(input.requestId, COMPANY_BROKER_MAX_REQUEST_ID_LENGTH)
    ? input.requestId
    : randomUUID();

  const requestFrame = `${JSON.stringify({
    v: COMPANY_BROKER_PROTOCOL_VERSION,
    t: 'request',
    id: requestId,
    command: input.command,
    ...(input.params === undefined ? {} : { params: input.params }),
  })}\n`;
  // Refuse before connecting: an oversized command is a caller bug, and a
  // truncated one would be a different command.
  if (Buffer.byteLength(requestFrame, 'utf8') > COMPANY_BROKER_MAX_FRAME_BYTES) {
    throw brokerError('frame_too_large');
  }

  const helloFrame = `${JSON.stringify({
    v: COMPANY_BROKER_PROTOCOL_VERSION,
    t: 'hello',
    nonce: input.nonce,
  })}\n`;

  const settle = deferred<CompanyBrokerClientResult>();
  const connectTimer = setTimeout(
    () => settle.reject(brokerError('unavailable')),
    input.connectTimeoutMs ?? COMPANY_BROKER_DEFAULT_CONNECT_TIMEOUT_MS,
  );
  const requestTimer = setTimeout(
    () => settle.reject(brokerError('timeout')),
    input.requestTimeoutMs ?? COMPANY_BROKER_DEFAULT_REQUEST_TIMEOUT_MS,
  );
  connectTimer.unref?.();
  requestTimer.unref?.();

  const socket = net.createConnection(input.endpoint);
  let sent = false;

  const finish = (error: Error | null, value?: CompanyBrokerClientResult): void => {
    clearTimeout(connectTimer);
    clearTimeout(requestTimer);
    socket.destroy();
    if (error || value === undefined) settle.reject(error ?? brokerError('no_result'));
    else settle.resolve(value);
  };

  const reader = new FrameReader(
    (frame) => {
      if (!isFrameObject(frame) || frame['v'] !== COMPANY_BROKER_PROTOCOL_VERSION) {
        finish(brokerError('frame_malformed'));
        return;
      }
      if (frame['t'] === 'error') {
        const error = frame['error'];
        const refused = isFrameObject(error) && error['code'] === 'company_broker_unauthorized';
        // A broker sentence, never broker-supplied detail.
        finish(brokerError(refused ? 'unauthorized' : 'unavailable'));
        return;
      }
      if (frame['t'] === 'ack') {
        // The broker proves it holds the nonce before the command is disclosed.
        if (!secretsMatch(input.nonce, frame['nonce'])) {
          finish(brokerError('unauthorized'));
          return;
        }
        socket.write(requestFrame);
        sent = true;
        return;
      }
      if (frame['t'] === 'result') {
        if (frame['id'] !== requestId) return;
        if (frame['ok'] === true) {
          finish(null, { requestId, value: frame['value'] });
          return;
        }
        const error = frame['error'];
        const code =
          isFrameObject(error) && typeof error['code'] === 'string'
            ? error['code']
            : 'company_broker_handler_failed';
        finish(new CompanyError(code, ERROR_TEXT['handler_failed']));
        return;
      }
      // Anything else is a frame this client does not act on.
    },
    (code) => finish(brokerError(code)),
  );

  socket.on('connect', () => {
    socket.write(helloFrame);
  });
  socket.on('data', (chunk) => reader.push(chunk as Buffer));
  socket.on('error', (err) => finish(brokerError('unavailable', err)));
  socket.on('close', () => {
    // An uncertain outcome is reported as such; it is never retried, and a
    // request that was never sent is reported the same way.
    if (sent) finish(brokerError('server_closed'));
    else finish(brokerError('unavailable'));
  });

  return settle.promise;
}

/** True when an endpoint names this platform's local IPC transport. */
export function isLocalBrokerEndpoint(endpoint: string): boolean {
  try {
    assertLocalBrokerEndpoint(endpoint);
    return true;
  } catch {
    return false;
  }
}

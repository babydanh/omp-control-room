/**
 * ptyClient: the server-side handle on the external PTY helper.
 *
 * The client owns one helper process and correlates framed requests with
 * responses by id. It never builds a shell command line: the executable and
 * argv are passed through verbatim, so text a user types can never be
 * re-interpreted by a shell.
 *
 * Node resolution matters here. Inside the VS Code extension `process.execPath`
 * is Electron, whose native ABI does not match a `node-pty` build, so the
 * helper always runs under a real Node: `process.execPath` when that already is
 * Node, otherwise `NODE` or `node` from PATH.
 */

import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { CompanyError } from './companyError.js';
import type { PtyHostEvent, PtyHostRequest, PtySpawnIdentity, PtySpawnSpec } from './ptyHost.js';

export interface PtyClientOptions {
  /** Override the Node executable (tests, packaged layouts). */
  nodeExecutable?: string;
  /** Override the helper script (tests point this at the TypeScript source). */
  helperScript?: string;
}

interface PendingRequest {
  resolve: (payload: PtyOkPayload) => void;
  reject: (err: Error) => void;
}

/** The success fields one helper reply may carry. */
interface PtyOkPayload {
  readonly snapshot?: string;
  readonly pid?: number;
  readonly imageName?: string;
}

/**
 * Minimal deferred. `Promise.withResolvers` does not exist under this project's
 * ES2022 lib and needs Node 22, so the resolver pair is captured explicitly.
 * There is no timer here: the promise settles on a real frame from the helper.
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

/**
 * A spawn reply that does not name the process it started is unusable: the
 * host could never verify lineage against it, so it is refused rather than
 * tracked as an anonymous pid.
 */
function readSpawnIdentity(payload: PtyOkPayload): PtySpawnIdentity {
  if (typeof payload.pid !== 'number' || !Number.isSafeInteger(payload.pid) || payload.pid <= 0) {
    throw new CompanyError(
      'pty_spawn_identity_missing',
      'The PTY helper did not report the id of the process it started.',
    );
  }
  if (typeof payload.imageName !== 'string' || payload.imageName.trim() === '') {
    throw new CompanyError(
      'pty_spawn_identity_missing',
      'The PTY helper did not report the image name of the process it started.',
    );
  }
  return { pid: payload.pid, imageName: payload.imageName };
}

/** Read the success fields of a reply, dropping anything unrecognised. */
function readOkPayload(frame: Record<string, unknown>): PtyOkPayload {
  return {
    ...(typeof frame.snapshot === 'string' ? { snapshot: frame.snapshot } : {}),
    ...(typeof frame.pid === 'number' ? { pid: frame.pid } : {}),
    ...(typeof frame.imageName === 'string' ? { imageName: frame.imageName } : {}),
  };
}

/** True when this process is an Electron runtime rather than plain Node. */
function isElectronRuntime(): boolean {
  return /electron/i.test(path.basename(process.execPath));
}

export function resolveNodeExecutable(): string {
  if (!isElectronRuntime()) return process.execPath;
  const configured = process.env.NODE;
  if (configured) return configured;
  // Let the OS resolve `node` from PATH: an Electron install does not put its
  // own binary there under that name.
  return 'node';
}

/** Where the bundled helper lives, given this module's location. */
export function resolveHelperScript(): string {
  const distHelper = path.join(__dirname, 'company-pty-host.js');
  if (fs.existsSync(distHelper)) return distHelper;
  throw new CompanyError(
    'pty_helper_missing',
    `PTY helper not found at ${distHelper}. Build it with "npm run compile".`,
  );
}

export class PtyClient {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly listeners = new Set<(event: PtyHostEvent) => void>();
  private stdoutBuffer = '';
  private failure: Error | null = null;

  private constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.setEncoding('utf-8');
    child.stdout.on('data', (chunk: string) => this.consume(chunk));
    child.on('exit', (code) => {
      this.fail(
        new CompanyError('pty_helper_exited', `PTY helper exited with code ${String(code)}.`),
      );
    });
    child.on('error', (err) => {
      this.fail(err);
    });
  }

  /** Start the helper and resolve once its stdio is attached. */
  static async start(options: PtyClientOptions = {}): Promise<PtyClient> {
    const node = options.nodeExecutable ?? resolveNodeExecutable();
    const script = options.helperScript ?? resolveHelperScript();
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(node, [script], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      }) as ChildProcessWithoutNullStreams;
    } catch (err) {
      throw new CompanyError(
        'pty_helper_unavailable',
        `Cannot start the PTY helper: ${String(node)}`,
        { cause: err },
      );
    }
    return new PtyClient(child);
  }

  onEvent(listener: (event: PtyHostEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Spawn one PTY and report what the helper actually started. The pid comes
   * from `node-pty` inside the helper, so this is the only path by which the
   * host can learn it — and it is what makes lineage-checked ownership
   * possible. A reply without both fields is a protocol failure, not an
   * anonymous session.
   */
  async spawnPty(sessionId: string, spec: PtySpawnSpec): Promise<PtySpawnIdentity> {
    return this.request({ id: randomUUID(), op: 'spawn', sessionId, spec }).then(readSpawnIdentity);
  }

  async write(sessionId: string, data: string): Promise<void> {
    await this.request({ id: randomUUID(), op: 'write', sessionId, data });
  }

  async resize(sessionId: string, cols: number, rows: number): Promise<void> {
    await this.request({ id: randomUUID(), op: 'resize', sessionId, cols, rows });
  }

  async kill(sessionId: string): Promise<void> {
    await this.request({ id: randomUUID(), op: 'kill', sessionId });
  }

  /** Serialized framebuffer for a session, for attach and reattach. */
  async snapshot(sessionId: string): Promise<string> {
    const payload = await this.request({ id: randomUUID(), op: 'snapshot', sessionId });
    if (typeof payload.snapshot !== 'string') {
      throw new CompanyError('pty_snapshot_missing', 'The PTY helper returned no framebuffer.');
    }
    return payload.snapshot;
  }

  async dispose(): Promise<void> {
    if (this.failure) {
      this.child.kill();
      return;
    }
    try {
      await this.request({ id: randomUUID(), op: 'dispose' });
    } catch {
      // A helper that already died needs no clean shutdown.
    }
    this.child.kill();
  }

  private request(request: PtyHostRequest): Promise<PtyOkPayload> {
    if (this.failure) return Promise.reject(this.failure);
    const pending = deferred<PtyOkPayload>();
    this.pending.set(request.id, pending);
    this.child.stdin.write(`${JSON.stringify(request)}\n`);
    return pending.promise;
  }

  private consume(chunk: string): void {
    this.stdoutBuffer += chunk;
    let newline = this.stdoutBuffer.indexOf('\n');
    while (newline !== -1) {
      const line = this.stdoutBuffer.slice(0, newline);
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      this.dispatch(line);
      newline = this.stdoutBuffer.indexOf('\n');
    }
  }

  private dispatch(line: string): void {
    if (!line.trim()) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return; // A malformed frame must not take the helper down.
    }
    if (!parsed || typeof parsed !== 'object') return;
    const frame = parsed as Record<string, unknown>;

    if (typeof frame.id === 'string') {
      const pending = this.pending.get(frame.id);
      if (!pending) return;
      this.pending.delete(frame.id);
      if (frame.ok === true) {
        pending.resolve(readOkPayload(frame));
      } else {
        const code = typeof frame.errorCode === 'string' ? frame.errorCode : 'pty_request_failed';
        const message = typeof frame.message === 'string' ? frame.message : code;
        pending.reject(new CompanyError(code, message));
      }
      return;
    }

    const event = frame as unknown as PtyHostEvent;
    if (event.type === 'data' || event.type === 'exit') {
      for (const listener of this.listeners) listener(event);
    }
  }

  private fail(err: Error): void {
    this.failure ??= err;
    for (const pending of this.pending.values()) pending.reject(err);
    this.pending.clear();
  }
}

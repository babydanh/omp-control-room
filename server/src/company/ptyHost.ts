/**
 * ptyHost: the external helper that owns PTYs.
 *
 * This file is the entry point of a SEPARATE Node process, never the VS Code
 * extension host. `node-pty` is a native addon compiled against one ABI, and
 * Electron's ABI differs from the system Node's, so loading it inside the
 * extension would fail at require time. One helper per server process keeps the
 * addon in one place and bounds the PTY count in one place too.
 *
 * Wire format: newline-delimited JSON on stdin/stdout. Frames are structured
 * (`{id, op, ...}`), never shell command strings, so nothing the user types is
 * ever concatenated into a command line.
 *
 * Each PTY is mirrored into a headless xterm so a client that attaches late, or
 * reconnects, can be handed a serialized framebuffer instead of the whole
 * scrollback. The mirror parses asynchronously, so a snapshot waits for the
 * pending parses to drain: serializing mid-parse would hand back a screen that
 * is missing output the client has already seen on the live stream.
 */

import * as path from 'node:path';
import * as readline from 'node:readline';

import { SerializeAddon } from '@xterm/addon-serialize';
import { Terminal } from '@xterm/headless';
import * as pty from 'node-pty';

import { COMPANY_MAX_LIVE_RUNNERS, COMPANY_TERMINAL_NAME } from './constants.js';

export interface PtySpawnSpec {
  file: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
  term: string;
}

/**
 * What the helper learned about the process it actually started. The pid is
 * the only thing the host process cannot know on its own, and the host needs
 * it for lineage-checked ownership; the image name is the basename of the
 * requested executable, which is what a later probe compares against.
 */
export interface PtySpawnIdentity {
  readonly pid: number;
  readonly imageName: string;
}

export type PtyHostRequest =
  | { id: string; op: 'spawn'; sessionId: string; spec: PtySpawnSpec }
  | { id: string; op: 'write'; sessionId: string; data: string }
  | { id: string; op: 'resize'; sessionId: string; cols: number; rows: number }
  | { id: string; op: 'kill'; sessionId: string }
  | { id: string; op: 'snapshot'; sessionId: string }
  | { id: string; op: 'dispose' };

export type PtyHostResponse =
  | { id: string; ok: true; snapshot?: string; pid?: number; imageName?: string }
  | { id: string; ok: false; errorCode: string; message: string };

export type PtyHostEvent =
  | { type: 'data'; sessionId: string; data: string }
  | { type: 'exit'; sessionId: string; exitCode: number; signal?: number };

interface HostSession {
  terminal: Terminal;
  serialize: SerializeAddon;
  process: pty.IPty;
  /** Resolves when every chunk handed to the mirror has been parsed. */
  parsed: Promise<void>;
}

/** Error carrying a wire code so the client can react rather than guess. */
export class HostError extends Error {
  constructor(
    readonly errorCode: string,
    message: string,
  ) {
    super(message);
    this.name = 'HostError';
  }
}

/** Parse one framed request. Returns null for anything unrecognised. */
export function parseHostRequest(line: string): PtyHostRequest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const request = parsed as Record<string, unknown>;
  if (typeof request.id !== 'string' || typeof request.op !== 'string') return null;
  return request as unknown as PtyHostRequest;
}

export function writeFrame(value: PtyHostResponse | PtyHostEvent): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

/**
 * The host's session table. Exported as a class so a test can drive the real
 * node-pty surface in-process without spawning the helper, and so `main` below
 * stays a thin wiring of stdin lines to that table.
 */
export class PtyHost {
  private readonly sessions = new Map<string, HostSession>();

  spawn(sessionId: string, spec: PtySpawnSpec): PtySpawnIdentity {
    if (this.sessions.has(sessionId)) {
      throw new HostError('pty_session_exists', `Session already exists: ${sessionId}`);
    }
    if (this.sessions.size >= COMPANY_MAX_LIVE_RUNNERS) {
      throw new HostError(
        'pty_capacity_reached',
        `Refusing to exceed ${COMPANY_MAX_LIVE_RUNNERS} live PTYs.`,
      );
    }

    const terminal = new Terminal({
      cols: spec.cols,
      rows: spec.rows,
      allowProposedApi: true,
      scrollback: 5000,
    });
    const serialize = new SerializeAddon();
    terminal.loadAddon(serialize);

    const child = pty.spawn(spec.file, spec.args, {
      name: spec.term || COMPANY_TERMINAL_NAME,
      cols: spec.cols,
      rows: spec.rows,
      cwd: spec.cwd,
      env: spec.env,
    });

    const session: HostSession = { terminal, serialize, process: child, parsed: Promise.resolve() };
    this.sessions.set(sessionId, session);

    child.onData((data) => {
      session.parsed = session.parsed.then(
        () =>
          new Promise<void>((resolve) => {
            terminal.write(data, resolve);
          }),
      );
      // The wire carries base64, not a JS string: PTY output is bytes, and a
      // multi-byte character would not survive a UTF-8 round trip inside a
      // JSON frame. The browser decodes to Uint8Array and writes those bytes.
      writeFrame({
        type: 'data',
        sessionId,
        data: Buffer.from(data, 'utf-8').toString('base64'),
      });
    });
    child.onExit(({ exitCode, signal }) => {
      this.sessions.delete(sessionId);
      writeFrame({
        type: 'exit',
        sessionId,
        exitCode,
        ...(signal === undefined ? {} : { signal }),
      });
    });
    return { pid: child.pid, imageName: path.basename(spec.file) };
  }

  write(sessionId: string, data: string): void {
    this.require(sessionId).process.write(data);
  }

  resize(sessionId: string, cols: number, rows: number): void {
    const session = this.require(sessionId);
    session.process.resize(cols, rows);
    session.terminal.resize(cols, rows);
  }

  kill(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return; // already gone: killing a dead PTY is a no-op
    this.sessions.delete(sessionId);
    session.process.kill();
  }

  /**
   * Serialized framebuffer. Waits for the mirror to finish parsing so the
   * snapshot matches the live stream the client has already received.
   */
  async snapshot(sessionId: string): Promise<string> {
    const session = this.require(sessionId);
    await session.parsed;
    return session.serialize.serialize();
  }

  dispose(): void {
    for (const sessionId of [...this.sessions.keys()]) this.kill(sessionId);
  }

  get liveCount(): number {
    return this.sessions.size;
  }

  private require(sessionId: string): HostSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new HostError('pty_session_missing', `Unknown PTY session: ${sessionId}`);
    return session;
  }
}

/** Handle one stdin frame. Returns the response to write back. */
export async function handleFrame(
  host: PtyHost,
  request: PtyHostRequest,
): Promise<PtyHostResponse> {
  try {
    switch (request.op) {
      case 'spawn': {
        const identity = host.spawn(request.sessionId, request.spec);
        return { id: request.id, ok: true, pid: identity.pid, imageName: identity.imageName };
      }
      case 'write':
        host.write(request.sessionId, request.data);
        break;
      case 'resize':
        host.resize(request.sessionId, request.cols, request.rows);
        break;
      case 'kill':
        host.kill(request.sessionId);
        break;
      case 'snapshot':
        return {
          id: request.id,
          ok: true,
          // Base64 for the same reason live data is: the serialized
          // framebuffer is bytes, not text, and the client writes it as bytes.
          snapshot: Buffer.from(await host.snapshot(request.sessionId), 'utf-8').toString('base64'),
        };
      case 'dispose':
        host.dispose();
        return { id: request.id, ok: true };
    }
  } catch (err) {
    const code = err instanceof HostError ? err.errorCode : 'pty_request_failed';
    return { id: request.id, ok: false, errorCode: code, message: String(err) };
  }
  return { id: request.id, ok: true };
}

/** Wire stdin frames to the host. Called only inside the helper process. */
export function main(): void {
  const host = new PtyHost();
  // Frames are handled in order: a snapshot must not overtake the writes that
  // produced the screen it is capturing.
  let queue: Promise<void> = Promise.resolve();

  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on('line', (line) => {
    const request = parseHostRequest(line);
    if (!request) return;
    queue = queue.then(async () => {
      writeFrame(await handleFrame(host, request));
      if (request.op === 'dispose') {
        host.dispose();
        process.exit(0);
      }
    });
  });

  process.on('SIGTERM', () => {
    host.dispose();
    process.exit(0);
  });
}

// `require.main === module` is true only when this file is the process entry,
// so importing it from a test never starts the stdin wiring.
if (require.main === module) {
  main();
}

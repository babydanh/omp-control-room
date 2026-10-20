/**
 * The process boundary for Claude Code: the spawn seam, the tree kill, bounded output readers, and
 * the one-shot turn. Only this file and the runners touch real processes; tests inject fakes for
 * the spawn, the kill, and the timers.
 */

import { execFile, spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

import { CLAUDE_COMMAND } from './claudeCli.js';

/** The writable side of a child's stdin, as the runners use it. */
export interface ClaudeWritable {
  on(event: 'error', listener: (error: Error) => void): unknown;
  write(chunk: string): boolean;
  end(): void;
}

/** A readable side of a child's output, as the runners use it. Chunks are raw bytes. */
export interface ClaudeReadable {
  on(event: 'data', listener: (chunk: Buffer) => void): unknown;
}

/**
 * The part of a child process the runners use. Structural, so a fake satisfies it in tests. The
 * runners wait for `close`, which fires after the output streams end; `exit` can fire before the
 * last output arrives.
 */
export interface ClaudeChildProcess {
  readonly pid?: number;
  readonly stdin: ClaudeWritable | null;
  readonly stdout: ClaudeReadable | null;
  readonly stderr: ClaudeReadable | null;
  on(event: 'close', listener: (code: number | null) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  kill(signal?: NodeJS.Signals | number): boolean;
}

/** Starts one Claude Code process with argv only and no shell. */
export type ClaudeSpawn = (
  file: string,
  args: readonly string[],
  options: { readonly cwd: string },
) => ClaudeChildProcess;

/** Opaque handle a timer returns; the matching clear takes it back. */
export type ClaudeTimerHandle = unknown;
export type ClaudeSetTimer = (callback: () => void, ms: number) => ClaudeTimerHandle;
export type ClaudeClearTimer = (handle: ClaudeTimerHandle) => void;

/** The `spawnError` a missing program reads as. Node reports it with the code ENOENT. */
export const CLAUDE_SPAWN_ENOENT = 'ENOENT';

/** Largest stdout one turn may produce before its process is stopped. */
const TURN_STDOUT_MAX_BYTES = 4 * 1024 * 1024;
/** Largest stderr kept from one turn; the rest is dropped. */
const TURN_STDERR_MAX_BYTES = 64 * 1024;

export interface ClaudeKillOptions {
  readonly platform?: NodeJS.Platform;
  readonly runTaskkill?: (args: readonly string[]) => void;
}

export interface ClaudeTurnInput {
  readonly spawn: ClaudeSpawn;
  readonly file?: string;
  readonly cwd: string;
  readonly args: readonly string[];
  readonly prompt: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  readonly setTimer?: ClaudeSetTimer;
  readonly clearTimer?: ClaudeClearTimer;
}

export interface ClaudeTurnOutcome {
  /** Null when the process was stopped (timeout, abort, output cap) or never ran. */
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  /** `ENOENT` when the program is missing, otherwise the spawn error's message. */
  readonly spawnError?: string;
}

/** Decoded text kept from one stream, up to a byte cap. */
export interface ClaudeTextCapture {
  /** Adds one chunk. Returns false when bytes past the cap were dropped. */
  push(chunk: Buffer): boolean;
  /** Everything kept so far, decoded. */
  text(): string;
}

/** Splits a byte stream into lines, each handed to `onLine` without its newline. */
export interface ClaudeLineSplitter {
  push(chunk: Buffer): void;
  /** Hands over a final line that had no newline, then resets. */
  end(): void;
}

export const defaultSetTimer: ClaudeSetTimer = (callback, ms) => setTimeout(callback, ms);

export const defaultClearTimer: ClaudeClearTimer = (handle) =>
  clearTimeout(handle as NodeJS.Timeout);

/** True when a spawn or exec failure means the program is not on PATH. */
export function isSpawnNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

/** The text a spawn failure carries: the ENOENT code when the program is missing, else the message. */
export function spawnFailureText(error: unknown): string {
  if (isSpawnNotFound(error)) return CLAUDE_SPAWN_ENOENT;
  return error instanceof Error ? error.message : String(error);
}

/**
 * The production spawn: argv only, no shell, pipes for stdio, and its own process group on POSIX
 * so the whole tree can be signalled together.
 */
export function defaultClaudeSpawn(): ClaudeSpawn {
  return (file, args, options) =>
    spawn(file, [...args], {
      cwd: options.cwd,
      shell: false,
      windowsHide: true,
      stdio: 'pipe',
      detached: process.platform !== 'win32',
    });
}

/**
 * Stops a process tree. Windows walks the children with taskkill. POSIX signals the process group
 * the child leads, falling back to the pid. Never signals pid 0 or a negative pid, which would reach
 * this process's own group.
 */
export function killClaudeTree(pid: number, options: ClaudeKillOptions = {}): void {
  if (!Number.isInteger(pid) || pid <= 0) return;
  const platform = options.platform ?? process.platform;
  if (platform === 'win32') {
    const taskkillArgs = ['/PID', String(pid), '/T', '/F'];
    if (options.runTaskkill !== undefined) options.runTaskkill(taskkillArgs);
    else execFile('taskkill', taskkillArgs, { windowsHide: true }, () => undefined);
    return;
  }
  try {
    process.kill(-pid, 'SIGTERM');
    return;
  } catch {
    // The group is gone, or the child never led one: signal the pid itself below.
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // Already exited.
  }
}

/** Writes the prompt to the child's stdin and closes it. A failed write surfaces as an error event. */
export function sendPrompt(child: ClaudeChildProcess, prompt: string): void {
  child.stdin?.on('error', () => undefined);
  child.stdin?.write(prompt);
  child.stdin?.end();
}

/** Keeps decoded text up to `maxBytes` of input. Bytes past the cap are dropped, never buffered. */
export function createTextCapture(maxBytes: number): ClaudeTextCapture {
  const decoder = new StringDecoder('utf8');
  let kept = '';
  let bytes = 0;
  return {
    push(chunk) {
      if (chunk.length <= maxBytes - bytes) {
        bytes += chunk.length;
        kept += decoder.write(chunk);
        return true;
      }
      const room = maxBytes - bytes;
      if (room > 0) {
        bytes += room;
        kept += decoder.write(chunk.subarray(0, room));
      }
      return false;
    },
    text() {
      return kept + decoder.end();
    },
  };
}

/**
 * Splits a byte stream into lines. A line longer than `maxLineChars` is dropped whole, so memory
 * stays bounded by the cap however much the process prints.
 */
export function createLineSplitter(
  maxLineChars: number,
  onLine: (line: string) => void,
): ClaudeLineSplitter {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  let discarding = false;

  function feed(text: string): void {
    let start = 0;
    let newline = text.indexOf('\n');
    while (newline !== -1) {
      if (!discarding) {
        pending += text.slice(start, newline);
        if (pending.length <= maxLineChars) onLine(pending);
      }
      pending = '';
      discarding = false;
      start = newline + 1;
      newline = text.indexOf('\n', start);
    }
    if (discarding) return;
    pending += text.slice(start);
    if (pending.length > maxLineChars) {
      pending = '';
      discarding = true;
    }
  }

  return {
    push(chunk) {
      feed(decoder.write(chunk));
    },
    end() {
      feed(decoder.end());
      if (!discarding && pending !== '') onLine(pending);
      pending = '';
      discarding = false;
    },
  };
}

/**
 * Runs one print-mode turn: the prompt on stdin, the output captured, and the process stopped on
 * timeout, abort, or an output past the cap. Resolves once, without waiting for `close` after a stop,
 * so a hung process cannot hold the turn open. Never rejects.
 */
export function runClaudeTurn(input: ClaudeTurnInput): Promise<ClaudeTurnOutcome> {
  // Executor form: this project's ES2022 lib has no Promise.withResolvers, as other server modules note.
  return new Promise((resolve) => {
    if (input.signal?.aborted === true) {
      resolve({ exitCode: null, stdout: '', stderr: '', timedOut: false });
      return;
    }
    let child: ClaudeChildProcess;
    try {
      child = input.spawn(input.file ?? CLAUDE_COMMAND, input.args, { cwd: input.cwd });
    } catch (error) {
      resolve({
        exitCode: null,
        stdout: '',
        stderr: '',
        timedOut: false,
        spawnError: spawnFailureText(error),
      });
      return;
    }
    const stdout = createTextCapture(TURN_STDOUT_MAX_BYTES);
    const stderr = createTextCapture(TURN_STDERR_MAX_BYTES);
    const clearTimer = input.clearTimer ?? defaultClearTimer;
    let settled = false;
    let timedOut = false;

    function settle(exitCode: number | null, spawnError?: string): void {
      if (settled) return;
      settled = true;
      clearTimer(timer);
      input.signal?.removeEventListener('abort', onAbort);
      resolve({ exitCode, stdout: stdout.text(), stderr: stderr.text(), timedOut, spawnError });
    }

    function onAbort(): void {
      stopChild(child);
      settle(null);
    }

    function onTimeout(): void {
      timedOut = true;
      stopChild(child);
      settle(null);
    }

    const timer = (input.setTimer ?? defaultSetTimer)(onTimeout, input.timeoutMs);
    input.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout?.on('data', (chunk) => {
      if (settled) return;
      if (!stdout.push(chunk)) {
        stopChild(child);
        settle(null);
      }
    });
    child.stderr?.on('data', (chunk) => {
      if (!settled) stderr.push(chunk);
    });
    child.on('error', (error) => settle(null, spawnFailureText(error)));
    child.on('close', (code) => settle(code));
    sendPrompt(child, input.prompt);
  });
}

/** Stops a child: its whole tree when the pid is known, otherwise the child itself. */
function stopChild(child: ClaudeChildProcess): void {
  if (child.pid === undefined) child.kill();
  else killClaudeTree(child.pid);
}

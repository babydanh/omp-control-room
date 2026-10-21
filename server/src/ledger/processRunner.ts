/**
 * The process boundary for the ledger: every external command (git, python
 * scripts) goes through a ProcessRunner so tests can substitute fakes. The
 * real runner never uses a shell, never throws, and bounds time and output.
 */

import {
  execFile,
  type ExecFileException,
  type ExecFileOptionsWithBufferEncoding,
} from 'node:child_process';

export interface ProcessOptions {
  readonly cwd?: string;
  readonly timeoutMs: number;
  /** Exit codes that count as success. */
  readonly okCodes: readonly number[];
  /** Stdout beyond this many bytes is cut and flagged `truncated`. */
  readonly maxBytes: number;
  /** Environment overrides merged over the current process environment. */
  readonly env?: NodeJS.ProcessEnv;
}

export interface ProcessResult {
  /** Not timed out, spawned, and exited with an ok code. Output overflow counts as ok. */
  readonly ok: boolean;
  /** Exit code, or null when the process never exited normally. */
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly truncated: boolean;
}

export type ProcessRunner = (
  file: string,
  args: readonly string[],
  options: ProcessOptions,
) => Promise<ProcessResult>;

/** Runs a script given its argv only; the runtime supplies the interpreter and script path. */
export type ScriptRunner = (
  argv: readonly string[],
  options: ProcessOptions,
) => Promise<ProcessResult>;

export const runProcess: ProcessRunner = (file, args, options) =>
  new Promise((resolve) => {
    const execOptions: ExecFileOptionsWithBufferEncoding = {
      cwd: options.cwd,
      timeout: options.timeoutMs,
      maxBuffer: options.maxBytes,
      windowsHide: true,
      shell: false,
      encoding: 'buffer',
      env: options.env === undefined ? process.env : { ...process.env, ...options.env },
    };
    execFile(file, [...args], execOptions, (error, stdout, stderr) => {
      resolve(resultOf(error, stdout, stderr, options));
    });
  });

function resultOf(
  error: ExecFileException | null,
  stdout: Buffer,
  stderr: Buffer,
  options: ProcessOptions,
): ProcessResult {
  const overflow = error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
  const timedOut = !overflow && error?.killed === true;
  const code = error === null ? 0 : typeof error.code === 'number' ? error.code : null;
  const spawnFailed = error !== null && code === null && !timedOut && !overflow;
  const truncated = overflow || stdout.length > options.maxBytes;
  const stderrText =
    stderr.length > 0
      ? stderr.toString('utf8')
      : spawnFailed && error !== null
        ? error.message
        : '';
  const ok = !timedOut && (overflow || (code !== null && options.okCodes.includes(code)));
  return {
    ok,
    code,
    stdout: stdout.subarray(0, options.maxBytes).toString('utf8'),
    stderr: stderrText,
    timedOut,
    truncated,
  };
}

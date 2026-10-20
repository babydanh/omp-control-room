/**
 * Probes whether Claude Code is installed and signed in with a Claude account. The probe runs
 * `claude auth status` with argv and no shell, caches the answer for a short time, and shares one
 * probe between concurrent callers. Only the exit code and `authMethod` are read; nothing else from
 * the output is kept or logged.
 */

import { execFile } from 'node:child_process';

import type { ClaudeCodeStatus } from '../../../../core/src/messages.js';
import {
  CLAUDE_AUTH_ARGS,
  CLAUDE_COMMAND,
  type ClaudeAuthState,
  parseAuthStatus,
} from './claudeCli.js';
import { CLAUDE_SPAWN_ENOENT, isSpawnNotFound } from './claudeProcess.js';

/** How long a probe result is reused, in milliseconds. */
const CLAUDE_AUTH_TTL_MS = 60_000;
/** Longest the auth command may run before it is stopped. */
const AUTH_PROBE_TIMEOUT_MS = 15_000;
/** Largest output the auth command may produce. */
const AUTH_PROBE_MAX_BYTES = 64 * 1024;

export interface ClaudeAuthProbe {
  /** The current state. A fresh cached result is returned unless `force` is set. */
  check(force?: boolean): Promise<ClaudeCodeStatus>;
  /** The last known state; `unknown` before the first check. */
  current(): ClaudeCodeStatus;
}

/** What one auth command run produced. `spawnError` is `ENOENT` when the program is missing. */
export interface ClaudeAuthRunResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly spawnError?: string;
}

export type ClaudeAuthRun = (file: string, args: readonly string[]) => Promise<ClaudeAuthRunResult>;

export interface ClaudeAuthProbeOptions {
  readonly run?: ClaudeAuthRun;
  readonly now?: () => number;
  readonly ttlMs?: number;
}

export function createClaudeAuthProbe(options: ClaudeAuthProbeOptions = {}): ClaudeAuthProbe {
  const run = options.run ?? defaultAuthRun;
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? CLAUDE_AUTH_TTL_MS;
  let status: ClaudeCodeStatus = { state: 'unknown' };
  let checkedAtMs: number | undefined;
  let inFlight: Promise<ClaudeCodeStatus> | undefined;

  /** One real probe. Never rejects: a probe that cannot run reads as unknown. */
  async function probe(): Promise<ClaudeCodeStatus> {
    let state: ClaudeAuthState;
    try {
      state = authStateOf(await run(CLAUDE_COMMAND, CLAUDE_AUTH_ARGS));
    } catch {
      state = 'unknown';
    }
    checkedAtMs = now();
    return { state, checkedAt: new Date(checkedAtMs).toISOString() };
  }

  function refresh(): Promise<ClaudeCodeStatus> {
    const pending = probe()
      .then((next) => {
        status = next;
        return next;
      })
      .finally(() => {
        inFlight = undefined;
      });
    inFlight = pending;
    return pending;
  }

  return {
    check(force = false) {
      if (inFlight !== undefined) return inFlight;
      if (!force && checkedAtMs !== undefined && now() - checkedAtMs < ttlMs) {
        return Promise.resolve(status);
      }
      return refresh();
    },
    current() {
      return status;
    },
  };
}

function authStateOf(result: ClaudeAuthRunResult): ClaudeAuthState {
  if (result.spawnError === CLAUDE_SPAWN_ENOENT) return 'missing';
  if (result.spawnError !== undefined) return 'unknown';
  return parseAuthStatus(result.exitCode, result.stdout);
}

/** Runs the auth command with argv, no shell, and a bounded wait and output. */
function defaultAuthRun(file: string, args: readonly string[]): Promise<ClaudeAuthRunResult> {
  return new Promise((resolve) => {
    execFile(
      file,
      [...args],
      {
        timeout: AUTH_PROBE_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: AUTH_PROBE_MAX_BYTES,
        shell: false,
        encoding: 'utf8',
      },
      (error, stdout) => {
        if (error === null) {
          resolve({ exitCode: 0, stdout });
          return;
        }
        if (isSpawnNotFound(error)) {
          resolve({ exitCode: null, stdout: '', spawnError: CLAUDE_SPAWN_ENOENT });
          return;
        }
        resolve({ exitCode: typeof error.code === 'number' ? error.code : null, stdout });
      },
    );
  });
}

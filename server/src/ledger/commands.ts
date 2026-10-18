/**
 * Ledger board commands: send a message to a session through who.py, and read
 * one file's diff from a worktree the board is currently showing. Inputs are
 * validated here; git and who.py run through injected runners.
 */

import type { LedgerWorktree } from '../../../core/src/messages.js';
import {
  LEDGER_DEV_NULL,
  LEDGER_DIFF_MAX_BYTES,
  LEDGER_DIFF_TIMEOUT_MS,
  LEDGER_PATH_MAX,
  LEDGER_REASON_BAD_SESSION,
  LEDGER_REASON_DIFF_EMPTY,
  LEDGER_REASON_DIFF_FAILED,
  LEDGER_REASON_DIFF_TIMEOUT,
  LEDGER_REASON_EMPTY_TEXT,
  LEDGER_REASON_PATH_INVALID,
  LEDGER_REASON_SEND_FAILED,
  LEDGER_REASON_SEND_TIMEOUT,
  LEDGER_REASON_TEXT_NUL,
  LEDGER_REASON_TEXT_TOO_LONG,
  LEDGER_REASON_WORKTREE_UNKNOWN,
  LEDGER_SEND_OUTPUT_MAX_BYTES,
  LEDGER_SEND_REASON_MAX,
  LEDGER_SEND_TEXT_MAX,
  LEDGER_SEND_TIMEOUT_MS,
  LEDGER_SESSION_ID_PATTERN,
  LEDGER_SHORT_ID_LENGTH,
} from './constants.js';
import type { GitRunner } from './git.js';
import { ledgerPathKey } from './ledgerPath.js';
import type { ScriptRunner } from './processRunner.js';

export interface SendOutcome {
  readonly ok: boolean;
  readonly reason?: string;
  readonly delivered?: string[];
}

export interface FileDiffOutcome {
  readonly ok: boolean;
  readonly diff: string;
  readonly truncated: boolean;
  readonly reason?: string;
}

/** Sends `text` to one session through `who.py send`. Validation runs before any process starts. */
export async function sendMessage(
  run: ScriptRunner,
  sessionId: string,
  rawText: string,
): Promise<SendOutcome> {
  if (!LEDGER_SESSION_ID_PATTERN.test(sessionId)) {
    return { ok: false, reason: LEDGER_REASON_BAD_SESSION };
  }
  const text = rawText.trim();
  if (text === '') return { ok: false, reason: LEDGER_REASON_EMPTY_TEXT };
  if (text.includes('\0')) return { ok: false, reason: LEDGER_REASON_TEXT_NUL };
  if (text.length > LEDGER_SEND_TEXT_MAX) return { ok: false, reason: LEDGER_REASON_TEXT_TOO_LONG };

  const result = await run(['send', sessionId, text], {
    timeoutMs: LEDGER_SEND_TIMEOUT_MS,
    okCodes: [0],
    maxBytes: LEDGER_SEND_OUTPUT_MAX_BYTES,
  });
  if (result.timedOut) return { ok: false, reason: LEDGER_REASON_SEND_TIMEOUT };
  if (!result.ok) {
    const stderr = result.stderr.trim().slice(0, LEDGER_SEND_REASON_MAX);
    return { ok: false, reason: stderr || LEDGER_REASON_SEND_FAILED };
  }
  return { ok: true, delivered: [sessionId.slice(-LEDGER_SHORT_ID_LENGTH)] };
}

/**
 * Reads the diff of one file against HEAD. The worktree must be one the latest
 * view lists, and the path must stay inside it. Untracked files diff against
 * /dev/null, because `git diff HEAD` does not show them.
 */
export async function fileDiff(
  git: GitRunner,
  worktree: string,
  path: string,
  known: readonly Pick<LedgerWorktree, 'path' | 'dirtyFiles'>[],
): Promise<FileDiffOutcome> {
  const worktreeKey = ledgerPathKey(worktree);
  const match = known.find((entry) => ledgerPathKey(entry.path) === worktreeKey);
  if (match === undefined) return refusedDiff(LEDGER_REASON_WORKTREE_UNKNOWN);

  const unsafe =
    path === '' ||
    path.length > LEDGER_PATH_MAX ||
    path.includes('\0') ||
    /^[A-Za-z]:/.test(path) ||
    /^[\\/]/.test(path) ||
    path.split(/[\\/]/).includes('..');
  if (unsafe) return refusedDiff(LEDGER_REASON_PATH_INVALID);

  const pathKey = ledgerPathKey(path);
  const untracked = match.dirtyFiles.some(
    (file) => file.status === '??' && ledgerPathKey(file.path) === pathKey,
  );
  const result = await git.run(
    match.path,
    untracked
      ? ['diff', '--no-index', '--no-color', '--no-ext-diff', '--', LEDGER_DEV_NULL, path]
      : ['diff', '--no-color', '--no-ext-diff', '--no-textconv', 'HEAD', '--', path],
    {
      timeoutMs: LEDGER_DIFF_TIMEOUT_MS,
      // `git diff --no-index` exits 1 when the files differ, which is the normal case.
      okCodes: untracked ? [0, 1] : [0],
      maxBytes: LEDGER_DIFF_MAX_BYTES,
    },
  );
  if (result.timedOut) return refusedDiff(LEDGER_REASON_DIFF_TIMEOUT);
  if (!result.ok) return refusedDiff(LEDGER_REASON_DIFF_FAILED);
  if (result.stdout === '' && !result.truncated) {
    return { ok: true, diff: '', truncated: false, reason: LEDGER_REASON_DIFF_EMPTY };
  }
  return { ok: true, diff: result.stdout, truncated: result.truncated };
}

function refusedDiff(reason: string): FileDiffOutcome {
  return { ok: false, diff: '', truncated: false, reason };
}

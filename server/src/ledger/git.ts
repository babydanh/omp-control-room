/**
 * Git reads for the ledger board: worktree list, dirty files, ahead/behind,
 * merge state, upstream and last commit. Every command runs through
 * `git --no-optional-locks -C <cwd>`, so reading the board never takes an
 * index lock. The parsers are pure; readRepo is the only async entry point.
 */

import type { LedgerDirtyFile } from '../../../core/src/messages.js';
import {
  LEDGER_GIT_COMMAND,
  LEDGER_GIT_ERROR_PREFIX,
  LEDGER_GIT_MAX_BYTES,
  LEDGER_GIT_PROBLEM_BASE,
  LEDGER_GIT_PROBLEM_LAST_COMMIT,
  LEDGER_GIT_PROBLEM_STATUS,
  LEDGER_GIT_PROBLEM_UPSTREAM,
  LEDGER_GIT_TIMEOUT_MS,
  LEDGER_OVERLAP_BASE,
  LEDGER_SHORT_SHA_LENGTH,
} from './constants.js';
import { ledgerBasename, normalizeLedgerPath } from './ledgerPath.js';
import { formatLedgerTime } from './ledgerTime.js';
import type { ProcessOptions, ProcessResult, ProcessRunner } from './processRunner.js';

export type GitRunOptions = Omit<ProcessOptions, 'cwd'>;

export interface GitRunner {
  run(cwd: string, args: readonly string[], options: GitRunOptions): Promise<ProcessResult>;
}

/** One checkout as the board shows it, before session attribution. */
export interface LedgerWorktreeState {
  readonly path: string;
  readonly name: string;
  readonly branch: string | null;
  readonly head: string;
  readonly isMain: boolean;
  readonly ahead: number;
  readonly behind: number;
  readonly dirtyCount: number;
  readonly dirtyFiles: LedgerDirtyFile[];
  readonly merged: boolean;
  readonly hasUpstream: boolean;
  readonly unpushed: number | null;
  readonly lastCommitSubject: string;
  readonly lastCommitAt: string | null;
  readonly gitError?: string;
}

export type GitRepoScan =
  | { readonly kind: 'repo'; readonly worktrees: LedgerWorktreeState[] }
  | { readonly kind: 'not-repo' };

export interface WorktreeEntry {
  path: string;
  head: string;
  branch: string | null;
  bare: boolean;
  detached: boolean;
  prunable: boolean;
}

const READ_OPTIONS: GitRunOptions = {
  timeoutMs: LEDGER_GIT_TIMEOUT_MS,
  okCodes: [0],
  maxBytes: LEDGER_GIT_MAX_BYTES,
};
/** `merge-base --is-ancestor` exits 1 for "not an ancestor": a valid answer. */
const ANCESTOR_OPTIONS: GitRunOptions = { ...READ_OPTIONS, okCodes: [0, 1] };
/** `@{u}` without an upstream exits 128: a valid "no upstream" answer. */
const UPSTREAM_OPTIONS: GitRunOptions = { ...READ_OPTIONS, okCodes: [0, 128] };

export function createGitRunner(run: ProcessRunner): GitRunner {
  return {
    run: (cwd, args, options) =>
      run(LEDGER_GIT_COMMAND, ['--no-optional-locks', '-C', cwd, ...args], options),
  };
}

/** Parses `git worktree list --porcelain`; blank lines separate records. */
export function parseWorktreeList(stdout: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let draft: WorktreeEntry | null = null;
  for (const line of stdout.split('\n')) {
    const text = line.replace(/\r$/, '');
    if (text === '') {
      if (draft !== null) entries.push(draft);
      draft = null;
      continue;
    }
    const space = text.indexOf(' ');
    const key = space < 0 ? text : text.slice(0, space);
    const value = space < 0 ? '' : text.slice(space + 1);
    if (key === 'worktree') {
      if (draft !== null) entries.push(draft);
      draft = {
        path: normalizeLedgerPath(value),
        head: '',
        branch: null,
        bare: false,
        detached: false,
        prunable: false,
      };
      continue;
    }
    if (draft === null) continue;
    switch (key) {
      case 'HEAD':
        draft.head = value;
        break;
      case 'branch':
        draft.branch = value.replace(/^refs\/heads\//, '');
        break;
      case 'detached':
        draft.detached = true;
        break;
      case 'bare':
        draft.bare = true;
        break;
      case 'prunable':
        draft.prunable = true;
        break;
      default:
        break;
    }
  }
  if (draft !== null) entries.push(draft);
  return entries;
}

/** Parses `git status --porcelain=v1 -z --no-renames`: records are `XY<space>path<NUL>`. */
export function parseStatusZ(stdout: string): LedgerDirtyFile[] {
  const files: LedgerDirtyFile[] = [];
  for (const record of stdout.split('\0')) {
    if (record.length < 4) continue;
    files.push({ status: record.slice(0, 2).trim(), path: record.slice(3) });
  }
  return files;
}

/** Parses `rev-list --left-right --count A...B`: "<only in A>\t<only in B>". */
export function parseAheadBehind(stdout: string): { behind: number; ahead: number } | null {
  const match = /^(\d+)\s+(\d+)$/.exec(stdout.trim());
  if (match === null) return null;
  return { behind: Number(match[1]), ahead: Number(match[2]) };
}

/** Parses `rev-list --count A..B`: one number, or null when git printed anything else. */
export function parseCount(stdout: string): number | null {
  const text = stdout.trim();
  return /^\d+$/.test(text) ? Number(text) : null;
}

/** Parses `log -1 --format=%s%x00%cI`; the commit time comes back in ledger local time. */
export function parseLastCommit(
  stdout: string,
): { subject: string; committedAt: string | null } | null {
  const separator = stdout.indexOf('\0');
  if (separator < 0) return null;
  const subject = stdout.slice(0, separator);
  const ms = Date.parse(stdout.slice(separator + 1).trim());
  return { subject, committedAt: Number.isNaN(ms) ? null : formatLedgerTime(ms) };
}

/** Reads one repo folder. Only a folder that is itself a git toplevel is scanned. */
export async function readRepo(git: GitRunner, repo: string): Promise<GitRepoScan> {
  // An empty prefix means the folder is the toplevel. Comparing printed paths fails on
  // junctions and drive-letter aliases, where git prints the physical path instead.
  const prefix = await git.run(repo, ['rev-parse', '--show-prefix'], READ_OPTIONS);
  if (!prefix.ok || prefix.stdout.trim() !== '') {
    return { kind: 'not-repo' };
  }
  const list = await git.run(repo, ['worktree', 'list', '--porcelain'], READ_OPTIONS);
  if (!list.ok) return { kind: 'not-repo' };

  const worktrees: LedgerWorktreeState[] = [];
  for (const [index, entry] of parseWorktreeList(list.stdout).entries()) {
    // Bare and prunable entries have no checkout to read.
    if (entry.bare || entry.prunable) continue;
    worktrees.push(await readWorktree(git, entry, index === 0));
  }
  return { kind: 'repo', worktrees };
}

async function readWorktree(
  git: GitRunner,
  entry: WorktreeEntry,
  isMain: boolean,
): Promise<LedgerWorktreeState> {
  const problems: string[] = [];

  const status = await git.run(
    entry.path,
    ['status', '--porcelain=v1', '-z', '--untracked-files=normal', '--no-renames'],
    READ_OPTIONS,
  );
  if (!status.ok) problems.push(LEDGER_GIT_PROBLEM_STATUS);
  const dirtyFiles = status.ok ? parseStatusZ(status.stdout) : [];

  const counts = await git.run(
    entry.path,
    ['rev-list', '--left-right', '--count', `${LEDGER_OVERLAP_BASE}...HEAD`],
    READ_OPTIONS,
  );
  const aheadBehind = counts.ok ? parseAheadBehind(counts.stdout) : null;
  if (aheadBehind === null) problems.push(LEDGER_GIT_PROBLEM_BASE);

  const ancestor = await git.run(
    entry.path,
    ['merge-base', '--is-ancestor', 'HEAD', LEDGER_OVERLAP_BASE],
    ANCESTOR_OPTIONS,
  );
  if (!ancestor.ok) problems.push(LEDGER_GIT_PROBLEM_BASE);

  const upstream = await git.run(
    entry.path,
    ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'],
    UPSTREAM_OPTIONS,
  );
  const hasUpstream = upstream.ok && upstream.code === 0;
  // Commits on HEAD that the upstream lacks: work that exists only on this machine.
  const unpushedRun = hasUpstream
    ? await git.run(entry.path, ['rev-list', '--count', '@{u}..HEAD'], READ_OPTIONS)
    : null;
  const unpushed = unpushedRun !== null && unpushedRun.ok ? parseCount(unpushedRun.stdout) : null;
  if (unpushedRun !== null && unpushed === null) problems.push(LEDGER_GIT_PROBLEM_UPSTREAM);

  const log = await git.run(entry.path, ['log', '-1', '--format=%s%x00%cI'], READ_OPTIONS);
  const commit = log.ok ? parseLastCommit(log.stdout) : null;
  if (commit === null) problems.push(LEDGER_GIT_PROBLEM_LAST_COMMIT);

  return {
    path: entry.path,
    name: ledgerBasename(entry.path),
    branch: entry.branch,
    head: entry.head.slice(0, LEDGER_SHORT_SHA_LENGTH),
    isMain,
    ahead: aheadBehind?.ahead ?? 0,
    behind: aheadBehind?.behind ?? 0,
    dirtyCount: dirtyFiles.length,
    dirtyFiles,
    merged: ancestor.ok && ancestor.code === 0,
    hasUpstream,
    unpushed,
    lastCommitSubject: commit?.subject ?? '',
    lastCommitAt: commit?.committedAt ?? null,
    ...(problems.length > 0
      ? { gitError: `${LEDGER_GIT_ERROR_PREFIX} ${[...new Set(problems)].join(', ')}.` }
      : {}),
  };
}

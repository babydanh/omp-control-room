/**
 * Isolated git worktrees for squad editing items. An editing item that opens a new session runs in
 * its own worktree, so two agents never write to one checkout.
 *
 * The worktree is made with `git-wt` (worktrunk) when it is on PATH, so the user's worktree layout
 * applies. Otherwise it is made with plain git under `<repo>/.worktrees/`. Both branch from the
 * freshly fetched `origin/main`. Commands run as argv, never through a shell. A worktree that already
 * has the item's branch is reused, so a retry after a failed open never makes a second one.
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';

import { checkoutKey, isInsideRepo } from './workItemScheduler.js';

/** A worktree the squad created for one editing item. */
export interface SquadWorktree {
  readonly path: string;
  readonly branch: string;
}

/** The outcome of one external command. A program that failed to start reads as code 1. */
export interface CommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs one program with argv in `cwd`, giving up after `timeoutMs`. Never rejects. */
export type CommandRunner = (
  file: string,
  argv: readonly string[],
  cwd: string,
  timeoutMs: number,
) => Promise<CommandResult>;

export interface SquadWorktreeOptions {
  /** The repo the item works in; the worktree is made from it. */
  readonly repo: string;
  /** The folder root. The worktree must sit inside it, or the board cannot open a session there. */
  readonly folderRoot: string;
  /** The first eight characters of the item id: part of the worktree and branch names. */
  readonly shortId: string;
  /** Full path of git-wt when it is installed; undefined means plain git. */
  readonly gitWt: string | undefined;
  readonly run: CommandRunner;
}

const FETCH_TIMEOUT_MS = 120_000;
/** git-wt may run the user's hooks, such as an install step, so it gets the longest wait. */
const WORKTREE_TIMEOUT_MS = 300_000;
const LIST_TIMEOUT_MS = 30_000;

/**
 * Makes or reuses the worktree for one editing item. Throws with the reason when git fails or the
 * worktree lands outside the folder; the caller keeps the item queued and tries again.
 */
export async function createSquadWorktree(options: SquadWorktreeOptions): Promise<SquadWorktree> {
  const { repo, run, folderRoot } = options;
  const branch =
    options.gitWt === undefined ? `squad/${options.shortId}` : `squad-${options.shortId}`;
  requireOk(await run('git', ['fetch', 'origin'], repo, FETCH_TIMEOUT_MS), 'git fetch origin');
  const path =
    worktreeOnBranch(await listWorktrees(repo, run), branch) ??
    (await addWorktree(options, branch));
  // git-wt puts a repo's worktrees in the sibling `<repo>.worktrees`. When the folder is that repo
  // itself, the sibling belongs to the folder too (folderScope.inFolder applies the same rule);
  // for a repo inside the folder, the worktree must land inside the folder.
  const folderIsRepo = checkoutKey(repo) === checkoutKey(folderRoot);
  const sibling = `${folderRoot.replace(/[\\/]+$/, '')}.worktrees`;
  if (!isInsideRepo(path, folderRoot) && !(folderIsRepo && isInsideRepo(path, sibling))) {
    throw new Error(`worktree nằm ngoài thư mục của đội (${path})`);
  }
  return { path, branch };
}

/** Makes the worktree with git-wt when it is installed, otherwise with plain git. */
async function addWorktree(options: SquadWorktreeOptions, branch: string): Promise<string> {
  const { repo, run, gitWt } = options;
  if (gitWt !== undefined) {
    const switched = await run(
      gitWt,
      ['switch', '-c', branch, '--base', 'origin/main', '--no-cd', '-y'],
      repo,
      WORKTREE_TIMEOUT_MS,
    );
    requireOk(switched, 'git-wt switch');
    const path = worktreeOnBranch(await listWorktrees(repo, run), branch);
    if (path === undefined) throw new Error('git-wt chạy xong nhưng không thấy worktree của nhánh');
    return path;
  }
  const path = join(repo, '.worktrees', `squad-${options.shortId}`);
  const added = await run(
    'git',
    ['worktree', 'add', '-b', branch, path, 'origin/main'],
    repo,
    WORKTREE_TIMEOUT_MS,
  );
  requireOk(added, 'git worktree add');
  return path;
}

async function listWorktrees(repo: string, run: CommandRunner): Promise<string> {
  const listed = await run('git', ['worktree', 'list', '--porcelain'], repo, LIST_TIMEOUT_MS);
  requireOk(listed, 'git worktree list');
  return listed.stdout;
}

/**
 * The path of the worktree that has `branch` checked out, read from `git worktree list --porcelain`.
 * Undefined when no worktree has it.
 */
export function worktreeOnBranch(porcelain: string, branch: string): string | undefined {
  let path: string | undefined;
  for (const line of porcelain.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) path = line.slice('worktree '.length);
    else if (line === `branch refs/heads/${branch}` && path !== undefined) return path;
    else if (line === '') path = undefined;
  }
  return undefined;
}

/**
 * Full path of a program on PATH, or undefined. On Windows the name gets `.exe`. No shell is used
 * to run it, so a `.cmd` shim is not picked up.
 */
export function findOnPath(
  name: string,
  pathValue: string | undefined = process.env.PATH,
  exists: (path: string) => boolean = existsSync,
): string | undefined {
  const suffix = process.platform === 'win32' ? '.exe' : '';
  for (const dir of (pathValue ?? '').split(delimiter)) {
    if (dir === '') continue;
    const candidate = join(dir, `${name}${suffix}`);
    if (exists(candidate)) return candidate;
  }
  return undefined;
}

/** The production runner: execFile with argv, no shell, output captured as text. */
export function runCommand(
  file: string,
  argv: readonly string[],
  cwd: string,
  timeoutMs: number,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile(
      file,
      [...argv],
      { cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ code: 0, stdout, stderr });
          return;
        }
        const code = typeof error.code === 'number' ? error.code : 1;
        resolve({ code, stdout, stderr: stderr || error.message });
      },
    );
  });
}

/** Throws with the first line of git's own error when a command failed. */
function requireOk(result: CommandResult, what: string): void {
  if (result.code === 0) return;
  const output = (result.stderr.trim() || result.stdout.trim()).split(/\r?\n/)[0] ?? '';
  throw new Error(output === '' ? `${what} lỗi` : `${what} lỗi: ${output}`);
}

/** What a cleanup did: the worktree was removed, or it was refused for the reason named. */
export type WorktreeRemoval = 'removed' | 'dirty' | 'unmerged';

export interface RemoveWorktreeOptions {
  /** The repo the worktree was made from. */
  readonly repo: string;
  readonly worktree: SquadWorktree;
  /** Full path of git-wt when it is installed; undefined means plain git. */
  readonly gitWt: string | undefined;
  readonly run: CommandRunner;
}

/**
 * Removes one squad worktree once nothing in it is lost: no uncommitted change, and its branch is
 * already in origin/main. Never forces. A dirty or unmerged worktree is refused and left as it is.
 */
export async function removeSquadWorktree(
  options: RemoveWorktreeOptions,
): Promise<WorktreeRemoval> {
  const { repo, worktree, gitWt, run } = options;
  const status = await run('git', ['status', '--porcelain'], worktree.path, LIST_TIMEOUT_MS);
  requireOk(status, 'git status');
  if (status.stdout.trim() !== '') return 'dirty';
  const merged = await run(
    'git',
    ['merge-base', '--is-ancestor', worktree.branch, 'origin/main'],
    repo,
    LIST_TIMEOUT_MS,
  );
  // Exit 1 means the branch has commits origin/main lacks; anything else is a failed check.
  if (merged.code === 1) return 'unmerged';
  requireOk(merged, 'git merge-base');
  const removed =
    gitWt === undefined
      ? await run('git', ['worktree', 'remove', worktree.path], repo, LIST_TIMEOUT_MS)
      : await run(gitWt, ['remove', worktree.branch, '-y'], repo, WORKTREE_TIMEOUT_MS);
  requireOk(removed, gitWt === undefined ? 'git worktree remove' : 'git-wt remove');
  return 'removed';
}

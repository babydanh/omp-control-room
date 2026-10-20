import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { LibraryUserError } from '../library/libraryError.js';

const GIT_TIMEOUT_MS = 120_000;

export interface ProjectSessionWorktree {
  readonly path: string;
  readonly branch: string;
}

export type ProjectSessionGitRunner = (
  file: string,
  argv: readonly string[],
  cwd: string,
  timeoutMs: number,
) => Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }>;

/** Create a task-named worktree based on the latest origin/main without touching the main checkout. */
export async function createProjectSessionWorktree(input: {
  readonly repo: string;
  readonly taskName: string;
  readonly run: ProjectSessionGitRunner;
}): Promise<ProjectSessionWorktree> {
  const folder = path.join(path.dirname(input.repo), `${path.basename(input.repo)}.worktrees`);
  await fs.mkdir(folder, { recursive: true });
  const fetched = await input.run('git', ['fetch', 'origin'], input.repo, GIT_TIMEOUT_MS);
  requireSuccess(fetched, 'Không tải được origin/main');
  const slug = taskSlug(input.taskName);
  for (let suffix = 1; suffix < 10_000; suffix += 1) {
    const name = suffix === 1 ? slug : `${slug}-${suffix}`;
    const checkout = path.join(folder, name);
    const branch = `project/${name}`;
    if (await exists(checkout)) continue;
    const branchResult = await input.run('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], input.repo, GIT_TIMEOUT_MS);
    if (branchResult.code === 0) continue;
    const added = await input.run(
      'git', ['worktree', 'add', '-b', branch, checkout, 'origin/main'], input.repo, GIT_TIMEOUT_MS,
    );
    if (added.code === 0) return { path: checkout, branch };
    if (await exists(checkout)) {
      throw new LibraryUserError(`Không tạo được worktree: ${added.stderr.trim() || added.stdout.trim()}`);
    }
    const branchCheck = await input.run('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], input.repo, GIT_TIMEOUT_MS);
    if (branchCheck.code !== 0) {
      throw new LibraryUserError(`Không tạo được worktree: ${added.stderr.trim() || added.stdout.trim()}`);
    }
  }
  throw new LibraryUserError('Không tìm được tên worktree chưa bị trùng.');
}

export function taskSlug(taskName: string): string {
  const slug = taskName
    .normalize('NFKD')
    .replace(/[đĐ]/g, 'd')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('en-US')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return slug || 'viec-moi';
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

function requireSuccess(result: { readonly code: number; readonly stdout: string; readonly stderr: string }, action: string): void {
  if (result.code !== 0) {
    throw new LibraryUserError(`${action}: ${result.stderr.trim() || result.stdout.trim() || `mã ${result.code}`}`);
  }
}

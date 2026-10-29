import type { GitGuardWorktree } from '../../../../core/src/messages.js';

export type WorktreeShelfCategory = 'doing' | 'sleeping' | 'trash';

export interface WorktreeActivity {
  readonly activePaths?: readonly string[];
  readonly activeBranches?: readonly string[];
  readonly activeTaskSlugs?: readonly string[];
  readonly repoPath?: string;
}

function pathKey(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function isWithin(path: string, root: string): boolean {
  const child = pathKey(path);
  const parent = pathKey(root);
  return child === parent || child.startsWith(`${parent}/`);
}

function matchesTaskSlug(path: string, slugs: readonly string[]): boolean {
  const parts = pathKey(path).split('/');
  return slugs.some((slug) =>
    parts.some((part) => part === slug.toLowerCase() || part.endsWith(`-${slug.toLowerCase()}`)),
  );
}

export function classifyWorktreeShelf(
  worktree: GitGuardWorktree,
  activity: WorktreeActivity = {},
): WorktreeShelfCategory {
  const repoPath = activity.repoPath ? pathKey(activity.repoPath) : null;
  const active =
    activity.activePaths?.some(
      (activePath) =>
        isWithin(activePath, worktree.path) ||
        (pathKey(activePath) !== repoPath && isWithin(worktree.path, activePath)),
    ) === true ||
    (worktree.branch !== null && activity.activeBranches?.includes(worktree.branch) === true) ||
    matchesTaskSlug(worktree.path, activity.activeTaskSlugs ?? []);
  if (active) return 'doing';
  if (worktree.prunable) return 'trash';
  const idleMinutes = Number.isFinite(worktree.idleMinutes)
    ? (worktree.idleMinutes ?? 0)
    : worktree.idleDays * 24 * 60;
  if (
    worktree.dirtyKnown === true &&
    worktree.dirty === 0 &&
    worktree.ignored === 0 &&
    worktree.mergedToMain &&
    worktree.unpushed === 0 &&
    idleMinutes >= 60
  )
    return 'trash';
  if (worktree.mergedToMain || worktree.idleDays >= 7) return 'sleeping';
  return 'doing';
}

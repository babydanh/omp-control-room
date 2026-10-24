/**
 * ledgerScope: the folder rules applied to the Cây git view. A folder-mode board shows only
 * the repos, checkouts and unscanned folders in the active folder. DOM-free and React-free.
 */

import type { LedgerView } from '../../../../core/src/messages.js';
import { type FolderFocusInput, inFolderView } from '../folderView.js';

/**
 * The part of a ledger view the folder rules keep. A repo stays when the server tagged it into
 * the view or any of its checkouts is in it, and then keeps only the checkouts in view. All mode,
 * and a board with no folder list yet, return the view itself.
 */
export function scopeLedgerView(view: LedgerView, input: FolderFocusInput): LedgerView {
  if (input.viewMode === 'all' || input.workspaces === null) return view;
  const repos = view.repos.flatMap((repo) => {
    const worktrees = repo.worktrees.filter((worktree) =>
      inFolderView(input, worktree.workspacePath),
    );
    const repoInView = inFolderView(input, repo.workspacePath) || worktrees.length > 0;
    return repoInView ? [{ ...repo, worktrees }] : [];
  });
  const unscannedFolders = view.unscannedFolders.filter((folder) =>
    inFolderView(input, folder.workspacePath),
  );
  return { ...view, repos, unscannedFolders };
}

/** A Project folder the Cây git view can be narrowed to. */
export interface LedgerFolder {
  readonly name: string;
  readonly path: string;
}

/**
 * Keeps only what lives under `roots`: repos, scratch folders, sessions, pending checkouts, and
 * the notices and main writes of those sessions. `null` keeps everything.
 */
export function scopeLedgerToFolders(view: LedgerView, roots: readonly string[] | null): LedgerView {
  if (roots === null) return view;
  const keys = roots.map(pathKey);
  const inside = (value: string | null | undefined): boolean => {
    if (value === null || value === undefined) return false;
    const key = pathKey(value);
    return keys.some((root) => key === root || key.startsWith(`${root}/`));
  };
  const sessions = view.sessions.filter((session) => inside(session.cwd));
  const ids = new Set(sessions.map((session) => session.sessionId));
  return {
    ...view,
    repos: view.repos.filter((repo) => inside(repo.repo) || repo.worktrees.some((worktree) => inside(worktree.path))),
    unscannedFolders: view.unscannedFolders.filter((folder) => inside(folder.path)),
    sessions,
    pending: view.pending.filter((row) => inside(row.checkout)),
    notices: view.notices.filter((notice) => ids.has(notice.toSession) || (notice.fromSession !== null && ids.has(notice.fromSession))),
    mainWrites: view.mainWrites.filter((write) => ids.has(write.sessionId)),
    overlaps: view.overlaps.filter((scan) => inside(scan.repo)),
    mergeBlocks: view.mergeBlocks.filter((block) => inside(block.repo)),
  };
}

/** The ledger writes `V:/a/b`, the Project tree `V:\a\b`: compare separator- and case-blind. */
function pathKey(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

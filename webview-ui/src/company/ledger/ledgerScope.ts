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

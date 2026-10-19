import type { CompanyViewState } from './companyState.js';
import { foldersInView, folderToneIndex, UNTAGGED_FOLDER } from './folderView.js';
import { folderLabelFor } from './workspaces.js';

/**
 * How many colour slots a folder's dot cycles through. Folders reuse the sidebar's project
 * palette (`--company-project-0..4`), so a card's dot matches its folder's tick in the sidebar.
 */
export const FOLDER_TONE_COUNT = 5;

/** The folder a card or attention item belongs to, as the all-folders board labels it. */
export interface FolderIdentity {
  path: string;
  label: string;
  /** The colour slot: `--company-project-<tone>`. */
  tone: number;
}

/** True when the board shows every open folder: all mode, with the server's folder list in hand. */
export function showsAllFolders(state: Pick<CompanyViewState, 'viewMode' | 'workspaces'>): boolean {
  return state.viewMode === 'all' && state.workspaces !== null;
}

/**
 * The folder a session, task, prompt, contract or question belongs to. Null outside all mode,
 * or when the id has no known folder.
 */
export function folderIdentityOf(state: CompanyViewState, id: string): FolderIdentity | null {
  if (!showsAllFolders(state)) return null;
  const path = state.folderOf[id];
  if (path === undefined || path === UNTAGGED_FOLDER) return null;
  return {
    path,
    label: folderLabelFor(state.workspaces, path),
    tone: folderToneIndex(path, FOLDER_TONE_COUNT),
  };
}

/** The labels of the folders in view that are waiting for a fresh snapshot. */
export function foldersWaitingForSnapshot(state: CompanyViewState): string[] {
  return foldersInView(state, Object.keys(state.folders))
    .filter((path) => state.folders[path]?.needsSnapshot === true)
    .map((path) => folderLabelFor(state.workspaces, path));
}

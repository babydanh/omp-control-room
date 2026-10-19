/**
 * folderPrefs: the folder view's remembered choices: the mode the board opens in
 * and the folder new work was last created in. Stored once per webview; a missing
 * or damaged value falls back to the defaults rather than failing the board.
 *
 * The storage is described structurally, so this module needs no DOM lib; the
 * client passes the browser's own localStorage in.
 */

import { type CompanyViewMode, DEFAULT_VIEW_MODE } from './folderView.js';

export interface FolderPrefs {
  viewMode: CompanyViewMode;
  /** The folder new work was last created in or picked; null when none is remembered. */
  lastFolder: string | null;
}

export const FOLDER_PREFS_KEY = 'omp.company.folders';

/** Longer than any path the server reports; a longer stored value is ignored. */
const MAX_FOLDER_PATH_LENGTH = 4096;

/** The part of Storage the folder prefs use; a test passes a plain object. */
export interface FolderPrefsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** The browser's localStorage, or null where the page may not use it. */
export function folderPrefsStorage(): FolderPrefsStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

const DEFAULT_FOLDER_PREFS: FolderPrefs = { viewMode: DEFAULT_VIEW_MODE, lastFolder: null };

/** The prefs the board remembers, or the defaults when none are stored or the value is damaged. */
export function loadFolderPrefs(storage: FolderPrefsStorage | null): FolderPrefs {
  if (storage === null) return DEFAULT_FOLDER_PREFS;
  let raw: string | null;
  try {
    raw = storage.getItem(FOLDER_PREFS_KEY);
  } catch {
    // Storage can be blocked by the browser; the board still opens with the defaults.
    return DEFAULT_FOLDER_PREFS;
  }
  if (raw === null) return DEFAULT_FOLDER_PREFS;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return DEFAULT_FOLDER_PREFS;
  }
  return parseFolderPrefs(parsed);
}

/** Keeps only the fields it knows, each checked; anything else takes its default. */
export function parseFolderPrefs(value: unknown): FolderPrefs {
  if (typeof value !== 'object' || value === null) return DEFAULT_FOLDER_PREFS;
  const record = value as Record<string, unknown>;
  const viewMode = record.viewMode === 'folder' ? 'folder' : DEFAULT_VIEW_MODE;
  const lastFolder =
    typeof record.lastFolder === 'string' &&
    record.lastFolder.trim() !== '' &&
    record.lastFolder.length <= MAX_FOLDER_PATH_LENGTH
      ? record.lastFolder
      : null;
  return { viewMode, lastFolder };
}

/** Writes the prefs; a storage that refuses the write keeps the choice for this session only. */
export function saveFolderPrefs(storage: FolderPrefsStorage | null, prefs: FolderPrefs): void {
  if (storage === null) return;
  try {
    storage.setItem(FOLDER_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Quota or a blocked store: the in-memory choice still holds until the board reloads.
  }
}

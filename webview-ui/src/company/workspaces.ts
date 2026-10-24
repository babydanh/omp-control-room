/**
 * Pure rules behind the folder switcher: how a folder is named and how busy it is.
 */

import type { CompanyWorkspaceEntry } from '../../../core/src/messages.js';
import { folderBasename } from './folderView.js';

/** The folder the server marked active, or null before a list has arrived. */
export function activeWorkspace(
  workspaces: readonly CompanyWorkspaceEntry[] | null,
): CompanyWorkspaceEntry | null {
  return workspaces?.find((entry) => entry.active) ?? null;
}

/**
 * What a folder is called on the board: its display name when it has one, else the last
 * segment of its path. A blank name is no name.
 */
export function folderLabel(entry: { path: string; name?: string }): string {
  const name = entry.name?.trim() ?? '';
  return name === '' ? folderBasename(entry.path) : name;
}

/**
 * The label of the folder at `path` in the server's list. A path the list does not hold, or
 * any path before the list arrives, is named by its basename.
 */
export function folderLabelFor(
  workspaces: readonly CompanyWorkspaceEntry[] | null,
  path: string,
): string {
  const entry = workspaces?.find((candidate) => candidate.path === path);
  return entry === undefined ? folderBasename(path) : folderLabel(entry);
}

/** What a folder is doing, in words. An idle folder reads as idle, never as a count of zero. */
export function workspaceActivity(entry: CompanyWorkspaceEntry): string {
  const parts: string[] = [];
  if (entry.working > 0) parts.push(`đang chạy ${entry.working}`);
  if (entry.waiting > 0) parts.push(`chờ ${entry.waiting}`);
  return parts.length === 0 ? 'rảnh' : parts.join(' · ');
}

/** One folder the composer can send new work to; `open` says the board already has it open. */
export interface ComposerFolderChoice {
  path: string;
  label: string;
  open: boolean;
}

/**
 * The folders new work can go to: every folder the board has open, then every Project folder
 * it has not opened yet, each once (paths compared without case or trailing slash).
 */
export function composerFolderChoices(
  workspaces: readonly CompanyWorkspaceEntry[] | null,
  projectFolders: readonly { path: string; name?: string }[],
): ComposerFolderChoice[] {
  const key = (path: string): string => path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const choices: ComposerFolderChoice[] = [];
  const seen = new Set<string>();
  for (const entry of workspaces ?? []) {
    if (!entry.open || seen.has(key(entry.path))) continue;
    seen.add(key(entry.path));
    choices.push({ path: entry.path, label: folderLabel(entry), open: true });
  }
  for (const folder of projectFolders) {
    if (seen.has(key(folder.path))) continue;
    seen.add(key(folder.path));
    choices.push({ path: folder.path, label: folderLabel(folder), open: false });
  }
  return choices;
}

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

/**
 * Pure rules behind the folder switcher: how a folder is named, how busy it is, and
 * whether choosing a folder needs a server command at all.
 */

import type { CompanyWorkspaceEntry } from '../../../core/src/messages.js';
import { folderBasename } from './folderView.js';

/** Refusal shown when the folder field is submitted empty. */
const BLANK_FOLDER_MESSAGE = 'Hãy nhập đường dẫn thư mục.';

export type WorkspaceOpenPlan =
  { kind: 'refuse'; message: string } | { kind: 'stay' } | { kind: 'open'; path: string };

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

/**
 * What choosing a folder means. A blank entry is refused here, the folder that is already
 * active needs no command, and any other folder is sent to the server as a switch.
 */
export function planWorkspaceOpen(
  workspaces: readonly CompanyWorkspaceEntry[] | null,
  input: string,
): WorkspaceOpenPlan {
  const path = input.trim();
  if (path === '') return { kind: 'refuse', message: BLANK_FOLDER_MESSAGE };
  const active = activeWorkspace(workspaces);
  // Windows folders are case-insensitive and accept either slash, so a retyped path still counts as the active one.
  const comparable = (folder: string): string =>
    folder.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  if (active !== null && comparable(active.path) === comparable(path)) return { kind: 'stay' };
  return { kind: 'open', path };
}

/**
 * folderView: the pure rules behind the board's folder modes. It decides which
 * folders are in view, which one new work targets, and how their company data
 * merges into the one view the components read. DOM-free and React-free.
 *
 * The board keeps each folder's company data apart, keyed by the folder path the
 * server tags it with. The flat fields the components read are a projection of
 * those folders: every open folder in "all" mode, or the active folder alone in
 * "folder" mode. Ids are unique across folders, so merged maps never collide in
 * practice; when they do, the focused folder's copy wins.
 */

import type {
  Attempt,
  CompanyCounters,
  CompanyDiagnostics,
  CompanyPromptSummary,
  CompanyReport,
  CompanySettings,
  Contract,
  Question,
  QuotaSnapshot,
  Task,
  UsageRecord,
  VerificationEvidence,
} from '../../../core/src/company.js';
import type { CompanyWorkspaceEntry } from '../../../core/src/messages.js';
import type { SessionView, TextStreamView } from './companyState.js';

/** `all` shows every open folder merged; `folder` shows only the active one. */
export type CompanyViewMode = 'all' | 'folder';

/** A new board opens showing every folder until the user picks one. */
export const DEFAULT_VIEW_MODE: CompanyViewMode = 'all';

/**
 * The key messages without a folder tag are stored under. A single-folder surface
 * (the VS Code view) sends untagged messages; they form one folder.
 */
export const UNTAGGED_FOLDER = '';

/** The company data one folder owns. The board's flat state is a view over these. */
export interface FolderScope {
  revision: number | null;
  needsSnapshot: boolean;
  settings: CompanySettings | null;
  prompts: CompanyPromptSummary[];
  contracts: Record<string, Contract>;
  tasks: Record<string, Task>;
  sessions: Record<string, SessionView>;
  questions: Record<string, Question>;
  attempts: Record<string, Attempt>;
  evidence: Record<string, VerificationEvidence>;
  reports: Record<string, CompanyReport>;
  /** Keyed by (nativeSessionId, nativeEntryId) so a re-sent entry cannot double count. */
  usage: Record<string, UsageRecord>;
  quotas: Record<string, QuotaSnapshot>;
  counters: CompanyCounters | null;
  diagnostics: CompanyDiagnostics | null;
  streams: Record<string, TextStreamView>;
}

export function emptyFolderScope(): FolderScope {
  return {
    revision: null,
    needsSnapshot: false,
    settings: null,
    prompts: [],
    contracts: {},
    tasks: {},
    sessions: {},
    questions: {},
    attempts: {},
    evidence: {},
    reports: {},
    usage: {},
    quotas: {},
    counters: null,
    diagnostics: null,
    streams: {},
  };
}

/** The folder a server message belongs to: its tag, or the untagged folder. */
export function folderKeyOf(message: { workspacePath?: string }): string {
  return message.workspacePath ?? UNTAGGED_FOLDER;
}

/** What the folder rules read from the board: the mode, the picked folder and the server's list. */
export interface FolderFocusInput {
  viewMode: CompanyViewMode;
  /** The folder the user last picked or created in; used only in `all` mode. */
  focusPath: string | null;
  /** The server's folder list; null until it has sent one. */
  workspaces: readonly CompanyWorkspaceEntry[] | null;
}

/**
 * The folder new work targets, and the one settings and the file browser read.
 * `folder` mode always means the active folder. `all` mode means the picked folder
 * while it is still open, else the active folder, else the first open one.
 * Null when there is no folder list (a single-folder surface sends no folder).
 */
export function focusFolder(input: FolderFocusInput): string | null {
  if (input.workspaces === null) return null;
  const open = input.workspaces.filter((entry) => entry.open);
  const active = open.find((entry) => entry.active)?.path ?? null;
  if (input.viewMode === 'folder') return active;
  const picked = input.focusPath;
  if (picked !== null && open.some((entry) => entry.path === picked)) return picked;
  return active ?? open[0]?.path ?? null;
}

/**
 * The folder keys whose data the board shows, in the server's list order. With no
 * folder list every held folder is shown, since there is nothing to filter by.
 */
export function foldersInView(input: FolderFocusInput, folderKeys: readonly string[]): string[] {
  if (input.workspaces === null) return [...folderKeys];
  if (input.viewMode === 'folder') {
    const focus = focusFolder(input);
    return focus !== null && folderKeys.includes(focus) ? [focus] : [];
  }
  return input.workspaces
    .filter((entry) => entry.open && folderKeys.includes(entry.path))
    .map((entry) => entry.path);
}

/**
 * Whether two folder paths name the same folder. Case is ignored, `\` and `/` are one separator,
 * and trailing separators do not count: `D:\Work\App\` names the same folder as `d:/work/app`.
 */
export function samePath(left: string, right: string): boolean {
  const canonicalLeft = left.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const canonicalRight = right.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return canonicalLeft === canonicalRight;
}

/**
 * Whether an item the server tagged with `workspacePath` belongs in the board's view. `all` mode,
 * and a board with no folder list yet, show every item. `folder` mode shows only the active
 * folder's items: an item tagged with no open folder never shows there.
 */
export function inFolderView(input: FolderFocusInput, workspacePath: string | undefined): boolean {
  if (input.viewMode === 'all' || input.workspaces === null) return true;
  const focus = focusFolder(input);
  return focus !== null && workspacePath !== undefined && samePath(workspacePath, focus);
}

/** Shown while the server's folder list has not arrived; folder-scoped commands wait for it. */
export const FOLDER_LIST_LOADING_MESSAGE = 'Đang tải thư mục…';

/**
 * Whether the server's folder list is still on its way. Until it arrives there is no folder
 * to name, so folder-scoped commands are refused rather than sent without one.
 */
export function folderListLoading(state: {
  workspaces: readonly CompanyWorkspaceEntry[] | null;
}): boolean {
  return state.workspaces === null;
}

/** The company data of every folder in view, merged into the one view the board reads. */
export interface MergedFolders extends FolderScope {
  /** Which folder each known session, task, contract, question or prompt belongs to. */
  folderOf: Record<string, string>;
}

/**
 * Merge the folders in view. Scalars (revision, settings, counters, diagnostics)
 * come from the focused folder; `needsSnapshot` is true if any folder is waiting on
 * one; collections are the union. The focused folder merges last, so on a shared id
 * its copy is the one that stays.
 */
export function mergeFolderScopes(
  scopes: readonly { path: string; scope: FolderScope }[],
  focusPath: string | null,
): MergedFolders {
  const focused = scopes.find((entry) => entry.path === focusPath)?.scope ?? null;
  const ordered = [
    ...scopes.filter((entry) => entry.path !== focusPath),
    ...scopes.filter((entry) => entry.path === focusPath),
  ];
  const merged: MergedFolders = {
    revision: focused?.revision ?? null,
    needsSnapshot: scopes.some((entry) => entry.scope.needsSnapshot),
    settings: focused?.settings ?? null,
    prompts: scopes.flatMap((entry) => entry.scope.prompts),
    contracts: {},
    tasks: {},
    sessions: {},
    questions: {},
    attempts: {},
    evidence: {},
    reports: {},
    usage: {},
    quotas: {},
    counters: focused?.counters ?? null,
    diagnostics: focused?.diagnostics ?? null,
    streams: {},
    folderOf: {},
  };
  for (const { path, scope } of ordered) {
    Object.assign(merged.contracts, scope.contracts);
    Object.assign(merged.tasks, scope.tasks);
    Object.assign(merged.sessions, scope.sessions);
    Object.assign(merged.questions, scope.questions);
    Object.assign(merged.attempts, scope.attempts);
    Object.assign(merged.evidence, scope.evidence);
    Object.assign(merged.reports, scope.reports);
    Object.assign(merged.usage, scope.usage);
    Object.assign(merged.quotas, scope.quotas);
    Object.assign(merged.streams, scope.streams);
    for (const id of Object.keys(scope.sessions)) merged.folderOf[id] = path;
    for (const id of Object.keys(scope.tasks)) merged.folderOf[id] = path;
    for (const id of Object.keys(scope.contracts)) merged.folderOf[id] = path;
    for (const id of Object.keys(scope.questions)) merged.folderOf[id] = path;
    for (const prompt of scope.prompts) merged.folderOf[prompt.id] = path;
  }
  return merged;
}

/** The last path segment of a folder, for a label: `D:/work/shop` reads `shop`. */
export function folderBasename(path: string): string {
  const parts = path.split(/[\\/]+/).filter((part) => part !== '');
  return parts[parts.length - 1] ?? path;
}

/**
 * A stable tone index for a folder, so its colour dot is the same on every board
 * open. FNV-1a over the lower-cased, slash-normalised path. Requires toneCount > 0.
 */
export function folderToneIndex(path: string, toneCount: number): number {
  let hash = 0x811c9dc5;
  for (const char of path.replace(/\\/g, '/').toLowerCase()) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % toneCount;
}

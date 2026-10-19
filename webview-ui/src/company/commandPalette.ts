/**
 * commandPalette: the rows the quick-find dialog searches and how a query ranks
 * them. Pure data: the view turns a company state into items, and ranking decides
 * what a query keeps and in which order. Nothing here touches the DOM.
 */

import type { CompanyFileEntry, HerdrAgent, Task } from '../../../core/src/company.js';
import { sleepingName } from './agentSidebarView.js';
import type { CompanyViewState } from './companyState.js';
import { UNTAGGED_FOLDER } from './folderView.js';
import { companyRoleLabel } from './roleProfiles.js';
import { sessionStatusLabel, taskStatusLabel } from './statusLabels.js';
import { folderLabelFor } from './workspaces.js';

export type PaletteGroup = 'action' | 'session' | 'task' | 'herdr' | 'sleeping' | 'folder' | 'file';

export type PaletteActionId =
  | 'new-chat'
  | 'open-agents'
  | 'open-git-tree'
  | 'open-files'
  | 'open-folder'
  | 'show-shortcuts'
  | 'open-usage';

export type PaletteTarget =
  | { kind: 'action'; action: PaletteActionId }
  | { kind: 'session'; sessionId: string }
  | { kind: 'task'; taskId: string }
  | { kind: 'herdr'; paneId: string }
  | { kind: 'sleeping'; paneId: string }
  | { kind: 'folder'; path: string }
  | { kind: 'file'; path: string };

export interface PaletteItem {
  /** Unique within one build, e.g. `session:<id>`, `action:new-chat`. */
  id: string;
  group: PaletteGroup;
  target: PaletteTarget;
  title: string;
  /** Secondary line: folder, role, status, path. May be empty. */
  subtitle: string;
  /** Extra text that matches but is not shown (e.g. session code, branch, role label). */
  keywords: string;
}

export const PALETTE_GROUP_LABELS: Readonly<Record<PaletteGroup, string>> = {
  action: 'Hành động',
  session: 'Phiên',
  task: 'Việc',
  herdr: 'Agent herdr',
  sleeping: 'Phiên ngủ đông',
  folder: 'Thư mục',
  file: 'Tệp',
};

export const PALETTE_GROUP_ORDER: readonly PaletteGroup[] = [
  'action',
  'session',
  'task',
  'herdr',
  'sleeping',
  'folder',
  'file',
];

export const PALETTE_ACTION_LABELS: Readonly<Record<PaletteActionId, string>> = {
  'new-chat': 'Phiên mới',
  'open-agents': 'Mở đàn agent (mô hình theo vai trò)',
  'open-git-tree': 'Mở Cây git',
  'open-files': 'Mở tệp trong workspace',
  'open-folder': 'Mở thư mục…',
  'open-usage': 'Mở trang sử dụng token',
  'show-shortcuts': 'Xem phím tắt',
};

export interface PaletteActionInfo {
  id: PaletteActionId;
  title: string;
  subtitle: string;
  keywords: string;
}

export const PALETTE_ACTIONS: readonly PaletteActionInfo[] = [
  {
    id: 'new-chat',
    title: PALETTE_ACTION_LABELS['new-chat'],
    subtitle: 'Bắt đầu một phiên chat mới trong thư mục đang mở',
    keywords: 'new chat clear phiên mới trò chuyện',
  },
  {
    id: 'open-agents',
    title: PALETTE_ACTION_LABELS['open-agents'],
    subtitle: 'Chọn mô hình cho từng vai trò',
    keywords: 'agents agent model role mô hình vai trò đàn',
  },
  {
    id: 'open-git-tree',
    title: PALETTE_ACTION_LABELS['open-git-tree'],
    subtitle: 'Xem cây nhánh và worktree của dự án',
    keywords: 'git worktree ledger cây nhánh',
  },
  {
    id: 'open-files',
    title: PALETTE_ACTION_LABELS['open-files'],
    subtitle: 'Duyệt các tệp trong thư mục làm việc',
    keywords: 'files file workspace tệp tin duyệt',
  },
  {
    id: 'open-folder',
    title: PALETTE_ACTION_LABELS['open-folder'],
    subtitle: 'Duyệt các thư mục trên máy chủ để chọn một thư mục khác',
    keywords: 'folder directory open thư mục đường dẫn',
  },
  {
    id: 'open-usage',
    title: PALETTE_ACTION_LABELS['open-usage'],
    subtitle: 'Giới hạn tài khoản, lịch sử giới hạn và token đã dùng',
    keywords: 'usage token quota limit giới hạn hạn mức chi phí sử dụng lịch sử',
  },
  {
    id: 'show-shortcuts',
    title: PALETTE_ACTION_LABELS['show-shortcuts'],
    subtitle: 'Danh sách phím tắt của bảng công ty',
    keywords: 'shortcuts keys hotkeys keyboard phím tắt',
  },
];

/** The most file rows one build keeps, so a large workspace cannot flood ranking. */
const FILE_ITEM_CAP = 2000;
/** The row count a query returns when the caller gives no usable limit. */
const DEFAULT_LIMIT = 60;
const SLEEPING_SUBTITLE = 'Phiên ngủ đông';

/**
 * Lowercased, accent-free, single-spaced text: the one form every comparison uses,
 * so a query typed without Vietnamese marks still finds the marked name.
 */
export function normalizeForSearch(text: string): string {
  return (
    text
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      // đ has no decomposition, so NFD leaves it in place and it needs its own mapping.
      .replace(/đ/g, 'd')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

function nonEmpty(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
}

/** Joins the non-blank parts into one keyword string. */
function keywordsOf(...parts: readonly (string | undefined)[]): string {
  return parts
    .map(nonEmpty)
    .filter((part): part is string => part !== null)
    .join(' ');
}

/**
 * The folder a session's row names. Only all mode needs it: a folder-mode board shows one
 * folder, and a session with no folder tag has none to name.
 */
function sessionFolderLabel(state: CompanyViewState, sessionId: string): string | null {
  if (state.viewMode !== 'all') return null;
  const path: string | undefined = state.folderOf[sessionId];
  if (path === undefined || path === UNTAGGED_FOLDER) return null;
  return folderLabelFor(state.workspaces, path);
}

/** The path under the workspace root, or the path itself when it is not under the root. */
function relativeTo(root: string, path: string): string {
  const base = root.replace(/[\\/]+$/, '');
  if (base === '' || !path.startsWith(base)) return path;
  const rest = path.slice(base.length);
  // Require a separator so "/work" does not claim "/work-old/x".
  if (!/^[\\/]/.test(rest)) return path;
  return rest.replace(/^[\\/]+/, '') || path;
}

/** Where a live agent works: its repo and branch, else its folder. */
function herdrSubtitle(agent: HerdrAgent): string {
  const place = [nonEmpty(agent.repo), nonEmpty(agent.branch)].filter(
    (part): part is string => part !== null,
  );
  if (place.length > 0) return place.join(' · ');
  return nonEmpty(agent.cwd) ?? '';
}

function fileItem(entry: CompanyFileEntry, root: string): PaletteItem {
  return {
    id: `file:${entry.path}`,
    group: 'file',
    target: { kind: 'file', path: entry.path },
    title: entry.name,
    subtitle: relativeTo(root, entry.path),
    keywords: entry.path,
  };
}

/**
 * Every row the palette can show for the current state. The first row to claim an
 * id wins, so a repeated id never shadows the real row.
 */
export function buildPaletteItems(
  state: CompanyViewState,
  folder: { activePath: string | null; folders: readonly string[] },
): PaletteItem[] {
  const items: PaletteItem[] = [];
  const claimed = new Set<string>();
  const add = (item: PaletteItem): boolean => {
    if (claimed.has(item.id)) return false;
    claimed.add(item.id);
    items.push(item);
    return true;
  };

  for (const action of PALETTE_ACTIONS) {
    add({
      id: `action:${action.id}`,
      group: 'action',
      target: { kind: 'action', action: action.id },
      title: action.title,
      subtitle: action.subtitle,
      keywords: action.keywords,
    });
  }

  for (const session of Object.values(state.sessions)) {
    const role = companyRoleLabel(session.role);
    const status = sessionStatusLabel(session.status);
    const activeTask: Task | undefined =
      session.activeTaskId === undefined ? undefined : state.tasks[session.activeTaskId];
    const place = sessionFolderLabel(state, session.id);
    const detail = `${session.code} · ${role} · ${status}`;
    add({
      id: `session:${session.id}`,
      group: 'session',
      target: { kind: 'session', sessionId: session.id },
      title: nonEmpty(session.name) ?? session.code,
      subtitle: place === null ? detail : `${place} · ${detail}`,
      keywords: keywordsOf(
        session.code,
        session.role,
        role,
        session.status,
        status,
        activeTask?.title,
      ),
    });
  }

  for (const task of Object.values(state.tasks)) {
    const status = taskStatusLabel(task.status);
    add({
      id: `task:${task.id}`,
      group: 'task',
      target: { kind: 'task', taskId: task.id },
      title: `${task.code} · ${task.title}`,
      subtitle: status,
      keywords: keywordsOf(task.code, task.status, status),
    });
  }

  for (const agent of state.herdr.agents) {
    add({
      id: `herdr:${agent.paneId}`,
      group: 'herdr',
      target: { kind: 'herdr', paneId: agent.paneId },
      // Same name the sidebar draws for the row, so a user finds what they see.
      title: nonEmpty(agent.name) ?? nonEmpty(agent.kind) ?? agent.paneId,
      subtitle: herdrSubtitle(agent),
      keywords: keywordsOf(
        agent.repo,
        agent.branch,
        agent.cwd,
        agent.workspaceLabel,
        agent.title,
        agent.status,
      ),
    });
  }

  for (const entry of state.herdr.sleeping) {
    add({
      id: `sleeping:${entry.paneId}`,
      group: 'sleeping',
      target: { kind: 'sleeping', paneId: entry.paneId },
      title: sleepingName(entry),
      subtitle: SLEEPING_SUBTITLE,
      keywords: keywordsOf(entry.repo, entry.branch, entry.cwd, entry.workspaceLabel),
    });
  }

  for (const path of folder.folders) {
    add({
      id: `folder:${path}`,
      group: 'folder',
      target: { kind: 'folder', path },
      title: folderLabelFor(state.workspaces, path),
      subtitle: path === folder.activePath ? `${path} · đang mở` : path,
      keywords: path,
    });
  }

  const root = state.settings?.workspacePath ?? '';
  let fileCount = 0;
  // Sorted keys make the cap drop the same rows on every build, whatever order
  // the listings arrived in.
  for (const key of Object.keys(state.fileListings).sort()) {
    const listing = state.fileListings[key];
    if (!listing.loaded) continue;
    for (const entry of listing.entries) {
      if (entry.kind !== 'file' || fileCount >= FILE_ITEM_CAP) continue;
      if (add(fileItem(entry, root))) fileCount += 1;
    }
  }

  return items;
}

export interface PaletteMatch {
  item: PaletteItem;
  score: number;
}

// Points a token earns by the strongest tier it reaches. Every title tier outranks
// every detail tier, so a title hit always beats a subtitle or keyword hit.
const TITLE_EXACT = 100;
const TITLE_PREFIX = 80;
const TITLE_WORD_PREFIX = 60;
const TITLE_SUBSTRING = 50;
const TITLE_SUBSEQUENCE = 30;
const DETAIL_SUBSTRING = 20;
const DETAIL_SUBSEQUENCE = 10;
/** One point comes off per this many title characters, so short titles win ties. */
const TITLE_CHARS_PER_POINT = 8;

function groupIndexOf(item: PaletteItem): number {
  return PALETTE_GROUP_ORDER.indexOf(item.group);
}

/** A row normalized once per ranking, not once per token. */
interface SearchDoc {
  item: PaletteItem;
  title: string;
  /** Title split on anything that is not a letter or digit, so `pa-t0001` yields `t0001`. */
  words: readonly string[];
  /** Normalized subtitle and keywords, in that order. */
  details: readonly string[];
  groupIndex: number;
}

function searchDocOf(item: PaletteItem): SearchDoc {
  const title = normalizeForSearch(item.title);
  return {
    item,
    title,
    words: title.split(/[^\p{L}\p{N}]+/u).filter((word) => word !== ''),
    details: [normalizeForSearch(item.subtitle), normalizeForSearch(item.keywords)],
    groupIndex: groupIndexOf(item),
  };
}

/** True when the needle's characters appear in the haystack in order, with gaps allowed. */
function isSubsequence(needle: string, haystack: string): boolean {
  const wanted = [...needle];
  let next = 0;
  for (const ch of haystack) {
    if (next < wanted.length && ch === wanted[next]) next += 1;
  }
  return next === wanted.length;
}

function titleTier(token: string, doc: SearchDoc): number {
  if (doc.title === token) return TITLE_EXACT;
  if (doc.title.startsWith(token)) return TITLE_PREFIX;
  if (doc.words.some((word) => word.startsWith(token))) return TITLE_WORD_PREFIX;
  if (doc.title.includes(token)) return TITLE_SUBSTRING;
  if (isSubsequence(token, doc.title)) return TITLE_SUBSEQUENCE;
  return 0;
}

/** The strongest tier one token reaches in a row, or 0 when it reaches none. */
function tokenScore(token: string, doc: SearchDoc): number {
  const inTitle = titleTier(token, doc);
  if (inTitle > 0) return inTitle;
  if (doc.details.some((detail) => detail.includes(token))) return DETAIL_SUBSTRING;
  if (doc.details.some((detail) => isSubsequence(token, detail))) return DETAIL_SUBSEQUENCE;
  return 0;
}

/** The row's score, or null when some token reaches nothing in it. */
function scoreDoc(tokens: readonly string[], doc: SearchDoc): number | null {
  let total = 0;
  for (const token of tokens) {
    const score = tokenScore(token, doc);
    if (score === 0) return null;
    total += score;
  }
  const penalty = Math.floor(doc.title.length / TITLE_CHARS_PER_POINT);
  return Math.max(0, total - penalty);
}

interface ScoredDoc {
  doc: SearchDoc;
  score: number;
}

function compareText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function compareScored(left: ScoredDoc, right: ScoredDoc): number {
  return (
    right.score - left.score ||
    left.doc.groupIndex - right.doc.groupIndex ||
    compareText(left.doc.title, right.doc.title) ||
    compareText(left.doc.item.id, right.doc.item.id)
  );
}

/**
 * The rows a query keeps, best first. An empty query keeps every row in group
 * order, with input order kept inside each group. A limit that is not a positive
 * integer falls back to the default.
 */
export function rankPaletteItems(
  items: readonly PaletteItem[],
  query: string,
  limit = DEFAULT_LIMIT,
): PaletteMatch[] {
  const cap = Number.isInteger(limit) && limit > 0 ? limit : DEFAULT_LIMIT;
  const tokens = normalizeForSearch(query)
    .split(' ')
    .filter((token) => token !== '');

  if (tokens.length === 0) {
    return [...items]
      .sort((left, right) => groupIndexOf(left) - groupIndexOf(right))
      .slice(0, cap)
      .map((item) => ({ item, score: 0 }));
  }

  const scored: ScoredDoc[] = [];
  for (const item of items) {
    const doc = searchDocOf(item);
    const score = scoreDoc(tokens, doc);
    if (score !== null) scored.push({ doc, score });
  }
  scored.sort(compareScored);
  return scored.slice(0, cap).map(({ doc, score }) => ({ item: doc.item, score }));
}

/**
 * squadView: the squad runs the board shows, as pure rules.
 *
 * A squad run is the server's copy of one team request: its status, its proposal, its progress
 * and its history. The webview names what the server holds and maps each run to a lane; it never
 * decides a run's state. No DOM and no React here, so the rules are tested on their own.
 */

import type {
  CompanyRole,
  OmpAgentInfo,
  SquadDependency,
  SquadEventKind,
  SquadProgress,
  SquadProposal,
  SquadRowInput,
  SquadRun,
  SquadRunStatus,
  WorkItem,
  WorkItemAssignee,
  WorkItemBlocker,
  WorkItemConflicts,
  WorkItemStatus,
} from '../../../core/src/messages.js';
import { SQUAD_DEFAULT_AGENT } from '../../../core/src/squadCompleteness.js';
import {
  graphHasCycle,
  isWorkItemPriority,
  WORK_ITEM_ACCEPTANCE_MAX_CHARS,
  WORK_ITEM_DEPENDS_MAX,
  WORK_ITEM_PRIORITY_DEFAULT,
  WORK_ITEM_PRIORITY_MAX,
  WORK_ITEM_PRIORITY_MIN,
} from '../../../core/src/workItemGraph.js';
import type { AssigneeOption } from './assigneeOptions.js';
import type { CompanyViewState } from './companyState.js';
import type { CompanyLaneId } from './constants.js';
import type { FolderIdentity } from './folderIdentity.js';
import { showsAllFolders } from './folderIdentity.js';
import { foldersInView } from './folderView.js';
import { areasFromText } from './squadPlanCheck.js';
import { isParkedAssignee } from './workItemReviewView.js';
import {
  statusWordVi,
  WORK_ITEM_AREAS_MAX,
  workItemCardHead,
  workItemFolderIdentity,
} from './workItemView.js';

/** Actions available for a run, as pure status rules shared by the board and its tests. */
export function squadRunActions(status: SquadRunStatus): { cancel: boolean; remove: boolean } {
  const finished = status === 'done' || status === 'dismissed' || status === 'stopped' || status === 'failed';
  return { cancel: !finished, remove: finished };
}

/** A folder's squad runs as the server last sent them, with the revision that sent them. */
export interface FolderSquad {
  revision: number;
  runs: SquadRun[];
}

/** Names one squad run. Run ids are unique within a folder, so the folder is part of the name. */
export interface SquadRef {
  runId: string;
  workspacePath: string;
}

/** A squad run the board shows, with the folder it is filed under. */
export interface VisibleSquadRun {
  run: SquadRun;
  workspacePath: string;
  /** The folder's label and tone when the board shows every folder; null in folder mode. */
  folder: FolderIdentity | null;
}

/** A proposal row as the drawer edits it. The key is stable across edits, so focus survives them. */
export interface SquadDraftRow {
  key: string;
  text: string;
  /** The repo the row runs in, by its path; null for the folder root. */
  repo: string | null;
  /** The role the row is filed under; null for none. */
  role: CompanyRole | null;
  /** The omp subagent by catalog name; empty for the default worker. */
  agent: string;
  /** The code areas as typed, comma-separated; parsed when the row is checked or sent. */
  areas: string;
  /** Null while the row has no assignee; the drawer's select sets it. */
  assignee: WorkItemAssignee | null;
  priority: number;
  /** The acceptance text as typed; empty when the row has none. */
  acceptance: string;
  /** The wait list: other rows of this proposal by index, and open work items by #n. */
  dependsOn: SquadDependency[];
}

/** The folder's repos and subagent catalog: the values a proposal row may name. */
export interface SquadCatalog {
  repos: readonly string[];
  agents: readonly OmpAgentInfo[];
}

export type SquadRowsVerdict = { ok: true; rows: SquadRowInput[] } | { ok: false; reason: string };

export type SquadStartVerdict = { ok: true } | { ok: false; reason: string };

/** The most rows one proposal may hold. */
export const SQUAD_MAX_ROWS = 8;

/** The longest row text the server takes, in UTF-8 bytes. */
const SQUAD_ROW_MAX_BYTES = 32768;

const LANE_BY_RUN_STATUS: Readonly<Record<SquadRunStatus, CompanyLaneId | null>> = {
  planning: 'planned',
  proposed: 'planned',
  failed: 'planned',
  working: 'running',
  done: 'done',
  stopped: 'done',
  dismissed: null,
};

const STATUS_WORD_VI: Readonly<Record<SquadRunStatus, string>> = {
  planning: 'Đang lập kế hoạch',
  proposed: 'Chờ duyệt',
  working: 'Đang làm',
  done: 'Xong',
  dismissed: 'Đã bỏ',
  failed: 'Lỗi',
  stopped: 'Đã dừng',
};

const EVENT_LABEL_VI: Readonly<Record<SquadEventKind, string>> = {
  request: 'Yêu cầu',
  turn: 'Lượt',
  proposal: 'Đề xuất',
  approved: 'Đã duyệt',
  review: 'Xem lại',
  done: 'Hoàn tất',
  dismissed: 'Đã bỏ',
  failed: 'Lỗi',
  stopped: 'Đã dừng',
};

/** The lane a run is shown in, or null when the board hides it. The run's status is the only input. */
export function squadLaneFor(run: Pick<SquadRun, 'status'>): CompanyLaneId | null {
  return LANE_BY_RUN_STATUS[run.status];
}

/** A run status in words: the card's status line and the drawer's header. */
export function squadStatusLabel(status: SquadRunStatus): string {
  return STATUS_WORD_VI[status];
}

/** A history event kind in words, for the drawer's history. */
export function squadEventLabel(kind: SquadEventKind): string {
  return EVENT_LABEL_VI[kind];
}

/** The progress chip, `Đội: 2/5 xong`, or null while the run has no task count yet. */
export function progressLabel(progress: SquadProgress): string | null {
  if (progress.total <= 0) return null;
  return `Đội: ${progress.done}/${progress.total} xong`;
}

/** A run's progress as the card shows it: the bar's fill (0–1) and the `n/m` label. */
export interface SquadProgressView {
  done: number;
  total: number;
  fraction: number;
  label: string;
}

/**
 * The progress bar and label for a run. Counts are clamped so the bar stays within 0–1: a total
 * below zero counts as zero, and done is held between zero and the total.
 */
export function squadProgressView(progress: SquadProgress): SquadProgressView {
  const total = Math.max(0, progress.total);
  const done = Math.min(Math.max(0, progress.done), total);
  const fraction = total === 0 ? 0 : done / total;
  return { done, total, fraction, label: `${done}/${total}` };
}

/** The priorities a work item may take, most urgent first: P0 to P3. */
export const PRIORITY_CHOICES: readonly number[] = Array.from(
  { length: WORK_ITEM_PRIORITY_MAX - WORK_ITEM_PRIORITY_MIN + 1 },
  (_, index) => WORK_ITEM_PRIORITY_MIN + index,
);

/**
 * A proposal's rows as editable drafts. A row keeps the key it was proposed with. A row that names
 * the default worker holds an empty agent, which the approval sends as none: the same agent.
 */
export function rowsFromProposal(proposal: SquadProposal): SquadDraftRow[] {
  return proposal.rows.map((row, index) => ({
    key: `${proposal.id}:${index}`,
    text: row.text,
    repo: row.repo ?? null,
    role: row.role ?? null,
    agent: row.agent === undefined || row.agent === SQUAD_DEFAULT_AGENT ? '' : row.agent,
    areas: (row.areas ?? []).join(', '),
    assignee: row.assignee,
    priority: row.priority,
    acceptance: row.acceptance ?? '',
    dependsOn: [...row.dependsOn],
  }));
}

/** A blank row for "Thêm dòng"; the caller gives it a key no other row in the draft holds. */
export function blankDraftRow(key: string): SquadDraftRow {
  return {
    key,
    text: '',
    repo: null,
    role: null,
    agent: '',
    areas: '',
    assignee: null,
    priority: WORK_ITEM_PRIORITY_DEFAULT,
    acceptance: '',
    dependsOn: [],
  };
}

/**
 * Whether a draft can be sent as an approval, and the rows as the server takes them: one to
 * SQUAD_MAX_ROWS rows, each with trimmed text that fits the server's limit, an assignee, a valid
 * priority, acceptance within its limit, at most WORK_ITEM_AREAS_MAX areas, and a wait list that
 * holds. `openSequences` is the set of #n a wait list may name; without it the wait list's items
 * are not checked. `catalog` holds the folder's repos and subagents; without it a row's repo and
 * subagent are not checked against the folder. The reason names the first row that fails, in
 * words the drawer can show. Completeness warnings never refuse a draft.
 */
export function validateRows(
  rows: readonly SquadDraftRow[],
  openSequences?: ReadonlySet<number>,
  catalog?: SquadCatalog,
): SquadRowsVerdict {
  if (rows.length === 0) return { ok: false, reason: 'Cần ít nhất 1 dòng việc.' };
  if (rows.length > SQUAD_MAX_ROWS) {
    return { ok: false, reason: `Tối đa ${SQUAD_MAX_ROWS} dòng việc.` };
  }
  const out: SquadRowInput[] = [];
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    if (row === undefined) continue;
    const label = `Dòng ${index + 1}`;
    const text = row.text.trim();
    if (text === '') return { ok: false, reason: `${label} chưa có nội dung.` };
    if (new TextEncoder().encode(text).length > SQUAD_ROW_MAX_BYTES) {
      return { ok: false, reason: `${label} dài quá 32 KB.` };
    }
    if (row.assignee === null) return { ok: false, reason: `${label} chưa giao cho ai.` };
    if (!isWorkItemPriority(row.priority)) {
      return { ok: false, reason: `${label} có độ ưu tiên không hợp lệ.` };
    }
    const acceptance = row.acceptance.trim();
    if (Array.from(acceptance).length > WORK_ITEM_ACCEPTANCE_MAX_CHARS) {
      return {
        ok: false,
        reason: `${label}: phần "Xong khi" dài quá ${WORK_ITEM_ACCEPTANCE_MAX_CHARS} ký tự.`,
      };
    }
    if (catalog !== undefined && row.repo !== null && !catalog.repos.includes(row.repo)) {
      return { ok: false, reason: `${label}: repo không còn trong thư mục.` };
    }
    if (catalog !== undefined && row.agent !== '') {
      const agent = row.agent;
      if (!catalog.agents.some((entry) => entry.name === agent)) {
        return { ok: false, reason: `${label}: subagent không còn trong thư mục.` };
      }
    }
    const areas = areasFromText(row.areas);
    if (areas.length > WORK_ITEM_AREAS_MAX) {
      return { ok: false, reason: `${label}: tối đa ${WORK_ITEM_AREAS_MAX} vùng.` };
    }
    const waitRefusal = validateRowDependsOn(rows, index, row.dependsOn, openSequences);
    if (waitRefusal !== null) return { ok: false, reason: `${label}: ${waitRefusal}` };
    const sent: SquadRowInput = {
      text,
      assignee: row.assignee,
      priority: row.priority,
      dependsOn: [...row.dependsOn],
    };
    if (acceptance !== '') sent.acceptance = acceptance;
    if (row.repo !== null) sent.repo = row.repo;
    if (row.role !== null) sent.role = row.role;
    if (row.agent !== '') sent.agent = row.agent;
    if (areas.length > 0) sent.areas = areas;
    out.push(sent);
  }
  return { ok: true, rows: out };
}

/** The key a dependency is listed and compared under: its row index, or its #n. */
function dependencyKey(dependency: SquadDependency): string {
  return dependency.kind === 'row'
    ? `row:${dependency.row ?? ''}`
    : `item:${dependency.sequence ?? ''}`;
}

/** The row a dependency names, when it names a row of a proposal of `count` rows; else null. */
function rowTarget(dependency: SquadDependency, count: number): number | null {
  const { row } = dependency;
  if (dependency.kind !== 'row' || row === undefined) return null;
  return Number.isInteger(row) && row >= 0 && row < count ? row : null;
}

/**
 * Why a row's wait list is refused, in words the drawer shows, or null when it holds. `rows` is
 * the whole proposal, so a row can wait only for another row of it. `openSequences` is the set of
 * #n the list may name; when given, an item that is no longer open is refused. Mirrors
 * checkDependsOn for rows: self, out of range, duplicate, too many, and loops.
 */
export function validateRowDependsOn(
  rows: readonly { readonly dependsOn: readonly SquadDependency[] }[],
  rowIndex: number,
  dependsOn: readonly SquadDependency[],
  openSequences?: ReadonlySet<number>,
): string | null {
  if (dependsOn.length > WORK_ITEM_DEPENDS_MAX) {
    return `Chờ tối đa ${WORK_ITEM_DEPENDS_MAX} việc.`;
  }
  const keys = dependsOn.map(dependencyKey);
  if (new Set(keys).size !== keys.length) return 'Mỗi việc chỉ được chờ một lần.';
  for (const dependency of dependsOn) {
    if (dependency.kind === 'row') {
      if (dependency.row === rowIndex) return 'Không thể chờ chính dòng này.';
      if (rowTarget(dependency, rows.length) === null) {
        return 'Chờ một dòng không có trong đề xuất này.';
      }
    } else if (dependency.sequence === undefined) {
      return 'Mục chờ không hợp lệ.';
    } else if (openSequences !== undefined && !openSequences.has(dependency.sequence)) {
      return `Việc #${dependency.sequence} không còn mở.`;
    }
  }
  const closesLoop = graphHasCycle([rowIndex], (node) => {
    const source = node === rowIndex ? dependsOn : (rows[node]?.dependsOn ?? []);
    return source.flatMap((dependency) => {
      const target = rowTarget(dependency, rows.length);
      return target === null ? [] : [target];
    });
  });
  return closesLoop ? 'Các dòng chờ nhau thành vòng lặp.' : null;
}

/** Whether each work item status is still open: the only items a wait list may name. */
const OPEN_WORK_ITEM_STATUS: Readonly<Record<WorkItemStatus, boolean>> = {
  queued: true,
  running: true,
  needs_input: true,
  review: true,
  done: false,
  failed: false,
};

/** The open items of a folder, in #n order: the items a wait list offers. */
export function openItemsOf(items: readonly WorkItem[]): WorkItem[] {
  return items
    .filter((item) => OPEN_WORK_ITEM_STATUS[item.status])
    .sort((a, b) => a.sequence - b.sequence);
}

/** The #n of every open item, for checking a wait list against what is still open. */
export function openSequencesOf(items: readonly WorkItem[]): ReadonlySet<number> {
  return new Set(openItemsOf(items).map((item) => item.sequence));
}

/** A work item in a wait list: `#n · heading`, or just `#n` when its text is blank. */
export function waitItemLabel(item: Pick<WorkItem, 'sequence' | 'text'>): string {
  const head = workItemCardHead(item.text);
  return head === '' ? `#${item.sequence}` : `#${item.sequence} · ${head}`;
}

/** A row in a wait list: `Việc n · heading`, or just `Việc n` when its text is blank. */
function rowLabel(index: number, text: string): string {
  const head = workItemCardHead(text);
  return head === '' ? `Việc ${index + 1}` : `Việc ${index + 1} · ${head}`;
}

/**
 * The draft without one row. A wait for the removed row is dropped, and a wait for a later row
 * moves up by one so it still names the same row.
 */
export function removeDraftRow(rows: readonly SquadDraftRow[], key: string): SquadDraftRow[] {
  const removed = rows.findIndex((row) => row.key === key);
  if (removed < 0) return [...rows];
  return rows
    .filter((_, index) => index !== removed)
    .map((row) => ({
      ...row,
      dependsOn: row.dependsOn.flatMap((dependency) => {
        if (dependency.kind !== 'row' || dependency.row === undefined) return [dependency];
        if (dependency.row === removed) return [];
        return [dependency.row > removed ? { ...dependency, row: dependency.row - 1 } : dependency];
      }),
    }));
}

/**
 * The draft with one dependency added to a row's wait list, or removed when the row already holds
 * it.
 */
export function toggleRowDependency(
  rows: readonly SquadDraftRow[],
  rowIndex: number,
  dependency: SquadDependency,
): SquadDraftRow[] {
  const key = dependencyKey(dependency);
  return rows.map((row, index) => {
    if (index !== rowIndex) return row;
    const held = row.dependsOn.some((entry) => dependencyKey(entry) === key);
    const dependsOn = held
      ? row.dependsOn.filter((entry) => dependencyKey(entry) !== key)
      : [...row.dependsOn, { ...dependency }];
    return { ...row, dependsOn };
  });
}

/** One way a row can wait: another row of the proposal, or an open work item. */
export interface SquadDependencyOption {
  /** Stable across edits: `row:<index>` or `item:<#n>`. */
  key: string;
  label: string;
  dependency: SquadDependency;
  /** Whether the row already waits for it. */
  selected: boolean;
}

/** Why a held wait no option offers: its row is the row itself or gone, or its item is closed. */
function staleLabel(dependency: SquadDependency, rowIndex: number): string {
  if (dependency.kind === 'item') return `#${dependency.sequence ?? '?'} · không còn mở`;
  if (dependency.row === undefined) return 'Mục chờ không hợp lệ';
  if (dependency.row === rowIndex) return `Việc ${rowIndex + 1} · chính dòng này`;
  return `Việc ${dependency.row + 1} · không còn trong đề xuất`;
}

/**
 * The wait list of one row, in order: the other rows of the proposal, then the open items by #n.
 * A held wait that no option offers is listed last, so the drawer can clear it.
 */
export function proposalRowDepsOptions(
  rows: readonly SquadDraftRow[],
  rowIndex: number,
  openItems: readonly WorkItem[],
): SquadDependencyOption[] {
  const held = rows[rowIndex]?.dependsOn ?? [];
  const heldKeys = new Set(held.map(dependencyKey));
  const options: SquadDependencyOption[] = [];
  const offered = new Set<string>();
  const offer = (dependency: SquadDependency, label: string): void => {
    const key = dependencyKey(dependency);
    if (offered.has(key)) return;
    offered.add(key);
    options.push({ key, label, dependency, selected: heldKeys.has(key) });
  };
  rows.forEach((row, index) => {
    if (index !== rowIndex) offer({ kind: 'row', row: index }, rowLabel(index, row.text));
  });
  for (const item of openItemsOf(openItems)) {
    offer({ kind: 'item', sequence: item.sequence }, waitItemLabel(item));
  }
  for (const dependency of held) {
    offer(dependency, staleLabel(dependency, rowIndex));
  }
  return options;
}

/** A wait on one dependency, as the card words it. */
export interface EpicWait {
  text: string;
  /** The dependency's status, or null when the folder no longer holds it. */
  status: WorkItemStatus | null;
}

/** A child item of a squad run, as the run's card lists it. */
export interface EpicChild {
  id: string;
  sequence: number;
  /** The item's heading: its first line. */
  head: string;
  status: WorkItemStatus;
  statusLabel: string;
  /** What holds the item while it waits, as the server reports it; undefined when nothing does. */
  blocker: WorkItemBlocker | undefined;
  /** The overlaps with other open items and the main checkout; undefined when there are none. */
  conflicts: WorkItemConflicts | undefined;
  /** Whether the child's assignee is a parked squad session. */
  parked: boolean;
  waits: EpicWait[];
}

function waitOn(dependency: WorkItem | undefined): EpicWait {
  if (dependency === undefined) return { text: 'Chờ việc đã gỡ', status: null };
  const number = `#${dependency.sequence}`;
  if (dependency.status === 'done') return { text: `${number} xong`, status: 'done' };
  if (dependency.status === 'failed') return { text: `${number} bị lỗi`, status: 'failed' };
  return { text: `Chờ ${number}`, status: dependency.status };
}

/**
 * The child items of a run in #n order, each with its status and what it waits for. A wait reads
 * `Chờ #3` while the dependency is open, `#3 xong` or `#3 bị lỗi` once it is settled, and
 * `Chờ việc đã gỡ` when the folder no longer holds it.
 */
export function epicChildren(
  run: Pick<SquadRun, 'id'>,
  items: readonly WorkItem[],
  parkedSessionIds: readonly string[] = [],
): EpicChild[] {
  const byId = new Map(items.map((item) => [item.id, item] as const));
  return items
    .filter((item) => item.squadRunId === run.id)
    .sort((a, b) => a.sequence - b.sequence)
    .map((item) => ({
      id: item.id,
      sequence: item.sequence,
      head: workItemCardHead(item.text),
      status: item.status,
      statusLabel: statusWordVi(item.status),
      blocker: item.blocker,
      conflicts: item.conflicts,
      parked: isParkedAssignee(item.assignee, parkedSessionIds),
      waits: item.dependsOn.map((id) => waitOn(byId.get(id))),
    }));
}

/**
 * Whether a folder can take a squad request. A squad needs members: an agent or an omp session
 * already in the folder. A folder that offers only a new session has none.
 */
export function canStartSquad(options: readonly AssigneeOption[]): SquadStartVerdict {
  if (options.some((option) => option.group !== 'new')) return { ok: true };
  return { ok: false, reason: 'Thư mục này chưa có agent hay phiên omp nào để lập đội.' };
}

/** A key that names one squad run across every folder. */
export function squadRunKey(ref: SquadRef): string {
  return JSON.stringify([ref.workspacePath, ref.runId]);
}

/** One folder's squad runs; an empty list when the server has sent none for that folder. */
export function squadRunsOf(
  state: Pick<CompanyViewState, 'squad'>,
  workspacePath: string,
): SquadRun[] {
  return state.squad[workspacePath]?.runs ?? [];
}

/** The run a reference names, or undefined when the folder no longer holds it. */
export function findSquadRun(
  state: Pick<CompanyViewState, 'squad'>,
  ref: SquadRef,
): SquadRun | undefined {
  return squadRunsOf(state, ref.workspacePath).find((run) => run.id === ref.runId);
}

/**
 * The squad runs the board shows, in folder order then the server's order. Folder mode shows the
 * active folder's runs; all-folders mode shows every open folder's, each tagged with its folder.
 * A run appears once even if the server sent it twice.
 */
export function visibleSquadRuns(state: CompanyViewState): VisibleSquadRun[] {
  const showAll = showsAllFolders(state);
  const seen = new Set<string>();
  const rows: VisibleSquadRun[] = [];
  for (const workspacePath of foldersInView(state, Object.keys(state.squad))) {
    for (const run of squadRunsOf(state, workspacePath)) {
      const key = squadRunKey({ runId: run.id, workspacePath });
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({
        run,
        workspacePath,
        folder: showAll ? workItemFolderIdentity(state, workspacePath) : null,
      });
    }
  }
  return rows;
}

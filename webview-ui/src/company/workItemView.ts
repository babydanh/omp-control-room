/**
 * workItemView: the work items the board shows, as pure rules.
 *
 * A work item is one task the user hands to one agent: a herdr pane, an omp session on the
 * board, or a new omp chat. The server owns its status, its reason and its history. Nothing
 * here decides a transition; this module only reads them: the lane a status sits in, the words
 * a status is called, who holds the item, where a queued item stands, and which folders' items
 * are in view.
 *
 * DOM-free and React-free, so the board, the card, the drawer and the tests read one set of rules.
 */

import type {
  AgentRole,
  ClaudeCodeStatus,
  CompanyRole,
  OmpAgentInfo,
  SquadSettings,
  WorkItem,
  WorkItemAssignee,
  WorkItemBlocker,
  WorkItemEventKind,
  WorkItemStatus,
} from '../../../core/src/messages.js';
import {
  checkDependsOn,
  compareQueue,
  type DependsOnRefusal,
  WORK_ITEM_DEPENDS_MAX,
} from '../../../core/src/workItemGraph.js';
import type { CompanyViewState, SessionView } from './companyState.js';
import type { CompanyLaneId } from './constants.js';
import { FOLDER_TONE_COUNT, type FolderIdentity, showsAllFolders } from './folderIdentity.js';
import { foldersInView, folderToneIndex } from './folderView.js';
import { folderLabelFor } from './workspaces.js';

/** A folder's work items as the server last sent them, with the revision that sent them. */
export interface FolderWorkItems {
  revision: number;
  items: WorkItem[];
  roles: AgentRole[];
  /** The repos under the folder: git repos and worktrees, as canonical paths. */
  repos: string[];
  /** The omp subagents the folder can run, as the server lists them. */
  agents: OmpAgentInfo[];
  /** The folder's squad settings; null until the server has sent them. */
  settings: SquadSettings | null;
  /** The omp sessions the server reports as parked. An item whose assignee is one shows a badge. */
  parkedSessionIds: string[];
  /** The last Claude Code install and sign-in check the server sent for this folder; null until one arrives. */
  claudeStatus: ClaudeCodeStatus | null;
  /** The MCP server names the user's Claude config defines for this folder, sorted. */
  claudeMcpServers: string[];
}

/** Names one work item. Ids are unique within a folder, so the folder is part of the name. */
export interface WorkItemRef {
  id: string;
  workspacePath: string;
}

/** A work item the board shows, with the folder it is filed under. */
export interface VisibleWorkItem {
  item: WorkItem;
  workspacePath: string;
  /** The folder's label and tone when the board shows every folder; null in folder mode. */
  folder: FolderIdentity | null;
}

/** Longest card heading in characters, counting the ellipsis that cuts a longer one. */
export const WORK_ITEM_HEAD_MAX_CHARS = 140;

/** The name a new omp chat carries until the server opens the session it becomes. */
export const NEW_SESSION_LABEL = 'Phiên omp mới';

/** The label of the option that leaves the agent to be picked when the item runs. */
export const AUTO_ASSIGNEE_LABEL = 'Tự chọn agent';

/** The label of the work item assignee that Claude Code runs. */
export const CLAUDE_ASSIGNEE_LABEL = 'Claude Code';
/** The label of the work item assignee that runs Antigravity CLI. */
export const AGY_ASSIGNEE_LABEL = 'agy (Antigravity)';

/** The roles a work item can be filed under, as the create and assign dialogs offer them. */
export const WORK_ITEM_ROLES: readonly CompanyRole[] = ['chat', 'worker', 'qa', 'advisor', 'judge'];

/** Longest list of code areas one work item carries. */
export const WORK_ITEM_AREAS_MAX = 8;

const LANE_BY_STATUS: Readonly<Record<WorkItemStatus, CompanyLaneId>> = {
  queued: 'ready',
  running: 'running',
  needs_input: 'needs_input',
  review: 'review',
  done: 'done',
  failed: 'failed',
};

const STATUS_WORD_VI: Readonly<Record<string, string>> = {
  queued: 'Xếp hàng',
  running: 'Đang làm',
  needs_input: 'Chờ bạn',
  review: 'Chờ kiểm',
  done: 'Xong',
  failed: 'Lỗi',
};

const EVENT_LABEL_VI: Readonly<Record<string, string>> = {
  created: 'Tạo việc',
  assigned: 'Giao cho',
  queued: 'Xếp hàng',
  dispatched: 'Đã gửi',
  followed_up: 'Gửi tiếp',
  status: 'Trạng thái',
  note: 'Ghi chú',
};

/** The lane a work item's status is shown in. The server's status is the only input. */
export function laneForWorkItem(status: WorkItemStatus): CompanyLaneId {
  return LANE_BY_STATUS[status];
}

/** A status in words: the drawer's status line and the card's tooltip. */
export function statusWordVi(status: WorkItemStatus): string {
  return STATUS_WORD_VI[status] ?? status;
}

/** An event kind in words, for the drawer's history. */
export function workItemEventLabelVi(kind: WorkItemEventKind): string {
  return EVENT_LABEL_VI[kind] ?? kind;
}

/** Whether two assignees name the same agent: the same kind, pane and session. */
export function sameAssignee(left: WorkItemAssignee, right: WorkItemAssignee): boolean {
  return (
    left.kind === right.kind && left.paneId === right.paneId && left.sessionId === right.sessionId
  );
}

/** The first value that is not blank after trimming, trimmed, or null when none is. */
function firstNonBlank(...values: (string | undefined)[]): string | null {
  for (const value of values) {
    const trimmed = value?.trim() ?? '';
    if (trimmed !== '') return trimmed;
  }
  return null;
}

/** What a herdr assignee reads once its pane is gone (the agent exited and herdr closed it). */
export const PANE_CLOSED_LABEL = 'Ô đã đóng';

/**
 * The name an assignee carries on the board. A herdr pane takes its agent's name, then its
 * title, then its pane id; a sleeping pane takes its title; a pane herdr no longer lists reads
 * as closed, not as a bare id like "wA:p0". An omp session takes its own name, then its code;
 * a session the server no longer holds is named as such.
 */
export function assigneeLabel(
  assignee: WorkItemAssignee,
  state: CompanyViewState,
  workspacePath: string,
): string {
  switch (assignee.kind) {
    case 'herdr': {
      const paneId = assignee.paneId ?? '';
      const agent = state.herdrRoster.agents.find((entry) => entry.paneId === paneId);
      const sleeping = state.herdrRoster.sleeping.find((entry) => entry.paneId === paneId);
      if (paneId === '') return 'Agent herdr';
      // An empty roster is herdr not answered yet, not every pane closed.
      if (agent === undefined && sleeping === undefined) {
        return state.herdrRoster.agents.length === 0 ? 'Agent herdr' : PANE_CLOSED_LABEL;
      }
      return firstNonBlank(agent?.name, agent?.title, sleeping?.title) ?? paneId;
    }
    case 'session': {
      const sessionId = assignee.sessionId ?? '';
      const session: SessionView | undefined =
        state.folders[workspacePath]?.sessions[sessionId] ?? state.sessions[sessionId];
      if (session === undefined) return 'Phiên không còn trên bảng';
      return firstNonBlank(session.name) ?? session.code;
    }
    case 'new-session':
      return NEW_SESSION_LABEL;
    case 'auto':
      return AUTO_ASSIGNEE_LABEL;
    case 'claude':
      return CLAUDE_ASSIGNEE_LABEL;
    case 'agy':
      return AGY_ASSIGNEE_LABEL;
  }
}

/** The note shown when an external CLI run was cut short by a board restart. */
export const WORK_ITEM_INTERRUPTED_NOTE =
  'Bị gián đoạn khi board khởi động lại. Gửi tiếp để tiếp tục.';

/** The CLI runs a work item may carry: absent on the server's item, null on a board card. */
interface CliRuns {
  claudeRun?: WorkItem['claudeRun'] | null;
  agyRun?: WorkItem['agyRun'] | null;
}

/** The note for a work item whose Claude Code or agy run was interrupted by a restart. */
export function workItemInterruptedNote(item: CliRuns): string | null {
  return item.claudeRun?.interrupted === true || item.agyRun?.interrupted === true
    ? WORK_ITEM_INTERRUPTED_NOTE
    : null;
}

/** The latest reported progress of a running CLI work item, or null when it has none. */
export function workItemProgressLine(item: CliRuns & Pick<WorkItem, 'status'>): string | null {
  if (item.status !== 'running') return null;
  const progress = (item.agyRun?.progress ?? item.claudeRun?.progress ?? '').trim();
  return progress === '' ? null : progress;
}

/**
 * The 1-based place a queued item holds among the queued items for the same assignee, in the
 * order they were filed. 0 when the item is not queued.
 */
export function queuePosition(item: WorkItem, items: readonly WorkItem[]): number {
  if (item.status !== 'queued') return 0;
  const ahead = items.filter(
    (other) =>
      other.status === 'queued' &&
      other.sequence < item.sequence &&
      sameAssignee(other.assignee, item.assignee),
  ).length;
  return ahead + 1;
}

/** What a queued item waits for, and its place when it is not first: `Chờ X rảnh · thứ n trong hàng`. */
export function queueWaitText(assigneeName: string, position: number): string {
  const wait = `Chờ ${assigneeName} rảnh`;
  return position > 1 ? `${wait} · thứ ${position} trong hàng` : wait;
}

const OPEN_STATUSES: readonly WorkItemStatus[] = ['queued', 'running', 'needs_input', 'review'];

/** Whether a status leaves an item open: queued, running, waiting for the user, or in review. */
export function isOpenWorkItem(status: WorkItemStatus): boolean {
  return OPEN_STATUSES.includes(status);
}

/** A chip a card shows: its words and how loud they are. */
export interface WorkItemChip {
  text: string;
  tone: 'muted' | 'danger';
}

/**
 * The chip a card shows for what holds an item: its kind in words, and how loud it is. Null when
 * nothing holds the item.
 */
export function blockerChip(item: {
  readonly blocker?: WorkItemBlocker | null;
}): WorkItemChip | null {
  const blocker = item.blocker;
  if (blocker === undefined || blocker === null) return null;
  switch (blocker.kind) {
    case 'agent':
      return { text: 'Agent đang bận', tone: 'muted' };
    case 'dependency':
      return { text: 'Chờ việc khác', tone: 'muted' };
    case 'failed':
      return { text: 'Việc lỗi', tone: 'danger' };
    case 'capacity':
      if (blocker.running === undefined || blocker.limit === undefined) {
        return { text: 'Đầy chỗ', tone: 'muted' };
      }
      return { text: `Đầy chỗ ${blocker.running}/${blocker.limit}`, tone: 'muted' };
    case 'area':
      return { text: 'Vùng đang bị giữ', tone: 'muted' };
    case 'no_member':
      return { text: 'Chưa có agent', tone: 'muted' };
    case 'busy_checkout':
      return { text: 'Repo đang bận', tone: 'muted' };
    case 'worktree':
      return { text: 'Chờ worktree', tone: 'muted' };
    case 'repo_full':
      return blocker.running === undefined || blocker.limit === undefined
        ? { text: 'Repo đầy', tone: 'muted' }
        : { text: `Repo đầy ${blocker.running}/${blocker.limit}`, tone: 'muted' };
    case 'pool_full':
      return { text: 'Hết phiên chạy', tone: 'muted' };
    case 'disk_full':
      return { text: 'Chờ ổ đĩa', tone: 'muted' };
  }
}

/**
 * The sentence a card shows under its chip: what the item waits for, in words. Null when nothing
 * holds the item.
 */
export function blockerSentence(blocker: WorkItemBlocker | null | undefined): string | null {
  if (blocker === undefined || blocker === null) return null;
  switch (blocker.kind) {
    case 'agent':
      return 'Chờ agent rảnh để nhận việc.';
    case 'dependency':
      return blocker.sequence === undefined
        ? 'Chờ một việc khác xong.'
        : `Chờ việc #${blocker.sequence} xong.`;
    case 'failed':
      return blocker.sequence === undefined
        ? 'Có việc đang chờ đã bị lỗi. Gỡ chờ hoặc giao lại.'
        : `Việc #${blocker.sequence} bị lỗi. Gỡ chờ hoặc giao lại.`;
    case 'capacity':
      return blocker.running === undefined || blocker.limit === undefined
        ? 'Hết chỗ chạy, chờ có chỗ trống.'
        : `Đang chạy ${blocker.running}/${blocker.limit} việc, chờ có chỗ trống.`;
    case 'area':
      return blocker.area === undefined || blocker.area === ''
        ? 'Vùng code cần có đang có việc khác giữ.'
        : `Vùng ${blocker.area} đang có việc khác giữ.`;
    case 'no_member':
      return 'Thư mục chưa có agent nào để nhận việc này.';
    case 'busy_checkout':
      return blocker.area === undefined || blocker.area === ''
        ? 'Repo của việc này đang có agent làm việc, chờ agent đó rảnh.'
        : `Repo ${blocker.area} đang có agent làm việc, chờ agent đó rảnh.`;
    case 'worktree':
      return blocker.detail === undefined || blocker.detail === ''
        ? 'Chưa tạo được worktree riêng cho việc này, việc vẫn đang chờ.'
        : `Chưa tạo được worktree riêng cho việc này, việc vẫn đang chờ: ${blocker.detail}`;
    case 'pool_full':
      return 'Đã hết phiên chạy của công ty, việc chờ có chỗ trống.';
    case 'repo_full':
      return blocker.running === undefined || blocker.limit === undefined
        ? `Repo ${blocker.area ?? ''} đang đầy, chờ có chỗ trống.`
        : `Repo ${blocker.area ?? ''} đang chạy ${blocker.running}/${blocker.limit} việc, chờ có chỗ trống.`;
    case 'disk_full':
      return blocker.detail ?? 'Ổ đĩa trống chưa đủ để tạo worktree, việc vẫn đang chờ.';
  }
}

/** A repo's short name: the last segment of its path, whichever slash it uses. Empty when none. */
export function repoShortName(path: string): string {
  const segments = path.split(/[\\/]+/).filter((segment) => segment !== '');
  return segments.at(-1) ?? '';
}

/**
 * The code areas an item carries: each trimmed and lowercased, blanks and repeats dropped, and at
 * most WORK_ITEM_AREAS_MAX kept in the order they were given.
 */
export function normalizeAreas(values: readonly string[]): string[] {
  const areas: string[] = [];
  for (const value of values) {
    const area = value.trim().toLowerCase();
    if (area === '' || areas.includes(area)) continue;
    areas.push(area);
    if (areas.length === WORK_ITEM_AREAS_MAX) break;
  }
  return areas;
}

/**
 * The queued items in the order they run: higher priority first, then creation order. The
 * Sẵn sàng lane shows them this way. Returns a new array; the input keeps its order.
 */
export function queueOrder<
  T extends {
    readonly status: WorkItemStatus;
    readonly priority: number;
    readonly sequence: number;
  },
>(items: readonly T[]): T[] {
  return items.filter((entry) => entry.status === 'queued').sort(compareQueue);
}

/** One item a work item waits for, as the drawer and the editor show it. */
export interface WaitingOn {
  id: string;
  /** The dependency's #n; null when the folder no longer holds it. */
  sequence: number | null;
  /** The dependency's heading; empty when the folder no longer holds it. */
  text: string;
  /** The dependency's status; `removed` when the folder no longer holds it. */
  status: WorkItemStatus | 'removed';
}

/** Orders by #n, with an item the folder no longer holds (no #n) last. */
function bySequence(
  left: { readonly sequence: number | null },
  right: { readonly sequence: number | null },
): number {
  return (left.sequence ?? Number.MAX_SAFE_INTEGER) - (right.sequence ?? Number.MAX_SAFE_INTEGER);
}

/**
 * The items a work item waits for, in #n order. A dependency the folder no longer holds stays in
 * the list as `removed`, so the editor can clear it; the server treats it as failed.
 */
export function waitingOn(
  item: { readonly dependsOn: readonly string[] },
  items: readonly WorkItem[],
): WaitingOn[] {
  const byId = new Map(items.map((entry) => [entry.id, entry] as const));
  return item.dependsOn
    .map((id): WaitingOn => {
      const dependency = byId.get(id);
      if (dependency === undefined) return { id, sequence: null, text: '', status: 'removed' };
      return {
        id,
        sequence: dependency.sequence,
        text: workItemCardHead(dependency.text),
        status: dependency.status,
      };
    })
    .sort(bySequence);
}

/** A dependency as one line: `#2 Dựng khung · Xong`, or `Việc đã bị gỡ` when the folder lost it. */
export function waitingOnLabel(entry: WaitingOn): string {
  if (entry.sequence === null || entry.status === 'removed') return 'Việc đã bị gỡ';
  const head = entry.text === '' ? 'Việc chưa có nội dung' : entry.text;
  return `#${entry.sequence} ${head} · ${statusWordVi(entry.status)}`;
}

/**
 * The rows a wait-list editor offers a queued item: every other open item in the folder, plus each
 * item it already waits for, even a closed or removed one, so saving never drops one silently.
 */
export function dependencyChoices(item: WorkItem, items: readonly WorkItem[]): WaitingOn[] {
  const current = waitingOn(item, items);
  const held = new Set(current.map((entry) => entry.id));
  const offered: WaitingOn[] = items
    .filter((entry) => entry.id !== item.id && !held.has(entry.id) && isOpenWorkItem(entry.status))
    .map((entry) => ({
      id: entry.id,
      sequence: entry.sequence,
      text: workItemCardHead(entry.text),
      status: entry.status,
    }));
  return [...current, ...offered].sort(bySequence);
}

/**
 * The refusal for a wait list the editor is about to save, or null when it is acceptable. It runs
 * the server's own check, so the editor says why before it asks.
 */
export function dependencyRefusal(
  item: { readonly id: string },
  nextIds: readonly string[],
  items: readonly WorkItem[],
): DependsOnRefusal | null {
  const dependsOnById = new Map(items.map((entry) => [entry.id, entry.dependsOn] as const));
  return checkDependsOn(item.id, nextIds, (id) => dependsOnById.get(id));
}

/** The sentence the editor shows for a refused wait list. */
export function dependencyRefusalText(refusal: DependsOnRefusal): string {
  switch (refusal) {
    case 'too_many':
      return `Một việc chỉ có thể chờ tối đa ${WORK_ITEM_DEPENDS_MAX} việc.`;
    case 'duplicate':
      return 'Có việc được chọn hai lần.';
    case 'self':
      return 'Việc không thể chờ chính nó.';
    case 'unknown':
      return 'Có việc chờ không còn trong thư mục này. Hãy bỏ chọn việc đó.';
    case 'cycle':
      return 'Việc được chọn đang chờ lại việc này, tạo thành vòng chờ.';
  }
}

/**
 * The card heading: the first non-blank line of the text, trimmed, and cut at
 * WORK_ITEM_HEAD_MAX_CHARS characters with an ellipsis. Empty for blank text.
 */
export function workItemCardHead(text: string): string {
  const line =
    text
      .split(/\r\n|\r|\n/)
      .map((entry) => entry.trim())
      .find((entry) => entry !== '') ?? '';
  const chars = Array.from(line);
  if (chars.length <= WORK_ITEM_HEAD_MAX_CHARS) return line;
  return `${chars.slice(0, WORK_ITEM_HEAD_MAX_CHARS - 1).join('')}…`;
}

/** A key that names one work item across every folder: the same id under two folders is two items. */
export function workItemKey(ref: WorkItemRef): string {
  return JSON.stringify([ref.workspacePath, ref.id]);
}

/** One folder's work items; an empty list when the server has sent none for that folder. */
export function workItemsOf(state: CompanyViewState, workspacePath: string): FolderWorkItems {
  const held: FolderWorkItems | undefined = state.workItems[workspacePath];
  return (
    held ?? {
      revision: 0,
      items: [],
      roles: [],
      repos: [],
      agents: [],
      settings: null,
      parkedSessionIds: [],
      claudeStatus: null,
      claudeMcpServers: [],
    }
  );
}

/** The work item a reference names, or undefined when the folder no longer holds it. */
export function findWorkItem(state: CompanyViewState, ref: WorkItemRef): WorkItem | undefined {
  return workItemsOf(state, ref.workspacePath).items.find((entry) => entry.id === ref.id);
}

/** The description the folder holds for an agent's role, or '' when it holds none. */
export function roleDescriptionFor(
  state: CompanyViewState,
  workspacePath: string,
  agent: WorkItemAssignee,
): string {
  const role = workItemsOf(state, workspacePath).roles.find((entry) =>
    sameAssignee(entry.agent, agent),
  );
  return role?.description ?? '';
}

/** A folder as the board labels it: its name and colour tone, whichever view is shown. */
export function workItemFolderIdentity(
  state: Pick<CompanyViewState, 'workspaces'>,
  workspacePath: string,
): FolderIdentity {
  return {
    path: workspacePath,
    label: folderLabelFor(state.workspaces, workspacePath),
    tone: folderToneIndex(workspacePath, FOLDER_TONE_COUNT),
  };
}

/**
 * The work items the board shows, in folder order then filing order. Folder mode shows the
 * active folder's items; all-folders mode shows every open folder's, each tagged with its
 * folder. An item appears once even if the server sent it twice.
 */
export function visibleWorkItems(state: CompanyViewState): VisibleWorkItem[] {
  const showAll = showsAllFolders(state);
  const seen = new Set<string>();
  const rows: VisibleWorkItem[] = [];
  for (const workspacePath of foldersInView(state, Object.keys(state.workItems))) {
    const items = [...workItemsOf(state, workspacePath).items].sort(
      (left, right) => left.sequence - right.sequence,
    );
    for (const item of items) {
      const key = workItemKey({ id: item.id, workspacePath });
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({
        item,
        workspacePath,
        folder: showAll ? workItemFolderIdentity(state, workspacePath) : null,
      });
    }
  }
  return rows;
}

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
  WorkItem,
  WorkItemAssignee,
  WorkItemEventKind,
  WorkItemStatus,
} from '../../../core/src/messages.js';
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

/**
 * The name an assignee carries on the board. A herdr pane takes its agent's name, then its
 * title, then its pane id; a sleeping pane takes its title. An omp session takes its own name,
 * then its code; a session the server no longer holds is named as such.
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
      return (
        firstNonBlank(agent?.name, agent?.title, sleeping?.title) ??
        (paneId === '' ? 'Agent herdr' : paneId)
      );
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
  }
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
  return held ?? { revision: 0, items: [], roles: [] };
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

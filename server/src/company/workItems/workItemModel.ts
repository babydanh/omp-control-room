/**
 * Work item model: the pure rules behind manual assignment.
 *
 * Nothing here touches the disk, a herdr socket, or a clock. The service owns the
 * side effects. This module decides what a status may become, validates what
 * arrives from the wire or from disk, and words the reasons the board shows.
 */

import type {
  AgentRole,
  HerdrAgent,
  WorkItem,
  WorkItemAssignee,
  WorkItemAssigneeKind,
  WorkItemEvent,
  WorkItemEventKind,
  WorkItemStatus,
  WorkItemVerdict,
} from '../../../../core/src/messages.js';
import {
  closesLoop,
  composePrompt,
  isWorkItemPriority,
  WORK_ITEM_ACCEPTANCE_MAX_CHARS,
  WORK_ITEM_DEPENDS_MAX,
  WORK_ITEM_PRIORITY_DEFAULT,
} from '../../../../core/src/workItemGraph.js';
import { isHerdrPaneId } from '../../herdr/paneId.js';
import { isRecord } from '../typeGuards.js';

/** Longest prompt a work item may carry: the same bytes herdr accepts for one pane prompt. */
export const WORK_ITEM_TEXT_MAX_BYTES = 32 * 1024;
/** Longest role note, in characters, as the contract allows. */
export const ROLE_DESCRIPTION_MAX_CHARS = 1000;
/** Longest result kept on an item, in characters. */
export const WORK_ITEM_RESULT_MAX_CHARS = 8192;
/** Longest reason shown on an item, in characters. */
export const WORK_ITEM_REASON_MAX_CHARS = 2000;
/** Longest message on one history event, in characters. */
export const WORK_ITEM_EVENT_MAX_CHARS = 2000;
/** History events kept per item; the oldest fall off the front. */
export const WORK_ITEM_HISTORY_MAX = 100;
/** Finished items (done or failed) kept per folder; the least recently changed go first. */
export const WORK_ITEM_FINISHED_KEEP = 200;
/**
 * How long a dispatched item may sit with an agent that never looked busy before it counts as
 * finished. An agent that was seen busy and is now free finishes at once.
 */
export const WORK_ITEM_GRACE_MS = 10_000;
/** Non-empty screen lines kept as an item's result. */
export const WORK_ITEM_RESULT_LINES = 12;

/** Vietnamese reasons the board shows. The server owns the wording. */
export const WORK_ITEM_REASON = {
  queued: 'Chờ agent rảnh để nhận việc.',
  needsInputHerdr: 'Agent đang chờ bạn trả lời trong herdr.',
  needsInputSession: 'Phiên omp đang chờ bạn trả lời.',
  review: 'Agent đã dừng. Xem kết quả rồi bấm Xong hoặc Gửi tiếp.',
  herdrGone: 'Agent không còn trong herdr.',
  sessionGone: 'Phiên omp không còn trên bảng.',
  markedFailed: 'Bạn đánh dấu việc này hỏng.',
  openFailed: 'Không mở được phiên omp mới.',
  saveFailed: 'Chưa lưu được việc nên chưa gửi. Board sẽ thử lại.',
  sendFailed: (detail: string): string => `Gửi việc thất bại: ${detail}`,
} as const;

/**
 * A stored item: the wire shape without the server-computed blocker, plus the prompt still owed to
 * the agent and the #n of each item it waits for. `waitSequences` keeps the #n of a dependency
 * that was cancelled, so its dependents can still name it. It never leaves the server as is.
 */
export type StoredWorkItem = Omit<WorkItem, 'blocker'> & {
  pendingPrompt: string;
  waitSequences: Record<string, number>;
};

/** One work item to create, as the service API takes it. */
export interface WorkItemDraft {
  text: string;
  assignee: WorkItemAssignee;
  /** 0–3; absent means P2. */
  priority?: number;
  acceptance?: string;
  /** Ids of existing items this one waits for. */
  dependsOn?: readonly string[];
  /** Indexes into the same batch of drafts that this one waits for (squad rows). */
  dependsOnDrafts?: readonly number[];
}

/** Where a folder's work items and role notes sit on disk. */
export interface WorkItemsFile {
  version: 1;
  revision: number;
  nextSequence: number;
  items: StoredWorkItem[];
  roles: AgentRole[];
}

/** What a persisted file parsed to. `corrupt` means the file existed but was not a usable file. */
export interface ParsedWorkItems {
  file: WorkItemsFile;
  /** Entries dropped because they failed validation. */
  dropped: number;
  corrupt: boolean;
}

/** How the service reads one agent this pass. `unknown` means no decision can be made. */
export type AgentObservation = 'unknown' | 'gone' | 'free' | 'busy' | 'blocked';

type HerdrStatus = HerdrAgent['status'];

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const WORK_ITEM_STATUSES: Record<WorkItemStatus, true> = {
  queued: true,
  running: true,
  needs_input: true,
  review: true,
  done: true,
  failed: true,
};
const ASSIGNEE_KINDS: Record<WorkItemAssigneeKind, true> = {
  herdr: true,
  session: true,
  'new-session': true,
};
const EVENT_KINDS: Record<WorkItemEventKind, true> = {
  created: true,
  assigned: true,
  queued: true,
  dispatched: true,
  followed_up: true,
  status: true,
  note: true,
};

/** A canonical UUID, in either case. */
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

export function isWorkItemStatus(value: unknown): value is WorkItemStatus {
  return typeof value === 'string' && Object.hasOwn(WORK_ITEM_STATUSES, value);
}

function isIsoString(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function nonNegativeInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

/** Whether a value is an assignee the server can act on (herdr pane, session, or new session). */
export function isWorkItemAssignee(value: unknown): value is WorkItemAssignee {
  if (!isRecord(value)) return false;
  if (typeof value.kind !== 'string' || !Object.hasOwn(ASSIGNEE_KINDS, value.kind)) return false;
  if (value.kind === 'herdr') return isHerdrPaneId(value.paneId);
  // Whether the session exists is checked against the live roster when the item is sent.
  if (value.kind === 'session') {
    return (
      typeof value.sessionId === 'string' &&
      value.sessionId.length > 0 &&
      value.sessionId.length <= 200
    );
  }
  return true;
}

/** An assignee with only the fields its kind uses, so stored and compared values stay exact. */
export function normalizeAssignee(assignee: WorkItemAssignee): WorkItemAssignee {
  if (assignee.kind === 'herdr') return { kind: 'herdr', paneId: assignee.paneId ?? '' };
  if (assignee.kind === 'session') return { kind: 'session', sessionId: assignee.sessionId ?? '' };
  return { kind: 'new-session' };
}

/** Stable key for one agent: all items with the same key queue behind one agent. */
export function assigneeKey(assignee: WorkItemAssignee): string {
  if (assignee.kind === 'herdr') return `herdr:${assignee.paneId ?? ''}`;
  if (assignee.kind === 'session') return `session:${assignee.sessionId ?? ''}`;
  return 'new-session';
}

/** Whether an item currently holds its agent: the agent is working on it or waiting on the user. */
export function occupiesAgent(status: WorkItemStatus): boolean {
  return status === 'running' || status === 'needs_input';
}

/** "Gửi tiếp": only a finished-for-now item can get another prompt. */
export function canFollowUp(status: WorkItemStatus): boolean {
  return status === 'review' || status === 'failed';
}

/** Done or failed: the item is over, and counts toward WORK_ITEM_FINISHED_KEEP. */
export function isFinished(status: WorkItemStatus): boolean {
  return status === 'done' || status === 'failed';
}

/** "Giao lại": an item the agent is not working on right now. */
export function canReassign(status: WorkItemStatus): boolean {
  return status === 'queued' || status === 'review' || status === 'failed';
}

/** "Huỷ": only a queued item, never sent, can be removed. */
export function canCancel(status: WorkItemStatus): boolean {
  return status === 'queued';
}

/** A user verdict may move any open item or a failed one to done, or any open item to failed. */
export function canMark(status: WorkItemStatus, verdict: WorkItemVerdict): boolean {
  return status !== 'done' && status !== verdict;
}

/** Herdr status to what the server does about it. `unknown` counts as busy, like `working`. */
export function observeHerdrStatus(status: HerdrStatus): AgentObservation {
  if (status === 'idle' || status === 'done') return 'free';
  if (status === 'blocked') return 'blocked';
  return 'busy';
}

/**
 * Omp session status to what the server does about it. Parked, paused and stopping sessions
 * are not decided either way; a stopped, crashed or archived session counts as gone.
 */
export function observeSessionStatus(status: string): AgentObservation {
  if (status === 'idle') return 'free';
  if (status === 'waiting_input') return 'blocked';
  if (status === 'busy' || status === 'starting') return 'busy';
  if (status === 'stopped' || status === 'crashed' || status === 'archived') return 'gone';
  return 'unknown';
}

/** Refusal for a prompt's text, or null when the text may be sent. */
export function refuseText(text: string): 'empty_text' | 'prompt_too_large' | null {
  if (text.trim() === '') return 'empty_text';
  if (Buffer.byteLength(text, 'utf-8') > WORK_ITEM_TEXT_MAX_BYTES) return 'prompt_too_large';
  return null;
}

/** Trims a text to at most `max` characters, never splitting a code point. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return Array.from(text).slice(0, max).join('');
}

/** A history event, with `message` present only when there is one. */
export function makeEvent(at: string, kind: WorkItemEventKind, message?: string): WorkItemEvent {
  return message === undefined
    ? { at, kind }
    : { at, kind, message: clip(message, WORK_ITEM_EVENT_MAX_CHARS) };
}

/** The wire shape of a stored item: the same fields without the server-only prompt. */
export function toWorkItem(stored: StoredWorkItem): WorkItem {
  const wire: Partial<StoredWorkItem> = {
    ...stored,
    history: [...stored.history],
    dependsOn: [...stored.dependsOn],
  };
  delete wire.pendingPrompt;
  delete wire.waitSequences;
  return wire as WorkItem;
}

/** Validates one stored event. Invalid events are dropped, not repaired. */
function parseEvent(value: unknown): WorkItemEvent | null {
  if (!isRecord(value)) return null;
  if (!isIsoString(value.at)) return null;
  if (typeof value.kind !== 'string' || !Object.hasOwn(EVENT_KINDS, value.kind)) return null;
  if (value.message !== undefined && typeof value.message !== 'string') return null;
  return makeEvent(
    value.at,
    value.kind as WorkItemEventKind,
    typeof value.message === 'string' ? value.message : undefined,
  );
}

/** Validates one stored item. Anything that would break the board's invariants is rejected. */
export function parseStoredItem(value: unknown): StoredWorkItem | null {
  if (!isRecord(value)) return null;
  if (!isUuid(value.id)) return null;
  if (typeof value.text !== 'string' || value.text.trim() === '') return null;
  if (!isWorkItemAssignee(value.assignee)) return null;
  if (!isWorkItemStatus(value.status)) return null;
  const sequence = nonNegativeInt(value.sequence);
  if (sequence === null) return null;
  if (!isIsoString(value.createdAt) || !isIsoString(value.updatedAt)) return null;
  if (value.dispatchedAt !== undefined && !isIsoString(value.dispatchedAt)) return null;
  if (value.reason !== undefined && typeof value.reason !== 'string') return null;
  if (value.result !== undefined && typeof value.result !== 'string') return null;
  if (value.squadRunId !== undefined && !isUuid(value.squadRunId)) return null;
  if (value.acceptance !== undefined && typeof value.acceptance !== 'string') return null;
  // Files from before priorities, waits and criteria read as P2, no waits, no criteria.
  const priority = value.priority === undefined ? WORK_ITEM_PRIORITY_DEFAULT : value.priority;
  if (!isWorkItemPriority(priority)) return null;
  const dependsOn = parseDependsOn(value.dependsOn, value.id);
  if (dependsOn === null) return null;
  const acceptance =
    typeof value.acceptance === 'string'
      ? clip(value.acceptance.trim(), WORK_ITEM_ACCEPTANCE_MAX_CHARS)
      : '';
  const history = Array.isArray(value.history)
    ? value.history.map(parseEvent).filter((event): event is WorkItemEvent => event !== null)
    : [];
  return {
    id: value.id,
    text: value.text,
    assignee: normalizeAssignee(value.assignee),
    status: value.status,
    sequence,
    priority,
    dependsOn,
    waitSequences: parseWaitSequences(value.waitSequences, dependsOn),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    history: history.slice(-WORK_ITEM_HISTORY_MAX),
    pendingPrompt:
      typeof value.pendingPrompt === 'string'
        ? value.pendingPrompt
        : composePrompt(value.text, acceptance),
    ...(acceptance === '' ? {} : { acceptance }),
    ...(typeof value.dispatchedAt === 'string' ? { dispatchedAt: value.dispatchedAt } : {}),
    ...(typeof value.reason === 'string' ? { reason: value.reason } : {}),
    ...(typeof value.result === 'string' ? { result: value.result } : {}),
    ...(typeof value.squadRunId === 'string' ? { squadRunId: value.squadRunId } : {}),
  };
}

/** Validates a stored dependency list: uuids, no duplicates, no self, at most the cap. */
function parseDependsOn(value: unknown, selfId: string): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > WORK_ITEM_DEPENDS_MAX) return null;
  const ids: string[] = [];
  for (const entry of value) {
    if (!isUuid(entry) || entry === selfId || ids.includes(entry)) return null;
    ids.push(entry);
  }
  return ids;
}

/** Keeps the stored #n of each listed dependency; a missing one stays unknown and reads as 0. */
function parseWaitSequences(value: unknown, dependsOn: readonly string[]): Record<string, number> {
  const waits: Record<string, number> = {};
  if (!isRecord(value)) return waits;
  for (const id of dependsOn) {
    const sequence = nonNegativeInt(value[id]);
    if (sequence !== null) waits[id] = sequence;
  }
  return waits;
}

/** Validates one stored role note. */
export function parseRole(value: unknown): AgentRole | null {
  if (!isRecord(value)) return null;
  if (!isWorkItemAssignee(value.agent)) return null;
  if (typeof value.description !== 'string') return null;
  if (Array.from(value.description).length > ROLE_DESCRIPTION_MAX_CHARS) return null;
  if (!isIsoString(value.updatedAt)) return null;
  return {
    agent: normalizeAssignee(value.agent),
    description: value.description,
    updatedAt: value.updatedAt,
  };
}

/** A file with nothing in it: revision zero, no items, no role notes. */
export function emptyWorkItemsFile(): WorkItemsFile {
  return { version: 1, revision: 0, nextSequence: 0, items: [], roles: [] };
}

/**
 * Parses a persisted file. A missing file (`null`) is empty and not corrupt. Entries that fail
 * validation are dropped and counted. A file that is not an object, or has the wrong version, is
 * corrupt: the caller keeps it aside rather than overwrite it.
 */
export function parseWorkItemsFile(raw: unknown): ParsedWorkItems {
  if (raw === null || raw === undefined) {
    return { file: emptyWorkItemsFile(), dropped: 0, corrupt: false };
  }
  if (!isRecord(raw) || raw.version !== 1) {
    return { file: emptyWorkItemsFile(), dropped: 0, corrupt: true };
  }
  let dropped = 0;
  const seen = new Set<string>();
  const items: StoredWorkItem[] = [];
  const rawItems = Array.isArray(raw.items) ? raw.items : [];
  for (const entry of rawItems) {
    const item = parseStoredItem(entry);
    if (item === null || seen.has(item.id)) {
      dropped += 1;
      continue;
    }
    seen.add(item.id);
    items.push(item);
  }
  const roles: AgentRole[] = [];
  const rawRoles = Array.isArray(raw.roles) ? raw.roles : [];
  for (const entry of rawRoles) {
    const role = parseRole(entry);
    if (role === null) {
      dropped += 1;
      continue;
    }
    roles.push(role);
  }
  // A loop from an older build could never be sent: its items would wait on each other forever.
  const byId = new Map(items.map((item) => [item.id, item]));
  for (const item of items) {
    if (!closesLoop(item.id, item.dependsOn, (id) => byId.get(id)?.dependsOn)) continue;
    item.dependsOn = [];
    item.waitSequences = {};
  }
  const highest = items.reduce((max, item) => Math.max(max, item.sequence), -1);
  const revision = nonNegativeInt(raw.revision) ?? 0;
  const nextSequence = Math.max(nonNegativeInt(raw.nextSequence) ?? 0, highest + 1);
  return {
    file: { version: 1, revision, nextSequence, items, roles },
    dropped,
    corrupt: false,
  };
}

/**
 * Work item model: the pure rules behind manual assignment.
 *
 * Nothing here touches the disk, a herdr socket, or a clock. The service owns the
 * side effects. This module decides what a status may become, validates what
 * arrives from the wire or from disk, and words the reasons the board shows.
 */

import type {
  AgentRole,
  CompanyRole,
  HerdrAgent,
  SquadSettings,
  WorkItem,
  WorkItemAgyRun,
  WorkItemAssignee,
  WorkItemAssigneeKind,
  WorkItemClaudeRun,
  WorkItemEvent,
  WorkItemEventKind,
  WorkItemJudge,
  WorkItemJudgeVerdict,
  WorkItemStatus,
  WorkItemVerdict,
} from '../../../../core/src/messages.js';
import {
  closesLoop,
  isWorkItemPriority,
  WORK_ITEM_ACCEPTANCE_MAX_CHARS,
  WORK_ITEM_DEPENDS_MAX,
  WORK_ITEM_PRIORITY_DEFAULT,
} from '../../../../core/src/workItemGraph.js';
import { isHerdrPaneId } from '../../herdr/paneId.js';
import { isRecord } from '../typeGuards.js';
import { isValidAgentName } from './agentCatalog.js';
import { composeDispatchPrompt } from './dispatchPrompt.js';
import { parseSquadSettings, SQUAD_SETTINGS_DEFAULT } from './squadSettings.js';
import { parseDelivery } from './workItemDelivery.js';

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
/**
 * How long a herdr item waits for its agent to write a reply other than the one it had when the
 * item was sent, before the item finishes on what the pane shows.
 */
export const WORK_ITEM_STALE_REPLY_MS = 5 * 60_000;
/** How long a herdr agent may sit idle after a send before the item counts as done, when it was never seen busy. */
export const WORK_ITEM_HERDR_START_MS = 3 * 60_000;
/**
 * How long a queued item waits before the board tries it again when the omp runner pool was full or
 * its isolated worktree could not be created.
 */
export const WORK_ITEM_HOLD_RETRY_MS = 10_000;
/** Longest detail text a blocker carries, as the contract allows. */
export const WORK_ITEM_BLOCKER_DETAIL_MAX_CHARS = 300;
/** Non-empty screen lines kept as an item's result. */
export const WORK_ITEM_RESULT_LINES = 12;
/** Most code areas one work item may lock. */
export const WORK_ITEM_AREAS_MAX = 8;
/** Longest code-area name, in characters. */
export const WORK_ITEM_AREA_MAX_CHARS = 120;
/** Longest repo path a work item may name, in characters. */
export const WORK_ITEM_REPO_MAX_CHARS = 4096;
/** Squad-opened session ids kept per folder; the oldest fall off the front. */
export const SQUAD_SESSIONS_KEPT = 200;

/** The verdicts a judge may return. */
export const JUDGE_VERDICTS: readonly WorkItemJudgeVerdict[] = ['pass', 'fail', 'need_evidence'];
/** The states a judge record may be in, as the board shows them. */
export const JUDGE_STATUSES: readonly WorkItemJudge['status'][] = [
  'running',
  'waiting',
  'verdict',
  'interrupted',
  'error',
];
/** Judge-driven follow-ups one item may get; the verdict after the last one needs the user. */
export const JUDGE_MAX_FOLLOW_UPS = 2;
/** Longest judge reason kept on an item, in characters. */
export const JUDGE_REASON_MAX_CHARS = 2000;
/** Longest judge error kept on an item, in characters. */
export const JUDGE_ERROR_MAX_CHARS = 300;

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
  agentPaneFailed: 'Không mở được agent trong herdr.',
  saveFailed: 'Chưa lưu được việc nên chưa gửi. Board sẽ thử lại.',
  sendFailed: (detail: string): string => `Gửi việc thất bại: ${detail}`,
  claudeInterrupted:
    'Board khởi động lại khi Claude Code đang chạy. Gửi tiếp để chạy tiếp trong cùng phiên.',
  claudeTimeout: 'Claude Code chạy quá lâu nên đã dừng.',
  claudeFailed: (detail: string): string => `Claude Code dừng lỗi: ${detail}`,
} as const;

/**
 * A stored item: the wire shape without the server-computed blocker, plus the prompt still owed to
 * the agent and the #n of each item it waits for. `waitSequences` keeps the #n of a dependency
 * that was cancelled, so its dependents can still name it. It never leaves the server as is.
 */
export type StoredWorkItem = Omit<WorkItem, 'blocker'> & {
  pendingPrompt: string;
  waitSequences: Record<string, number>;
  /** Whether the judge's evidence request was already sent. Never leaves the server. */
  judgeEvidenceAsked?: boolean;
  /** The Claude Code run in flight, if any. Server-only: a restart makes it interrupted. */
  claudeRunId?: string;
  /** The process id of that run, kept so a restart can stop a run that outlived the board. */
  claudeRunPid?: number;
  /** The last time an archived work item was restored to the board. */
  restoredAt?: string;
  /** Run the CLI in `repo` itself instead of allocating an isolated worktree. */
  inPlace?: boolean;
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
  /** Canonical repo path inside the folder; the folder root when absent. */
  repo?: string;
  /** Role the session is opened with, and a matching hint for the scheduler. */
  role?: CompanyRole;
  /** Code areas the item locks while it edits. Normalized; at most WORK_ITEM_AREAS_MAX. */
  areas?: readonly string[];
  /** Omp subagent name the item runs under. */
  agent?: string;
  /** Run this work item directly in its repo checkout without creating or cleaning a worktree. */
  inPlace?: boolean;
}

/** Where a folder's work items and role notes sit on disk. */
export interface WorkItemsFile {
  version: 1;
  revision: number;
  nextSequence: number;
  items: StoredWorkItem[];
  roles: AgentRole[];
  settings: SquadSettings;
  /** Sessions the squad opened, oldest first; used for reuse and the open cap. */
  squadSessionIds: string[];
  /** The repo each squad-opened session was opened for, keyed by session id. */
  squadSessionRepos: Record<string, string>;
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
const ITEM_ROLES: Record<Exclude<CompanyRole, 'director'>, true> = {
  advisor: true,
  worker: true,
  qa: true,
  judge: true,
  chat: true,
};

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
  auto: true,
  claude: true,
  agy: true,
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

/** A role a work item may name: the roles a session runs as. The director leads and is not one. */
export function isItemRole(value: unknown): value is Exclude<CompanyRole, 'director'> {
  return typeof value === 'string' && Object.hasOwn(ITEM_ROLES, value);
}

function isIsoString(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function nonNegativeInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

/** Whether a value is an assignee the server can act on: a member, session, CLI, or automatic choice. */
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
  if (assignee.kind === 'auto') return { kind: 'auto' };
  if (assignee.kind === 'claude') return { kind: 'claude' };
  if (assignee.kind === 'agy') return { kind: 'agy' };
  return { kind: 'new-session' };
}

/** Stable key for one agent: all items with the same key queue behind one agent. */
export function assigneeKey(assignee: WorkItemAssignee): string {
  if (assignee.kind === 'herdr') return `herdr:${assignee.paneId ?? ''}`;
  if (assignee.kind === 'session') return `session:${assignee.sessionId ?? ''}`;
  if (assignee.kind === 'auto') return 'auto';
  if (assignee.kind === 'claude') return 'claude';
  if (assignee.kind === 'agy') return 'agy';
  return 'new-session';
}

/** Whether an item currently holds its agent: the agent is working on it or waiting on the user. */
export function occupiesAgent(status: WorkItemStatus): boolean {
  return status === 'running' || status === 'needs_input';
}

/** "Gửi tiếp" / "Yêu cầu bổ sung": an item the agent is not working on can get another prompt. */
export function canFollowUp(status: WorkItemStatus): boolean {
  // needs_input: the agent or the judge waits on the user, and a follow-up is the user's answer.
  return status === 'review' || status === 'failed' || status === 'needs_input';
}

/** Done or failed: the item is over, and counts toward WORK_ITEM_FINISHED_KEEP. */
export function isFinished(status: WorkItemStatus): boolean {
  return status === 'done' || status === 'failed';
}

/** "Giao lại": an item the agent is not working on right now. */
export function canReassign(status: WorkItemStatus): boolean {
  return status === 'queued' || status === 'review' || status === 'failed';
}

/**
 * "Huỷ"/"Xoá": an item nobody works on can be removed — a queued one never sent, or a finished
 * one (done, failed). Its worktree, if any, stays on disk: "Dọn worktree" is the way to remove it.
 */
export function canCancel(status: WorkItemStatus): boolean {
  return status === 'queued' || status === 'done' || status === 'failed';
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

/**
 * Session status for one assignee. A parked squad session counts as free: a prompt reopens it, so
 * the team reuses it. Any other parked session is not decided, as before.
 */
export function observeAssigneeSession(status: string, squadSession: boolean): AgentObservation {
  if (status === 'parked' && squadSession) return 'free';
  return observeSessionStatus(status);
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

/**
 * Code-area names as the server keeps them: trimmed, lowercase, forward slashes, no trailing slash.
 * Blanks and repeats are dropped; non-string entries are ignored. Callers apply the length and count limits.
 */
export function normalizeAreas(values: readonly unknown[]): string[] {
  const areas: string[] = [];
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const area = value.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    if (area !== '' && !areas.includes(area)) areas.push(area);
  }
  return areas;
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
    areas: [...(stored.areas ?? [])],
  };
  delete wire.pendingPrompt;
  delete wire.waitSequences;
  delete wire.judgeEvidenceAsked;
  delete wire.claudeRunId;
  delete wire.claudeRunPid;
  delete wire.inPlace;
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

/** Validates a stored Claude Code run. A malformed one is dropped, and its item keeps its status. */
function parseClaudeRun(value: unknown): WorkItemClaudeRun | undefined {
  if (!isRecord(value)) return undefined;
  const mode = value.mode === 'edit' || value.mode === 'read' ? value.mode : undefined;
  if (mode === undefined || !isIsoString(value.startedAt)) return undefined;
  if (value.sessionId !== undefined && !isUuid(value.sessionId)) return undefined;
  return {
    mode,
    startedAt: value.startedAt,
    ...(typeof value.sessionId === 'string' ? { sessionId: value.sessionId } : {}),
    ...(value.interrupted === true ? { interrupted: true } : {}),
  };
}

/** Validates a stored Antigravity run. A malformed one is dropped, and its item keeps its status. */
function parseAgyRun(value: unknown): WorkItemAgyRun | undefined {
  if (!isRecord(value)) return undefined;
  const mode = value.mode === 'edit' || value.mode === 'read' ? value.mode : undefined;
  if (mode === undefined || !isIsoString(value.startedAt)) return undefined;
  const pid = nonNegativeInt(value.pid);
  return {
    mode,
    startedAt: value.startedAt,
    ...(pid === null ? {} : { pid }),
    ...(value.interrupted === true ? { interrupted: true } : {}),
  };
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
  if (value.restoredAt !== undefined && !isIsoString(value.restoredAt)) return null;
  if (value.dispatchedAt !== undefined && !isIsoString(value.dispatchedAt)) return null;
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
  const repo =
    typeof value.repo === 'string' &&
    value.repo.trim() !== '' &&
    value.repo.length <= WORK_ITEM_REPO_MAX_CHARS
      ? value.repo.trim()
      : undefined;
  const role = isItemRole(value.role) ? value.role : undefined;
  const areas = Array.isArray(value.areas)
    ? normalizeAreas(value.areas)
        .filter((area) => area.length <= WORK_ITEM_AREA_MAX_CHARS)
        .slice(0, WORK_ITEM_AREAS_MAX)
    : [];
  const agent =
    typeof value.agent === 'string' && isValidAgentName(value.agent) ? value.agent : undefined;
  const worktree = parseWorktree(value.worktree);
  const judge = parseJudge(value.judge);
  const claudeRun = parseClaudeRun(value.claudeRun);
  const agyRun = parseAgyRun(value.agyRun);
  const delivery = parseDelivery(value.delivery);
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
        : composeDispatchPrompt({ text: value.text, acceptance, agent, readOnly: false }),
    ...(acceptance === '' ? {} : { acceptance }),
    ...(typeof value.dispatchedAt === 'string' ? { dispatchedAt: value.dispatchedAt } : {}),
    ...(typeof value.reason === 'string' ? { reason: value.reason } : {}),
    ...(typeof value.result === 'string' ? { result: value.result } : {}),
    ...(typeof value.squadRunId === 'string' ? { squadRunId: value.squadRunId } : {}),
    ...(repo === undefined ? {} : { repo }),
    ...(role === undefined ? {} : { role }),
    areas,
    ...(agent === undefined ? {} : { agent }),
    ...(worktree === undefined ? {} : { worktree }),
    ...(judge === undefined ? {} : { judge }),
    judgeEvidenceAsked: value.judgeEvidenceAsked === true,
    ...(value.worktreeRemoved === true ? { worktreeRemoved: true } : {}),
    ...(delivery === undefined ? {} : { delivery }),
    ...(value.inPlace === true ? { inPlace: true } : {}),
    ...(claudeRun === undefined ? {} : { claudeRun }),
    ...(agyRun === undefined ? {} : { agyRun }),
    ...(typeof value.claudeRunId === 'string' ? { claudeRunId: value.claudeRunId } : {}),
    ...(typeof value.restoredAt === 'string' ? { restoredAt: value.restoredAt } : {}),
    ...(typeof value.claudeRunPid === 'number' ? { claudeRunPid: value.claudeRunPid } : {}),
  };
}

/**
 * Validates a stored judge state. A turn still running when the file was written reads as
 * interrupted: its result is lost, and the user may judge the item again.
 */
function parseJudge(value: unknown): WorkItemJudge | undefined {
  if (!isRecord(value)) return undefined;
  const status = JUDGE_STATUSES.find((entry) => entry === value.status);
  if (status === undefined) return undefined;
  const verdict = JUDGE_VERDICTS.find((entry) => entry === value.verdict);
  const followUps = nonNegativeInt(value.followUps);
  const reason =
    typeof value.reason === 'string' ? clip(value.reason, JUDGE_REASON_MAX_CHARS) : undefined;
  const error =
    typeof value.error === 'string' ? clip(value.error, JUDGE_ERROR_MAX_CHARS) : undefined;
  return {
    status: status === 'running' ? 'interrupted' : status,
    followUps: followUps === null ? 0 : Math.min(followUps, JUDGE_MAX_FOLLOW_UPS),
    ...(verdict === undefined ? {} : { verdict }),
    ...(reason === undefined ? {} : { reason }),
    ...(error === undefined ? {} : { error }),
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

/** Validates a stored isolated worktree: an absolute path and a branch name, or nothing. */
function parseWorktree(value: unknown): { path: string; branch: string } | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.path !== 'string' || value.path.trim() === '') return undefined;
  if (typeof value.branch !== 'string' || value.branch.trim() === '') return undefined;
  if (value.path.length > WORK_ITEM_REPO_MAX_CHARS) return undefined;
  return { path: value.path.trim(), branch: value.branch.trim() };
}

/** Validates one stored role note. */
export function parseRole(value: unknown): AgentRole | null {
  if (!isRecord(value)) return null;
  if (
    !isWorkItemAssignee(value.agent) ||
    value.agent.kind === 'auto' ||
    value.agent.kind === 'claude' ||
    value.agent.kind === 'agy'
  )
    return null;
  if (typeof value.description !== 'string') return null;
  if (Array.from(value.description).length > ROLE_DESCRIPTION_MAX_CHARS) return null;
  if (!isIsoString(value.updatedAt)) return null;
  return {
    agent: normalizeAssignee(value.agent),
    description: value.description,
    updatedAt: value.updatedAt,
  };
}

/** Keeps the well-formed squad-opened session ids, without repeats, the most recent last. */
function parseSquadSessionIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const ids = new Set<string>();
  for (const entry of value) {
    if (typeof entry === 'string' && entry.length > 0 && entry.length <= 200) ids.add(entry);
  }
  return [...ids].slice(-SQUAD_SESSIONS_KEPT);
}

/**
 * Keeps the repo each listed squad session was opened for. An entry for a session not in `ids`, or
 * one that is not a well-formed repo path, is dropped.
 */
function parseSquadSessionRepos(value: unknown, ids: readonly string[]): Record<string, string> {
  const repos: Record<string, string> = {};
  if (!isRecord(value)) return repos;
  for (const id of ids) {
    const repo = value[id];
    if (typeof repo === 'string' && repo.trim() !== '' && repo.length <= WORK_ITEM_REPO_MAX_CHARS) {
      repos[id] = repo.trim();
    }
  }
  return repos;
}

/** A file with nothing in it: revision zero, no items, no role notes. */
export function emptyWorkItemsFile(): WorkItemsFile {
  return {
    version: 1,
    revision: 0,
    nextSequence: 0,
    items: [],
    roles: [],
    settings: { ...SQUAD_SETTINGS_DEFAULT },
    squadSessionIds: [],
    squadSessionRepos: {},
  };
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
  const squadSessionIds = parseSquadSessionIds(raw.squadSessionIds);
  return {
    file: {
      version: 1,
      revision,
      nextSequence,
      items,
      roles,
      settings: parseSquadSettings(raw.settings),
      squadSessionIds,
      squadSessionRepos: parseSquadSessionRepos(raw.squadSessionRepos, squadSessionIds),
    },
    dropped,
    corrupt: false,
  };
}

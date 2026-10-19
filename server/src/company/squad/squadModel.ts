/**
 * Pure rules for the squad leader (Phase 2): limits, the stored shape of a run, the parser for the
 * leader's reply, and the prompt the leader reads. No I/O here, so the service and the runner call
 * these and tests run them directly.
 */

import type {
  SquadDependency,
  SquadEvent,
  SquadEventKind,
  SquadProgress,
  SquadProposal,
  SquadProposalStatus,
  SquadRow,
  SquadRun,
  SquadRunStatus,
  WorkItemAssignee,
} from '../../../../core/src/messages.js';
import {
  graphHasCycle,
  isWorkItemPriority,
  priorityLabel,
  WORK_ITEM_ACCEPTANCE_MAX_CHARS,
  WORK_ITEM_DEPENDS_MAX,
  WORK_ITEM_PRIORITY_DEFAULT,
  WORK_ITEM_PRIORITY_MAX,
} from '../../../../core/src/workItemGraph.js';
import { isRecord } from '../typeGuards.js';
import {
  assigneeKey,
  clip,
  isUuid,
  isWorkItemAssignee,
  normalizeAssignee,
  refuseText,
} from '../workItems/workItemModel.js';

/** Most assignments one leader reply may propose. */
export const SQUAD_MAX_ROWS = 8;
/** Leader turns one run may spend. The turn after the last one stops the run with a notice. */
export const SQUAD_MAX_TURNS = 10;
/** Runs kept per folder. Finished runs go first, the least recently changed first. */
export const SQUAD_RUNS_KEEP = 50;
/** Events kept per run; the oldest fall off the front. */
export const SQUAD_HISTORY_MAX = 60;
/** Longest message on one history event, in characters. */
export const SQUAD_EVENT_MAX_CHARS = 2000;
/** Longest leader note, in characters, as the contract allows. */
export const SQUAD_NOTE_MAX_CHARS = 2000;
/** Longest reason on one proposed row, in characters. */
export const SQUAD_REASON_MAX_CHARS = 500;
/** Longest item text or review text the leader sees, in characters. */
export const SQUAD_CONTEXT_TEXT_MAX_CHARS = 400;
/** Longest result of an item the leader sees, in characters. */
export const SQUAD_CONTEXT_RESULT_MAX_CHARS = 1500;
/** Longest title, repo, or branch of a team member the leader sees, in characters. */
export const SQUAD_CONTEXT_MEMBER_MAX_CHARS = 200;
/** Work items the leader sees per turn; the oldest drop first. */
export const SQUAD_CONTEXT_ITEMS_MAX = 40;
/** Events of the run the leader sees per turn; the oldest drop first. */
export const SQUAD_CONTEXT_EVENTS_MAX = 20;
/** How long one leader turn may take before it is stopped. */
export const SQUAD_TURN_TIMEOUT_MS = 240_000;

/** A herdr pane or an omp session the leader may assign to, as the leader sees it. */
export interface SquadMember {
  /** The id the leader writes: `herdr:<paneId>` or `session:<sessionId>`. */
  readonly ref: string;
  readonly kind: 'herdr' | 'session';
  readonly assignee: WorkItemAssignee;
  readonly label: string;
  readonly status: string;
  readonly repo?: string;
  readonly branch?: string;
  readonly cwd?: string;
  readonly title?: string;
  /** The user's role note for this agent, or '' when there is none. */
  readonly role: string;
  /** Items of this folder still waiting for or holding this agent. */
  readonly queued: number;
}

/** A finished work item the leader has not yet read. */
export interface SquadReview {
  readonly itemId: string;
  /** When the item reached review; with `itemId` it identifies this review. */
  readonly at: string;
  readonly text: string;
  readonly result?: string;
  /** The item's "done when" text, which the leader judges the result against. */
  readonly acceptance?: string;
}

/** One squad run as it is stored. The wire shape is {@link toWireRun}. */
export interface StoredSquadRun {
  readonly id: string;
  readonly request: string;
  /** The finished work item this run asks the leader about, when it started from one. */
  readonly fromWorkItemId?: string;
  status: SquadRunStatus;
  turns: number;
  /** Every proposal, oldest first. The newest one is the run's current proposal. */
  proposals: SquadProposal[];
  /** Finished items the next leader turn reads. A turn removes only the ones it read. */
  pendingReviews: SquadReview[];
  note?: string;
  error?: string;
  history: SquadEvent[];
  readonly createdAt: string;
  updatedAt: string;
}

/** The whole squad file for one folder. */
export interface SquadFile {
  readonly version: 1;
  revision: number;
  runs: StoredSquadRun[];
}

/** What the squad file parsed to. `corrupt` means the file existed but was not usable. */
export interface ParsedSquadFile {
  readonly file: SquadFile;
  /** Runs dropped because they failed validation. */
  readonly dropped: number;
  readonly corrupt: boolean;
}

/** A check's outcome: the value, or the Vietnamese reason it was refused. */
export type Checked<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly message: string };

/**
 * A dependency as the leader or the board writes it: another row of the same proposal by its
 * 0-based index, or an open work item by its `#n`.
 */
export type DependencyRef =
  | { readonly kind: 'row'; readonly row: number }
  | { readonly kind: 'item'; readonly sequence: number };

/** One assignment the leader proposed, after validation. */
export interface LeaderAssignment {
  readonly assignee: WorkItemAssignee;
  readonly text: string;
  readonly reason?: string;
  readonly priority: number;
  readonly acceptance?: string;
  readonly dependsOn: readonly DependencyRef[];
}

/** The leader's reply, after validation. */
export interface LeaderReply {
  readonly assignments: readonly LeaderAssignment[];
  readonly note: string;
  readonly done: boolean;
}

/**
 * One row ready for `WorkItemService.createWorkItems`. `dependsOn` names existing items by id;
 * `dependsOnDrafts` names rows of the same batch by their index in it.
 */
export interface SquadDraft {
  readonly text: string;
  readonly assignee: WorkItemAssignee;
  readonly priority: number;
  readonly acceptance?: string;
  readonly dependsOn: string[];
  readonly dependsOnDrafts: number[];
}

/** The approved rows, checked: the drafts to create, and the rows the proposal keeps. */
export interface SquadApproval {
  readonly drafts: SquadDraft[];
  readonly rows: SquadRow[];
}

/** One item of the run as the leader reads it. */
export interface LeaderItemView {
  /** The item's #n: how the leader waits for it. */
  readonly sequence: number;
  readonly text: string;
  readonly status: string;
  /** The assignee's ref, as the leader wrote it: `herdr:<paneId>`, `session:<id>` or `new-session`. */
  readonly assignee: string;
  readonly priority: number;
  readonly acceptance?: string;
  /** The #n of the items this one waits for. */
  readonly dependsOn: readonly number[];
  readonly result?: string;
}

/** Everything one leader turn reads. */
export interface LeaderPromptInput {
  readonly folderName: string;
  readonly request: string;
  readonly members: readonly SquadMember[];
  readonly items: readonly LeaderItemView[];
  readonly reviews: readonly SquadReview[];
  readonly history: readonly SquadEvent[];
  readonly turn: number;
}

const RUN_STATUSES: readonly SquadRunStatus[] = [
  'planning',
  'proposed',
  'working',
  'done',
  'dismissed',
  'failed',
  'stopped',
];
const PROPOSAL_STATUSES: readonly SquadProposalStatus[] = ['pending', 'approved', 'dismissed'];
const EVENT_KINDS: readonly SquadEventKind[] = [
  'request',
  'turn',
  'proposal',
  'approved',
  'review',
  'done',
  'dismissed',
  'failed',
  'stopped',
];
const REPLY_KEYS: readonly string[] = ['assignments', 'note', 'done'];
const ASSIGNMENT_KEYS: readonly string[] = [
  'assignee',
  'text',
  'reason',
  'priority',
  'acceptance',
  'dependsOn',
];
const NEW_SESSION_REF = 'new-session';
const OPEN_ITEM_STATUSES: Record<string, true> = {
  queued: true,
  running: true,
  needs_input: true,
  review: true,
};
/** A `#n` the leader writes to name an open work item. */
const SEQUENCE_REF = /^#([1-9]\d*)$/;

/** A squad file with no runs. */
export function emptySquadFile(): SquadFile {
  return { version: 1, revision: 0, runs: [] };
}

/** Builds one history event. `message` is clipped and omitted when absent. */
export function squadEvent(at: string, kind: SquadEventKind, message?: string): SquadEvent {
  return message === undefined
    ? { at, kind }
    : { at, kind, message: clip(message, SQUAD_EVENT_MAX_CHARS) };
}

/** Adds an event, drops the oldest past the cap, and moves the run's last change to the event. */
export function appendEvent(run: StoredSquadRun, event: SquadEvent): void {
  run.history.push(event);
  if (run.history.length > SQUAD_HISTORY_MAX) {
    run.history.splice(0, run.history.length - SQUAD_HISTORY_MAX);
  }
  run.updatedAt = event.at;
}

/** Stable key for one review: the same item can reach review again, which is a new review. */
export function reviewKey(review: Pick<SquadReview, 'itemId' | 'at'>): string {
  return `${review.itemId}@${review.at}`;
}

/** The assignee's id as the leader writes it: `herdr:<paneId>`, `session:<id>` or `new-session`. */
export function assigneeRef(assignee: WorkItemAssignee): string {
  return assigneeKey(assignee);
}

/** Whether a work item status still waits for or holds work, so the leader may wait for it. */
export function isOpenItemStatus(status: string): boolean {
  return OPEN_ITEM_STATUSES[status] === true;
}

/**
 * The request a squad run starts with when it starts from a finished item: the item's text, its
 * "done when" line, then its result, trimmed to the leader's result limit.
 */
export function requestFromItem(item: {
  readonly text: string;
  readonly acceptance?: string;
  readonly result?: string;
}): string {
  const parts = [item.text.trim()];
  const acceptance = item.acceptance?.trim() ?? '';
  if (acceptance !== '') parts.push(`Xong khi: ${acceptance}`);
  const result = item.result?.trim() ?? '';
  if (result !== '') parts.push(`Kết quả:\n${clip(result, SQUAD_CONTEXT_RESULT_MAX_CHARS)}`);
  return parts.join('\n\n');
}

/** Counts the items the run's approved proposals created, and how many of them are done. */
export function squadProgress(
  run: StoredSquadRun,
  items: readonly { readonly squadRunId?: string; readonly status: string }[],
): SquadProgress {
  const approved = new Set(
    run.proposals
      .filter((proposal) => proposal.status === 'approved')
      .map((proposal) => proposal.id),
  );
  let total = 0;
  let done = 0;
  for (const item of items) {
    if (item.squadRunId === undefined || !approved.has(item.squadRunId)) continue;
    total += 1;
    if (item.status === 'done') done += 1;
  }
  return { done, total };
}

/** The wire shape of a run: the newest proposal only, with its progress. */
export function toWireRun(run: StoredSquadRun, progress: SquadProgress): SquadRun {
  const wire: SquadRun = {
    id: run.id,
    request: run.request,
    status: run.status,
    turns: run.turns,
    maxTurns: SQUAD_MAX_TURNS,
    progress: { ...progress },
    history: structuredClone(run.history),
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  };
  const latest = run.proposals.at(-1);
  if (latest !== undefined) wire.proposal = structuredClone(latest);
  if (run.note !== undefined) wire.note = run.note;
  if (run.error !== undefined) wire.error = run.error;
  return wire;
}

/** Parses the squad file. A value that is not a squad file at all is `corrupt`; bad runs are dropped. */
export function parseSquadFile(raw: unknown): ParsedSquadFile {
  if (raw === null || raw === undefined) {
    return { file: emptySquadFile(), dropped: 0, corrupt: false };
  }
  if (
    !isRecord(raw) ||
    raw['version'] !== 1 ||
    !isCount(raw['revision']) ||
    !Array.isArray(raw['runs'])
  ) {
    return { file: emptySquadFile(), dropped: 0, corrupt: true };
  }
  const runs: StoredSquadRun[] = [];
  let dropped = 0;
  for (const entry of raw['runs']) {
    const run = parseStoredRun(entry);
    if (run === null) dropped += 1;
    else runs.push(run);
  }
  return { file: { version: 1, revision: raw['revision'], runs }, dropped, corrupt: false };
}

/**
 * Parses the leader's final text. Accepts one JSON object with exactly the keys the prompt asks
 * for, optionally inside one code fence. Anything else is refused and nothing is assigned.
 * `openSequences` holds the #n of the open work items the leader was shown: only those may be
 * waited for.
 */
export function parseLeaderReply(
  output: string,
  members: readonly SquadMember[],
  openSequences: ReadonlySet<number>,
): Checked<LeaderReply> {
  let value: unknown;
  try {
    value = JSON.parse(stripCodeFence(output));
  } catch {
    return { ok: false, message: 'Đội trưởng không trả lời đúng định dạng JSON. Thử lại.' };
  }
  if (!isRecord(value)) {
    return { ok: false, message: 'Đội trưởng không trả lời bằng một đối tượng JSON.' };
  }
  const extra = Object.keys(value).find((key) => !REPLY_KEYS.includes(key));
  if (extra !== undefined) {
    return { ok: false, message: `Đội trưởng trả về trường không hỗ trợ: ${clip(extra, 40)}.` };
  }
  const rawAssignments = value['assignments'];
  const note = value['note'];
  const done = value['done'];
  if (!Array.isArray(rawAssignments)) {
    return { ok: false, message: 'Đội trưởng thiếu danh sách "assignments".' };
  }
  if (typeof note !== 'string') {
    return { ok: false, message: 'Đội trưởng thiếu "note".' };
  }
  if (typeof done !== 'boolean') {
    return { ok: false, message: 'Đội trưởng thiếu "done" (true hoặc false).' };
  }
  if (rawAssignments.length > SQUAD_MAX_ROWS) {
    return {
      ok: false,
      message: `Đội trưởng đề xuất ${rawAssignments.length} việc, tối đa ${SQUAD_MAX_ROWS} việc.`,
    };
  }
  const assignments: LeaderAssignment[] = [];
  for (const [index, entry] of rawAssignments.entries()) {
    const checked = parseAssignment(entry, index, rawAssignments.length, members, openSequences);
    if (!checked.ok) return checked;
    assignments.push(checked.value);
  }
  const loop = refuseLoop(assignments.map((assignment) => assignment.dependsOn));
  if (loop !== null) return { ok: false, message: loop };
  if (done && assignments.length > 0) {
    return { ok: false, message: 'Đội trưởng vừa báo xong vừa giao việc. Chỉ một trong hai.' };
  }
  if (!done && assignments.length === 0) {
    return { ok: false, message: 'Đội trưởng không giao việc nào và chưa báo xong.' };
  }
  return { ok: true, value: { assignments, note: clip(note.trim(), SQUAD_NOTE_MAX_CHARS), done } };
}

/**
 * Checks the rows the board sends back on approval: 1 to {@link SQUAD_MAX_ROWS} rows, each with
 * non-empty text, a valid assignee, and optional priority, acceptance and dependsOn. A row waits for
 * another row by its 0-based index in this list, and for an open item by its `#n`, which
 * `openItemId` resolves to the item's id. Returns the drafts to create and the rows to keep.
 */
export function parseSquadRows(
  value: unknown,
  openItemId: (sequence: number) => string | undefined,
): Checked<SquadApproval> {
  if (!Array.isArray(value) || value.length === 0 || value.length > SQUAD_MAX_ROWS) {
    return { ok: false, message: `Cần từ 1 đến ${SQUAD_MAX_ROWS} việc.` };
  }
  const entries: readonly unknown[] = value;
  const checkedRows: CheckedRow[] = [];
  for (const [index, entry] of entries.entries()) {
    const checked = parseSquadRow(entry, index);
    if (!checked.ok) return checked;
    const refusal = refuseRefs(
      checked.value.dependsOn,
      index + 1,
      index,
      entries.length,
      (sequence) => openItemId(sequence) !== undefined,
    );
    if (refusal !== null) return { ok: false, message: refusal };
    checkedRows.push(checked.value);
  }
  const loop = refuseLoop(checkedRows.map((row) => row.dependsOn));
  if (loop !== null) return { ok: false, message: loop };
  const drafts: SquadDraft[] = [];
  const rows: SquadRow[] = [];
  for (const row of checkedRows) {
    const dependsOnDrafts = row.dependsOn.flatMap((ref) => (ref.kind === 'row' ? [ref.row] : []));
    const dependsOn = row.dependsOn.flatMap((ref): string[] => {
      if (ref.kind === 'row') return [];
      const id = openItemId(ref.sequence);
      return id === undefined ? [] : [id];
    });
    const acceptance = row.acceptance === undefined ? {} : { acceptance: row.acceptance };
    drafts.push({
      text: row.text,
      assignee: row.assignee,
      priority: row.priority,
      ...acceptance,
      dependsOn,
      dependsOnDrafts,
    });
    rows.push({
      text: row.text,
      assignee: row.assignee,
      priority: row.priority,
      ...acceptance,
      dependsOn: row.dependsOn.map(toDependency),
    });
  }
  return { ok: true, value: { drafts, rows } };
}

/** Builds the proposal rows a leader reply becomes, with the reason kept for the user to read. */
export function rowsOf(assignments: readonly LeaderAssignment[]): SquadRow[] {
  return assignments.map((assignment) => ({
    text: assignment.text,
    assignee: normalizeAssignee(assignment.assignee),
    ...(assignment.reason === undefined ? {} : { reason: assignment.reason }),
    priority: assignment.priority,
    ...(assignment.acceptance === undefined ? {} : { acceptance: assignment.acceptance }),
    dependsOn: assignment.dependsOn.map(toDependency),
  }));
}

/** The prompt one leader turn reads: the rules, the reply shape, the team, and the run so far. */
export function buildLeaderPrompt(input: LeaderPromptInput): string {
  const lines: string[] = [
    `You are the squad leader for the project folder "${input.folderName}". The user gave the team the request below. Decide which team members should do which work next, or that the request is finished.`,
    '',
    'Rules:',
    '- You run no tools and do no work yourself. Each assignment is a prompt its assignee will run.',
    '- Assign only to ids listed under "Team", or to "new-session" to open a fresh omp chat in the folder. Never invent an id.',
    '- Give each assignee a self-contained prompt that says what to do and what to report back.',
    '- Optional per assignment: "priority" from 0 (most urgent) to 3 (least), default 2; "acceptance", a short "done when" the result must meet; "dependsOn", the 0-based positions of OTHER assignments in this reply that must finish first, plus "#n" for open work items listed below. Leave out what you do not need.',
    '- Judge each finished result against its "done when" line when it has one.',
    `- Propose at most ${SQUAD_MAX_ROWS} assignments per reply.`,
    '- Write "text", "reason", "acceptance" and "note" in the language of the request.',
    '',
    'Reply with ONLY one JSON object: no text before or after it, no code fence.',
    '{"assignments":[{"assignee":"<id>","text":"<prompt>","reason":"<one short sentence>"}],"note":"<one short sentence for the user>","done":false}',
    'Set "done" to true only when the request is complete, judged from the results below. Then "assignments" must be [].',
    '',
    '## Request',
    input.request,
    '',
    '## Team',
    ...teamLines(input.members),
    '',
    '## Work items of this request',
    ...itemLines(input.items),
    '',
    '## Finished work waiting for your review',
    ...reviewLines(input.reviews),
    '',
    '## Earlier steps',
    ...historyLines(input.history),
    '',
    `This is turn ${input.turn} of ${SQUAD_MAX_TURNS}.`,
  ];
  return lines.join('\n');
}

function parseStoredRun(value: unknown): StoredSquadRun | null {
  if (!isRecord(value)) return null;
  const proposals = parseAll(value['proposals'], parseStoredProposal);
  const pendingReviews = parseAll(value['pendingReviews'], parseReview);
  const history = parseAll(value['history'], parseEvent);
  const id = value['id'];
  const request = value['request'];
  const status = value['status'];
  const turns = value['turns'];
  const fromWorkItemId = value['fromWorkItemId'];
  const note = value['note'];
  const error = value['error'];
  if (
    !isUuid(id) ||
    typeof request !== 'string' ||
    request.trim() === '' ||
    !RUN_STATUSES.includes(status as SquadRunStatus) ||
    !isCount(turns) ||
    proposals === null ||
    pendingReviews === null ||
    history === null ||
    !isTimestamp(value['createdAt']) ||
    !isTimestamp(value['updatedAt']) ||
    (note !== undefined && typeof note !== 'string') ||
    (error !== undefined && typeof error !== 'string') ||
    (fromWorkItemId !== undefined && !isUuid(fromWorkItemId))
  ) {
    return null;
  }
  const run: StoredSquadRun = {
    id,
    request,
    status: status as SquadRunStatus,
    turns,
    proposals,
    pendingReviews,
    history,
    createdAt: value['createdAt'] as string,
    updatedAt: value['updatedAt'] as string,
    ...(typeof fromWorkItemId === 'string' ? { fromWorkItemId } : {}),
  };
  if (typeof note === 'string') run.note = note;
  if (typeof error === 'string') run.error = error;
  return run;
}

function parseStoredProposal(value: unknown): SquadProposal | null {
  if (!isRecord(value)) return null;
  const rows = parseAll(value['rows'], parseRow);
  const id = value['id'];
  const turn = value['turn'];
  const note = value['note'];
  const status = value['status'];
  if (
    !isUuid(id) ||
    !Number.isInteger(turn) ||
    (turn as number) < 1 ||
    typeof note !== 'string' ||
    rows === null ||
    rows.length < 1 ||
    rows.length > SQUAD_MAX_ROWS ||
    !PROPOSAL_STATUSES.includes(status as SquadProposalStatus) ||
    !isTimestamp(value['createdAt'])
  ) {
    return null;
  }
  return {
    id,
    turn: turn as number,
    note,
    rows,
    status: status as SquadProposalStatus,
    createdAt: value['createdAt'] as string,
  };
}

function parseRow(value: unknown): SquadRow | null {
  if (!isRecord(value)) return null;
  const text = value['text'];
  const assignee = value['assignee'];
  const reason = value['reason'];
  const priority = value['priority'];
  const acceptance = value['acceptance'];
  const dependsOn = value['dependsOn'];
  if (typeof text !== 'string' || text.trim() === '') return null;
  if (!isWorkItemAssignee(assignee)) return null;
  if (reason !== undefined && typeof reason !== 'string') return null;
  if (priority !== undefined && !isWorkItemPriority(priority)) return null;
  if (acceptance !== undefined && typeof acceptance !== 'string') return null;
  const refs: DependencyRef[] | null =
    dependsOn === undefined ? [] : parseAll(dependsOn, parseDependencyRef);
  if (refs === null) return null;
  const row: SquadRow = {
    text,
    assignee: normalizeAssignee(assignee),
    priority: isWorkItemPriority(priority) ? priority : WORK_ITEM_PRIORITY_DEFAULT,
    dependsOn: refs.map(toDependency),
  };
  if (typeof reason === 'string') row.reason = reason;
  if (typeof acceptance === 'string') row.acceptance = acceptance;
  return row;
}

function parseReview(value: unknown): SquadReview | null {
  if (!isRecord(value)) return null;
  const itemId = value['itemId'];
  const at = value['at'];
  const text = value['text'];
  const result = value['result'];
  const acceptance = value['acceptance'];
  if (!isUuid(itemId) || !isTimestamp(at) || typeof text !== 'string') return null;
  if (result !== undefined && typeof result !== 'string') return null;
  if (acceptance !== undefined && typeof acceptance !== 'string') return null;
  return {
    itemId,
    at,
    text,
    ...(typeof result === 'string' ? { result } : {}),
    ...(typeof acceptance === 'string' ? { acceptance } : {}),
  };
}

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

/**
 * A dependency as the saved file or the board holds it: `{kind:'row', row}` or
 * `{kind:'item', sequence}`.
 */
function parseDependencyRef(value: unknown): DependencyRef | null {
  if (!isRecord(value)) return null;
  const row = value['row'];
  const sequence = value['sequence'];
  if (value['kind'] === 'row' && isInteger(row) && sequence === undefined) {
    return { kind: 'row', row };
  }
  if (value['kind'] === 'item' && isInteger(sequence) && row === undefined) {
    return { kind: 'item', sequence };
  }
  return null;
}

/** The wire form of a dependency, as a proposal row keeps it. */
function toDependency(ref: DependencyRef): SquadDependency {
  return ref.kind === 'row'
    ? { kind: 'row', row: ref.row }
    : { kind: 'item', sequence: ref.sequence };
}

function parseEvent(value: unknown): SquadEvent | null {
  if (!isRecord(value)) return null;
  const at = value['at'];
  const kind = value['kind'];
  const message = value['message'];
  if (!isTimestamp(at) || !EVENT_KINDS.includes(kind as SquadEventKind)) return null;
  if (message !== undefined && typeof message !== 'string') return null;
  const event: SquadEvent = { at, kind: kind as SquadEventKind };
  if (typeof message === 'string') event.message = message;
  return event;
}

/**
 * Parses every entry of an array with `parse`; null when the value is not an array or any entry
 * fails.
 */
function parseAll<T>(values: unknown, parse: (value: unknown) => T | null): T[] | null {
  if (!Array.isArray(values)) return null;
  const out: T[] = [];
  for (const value of values) {
    const item = parse(value);
    if (item === null) return null;
    out.push(item);
  }
  return out;
}

/**
 * Checks one leader row: its assignee must be a listed member, its text non-empty, and its optional
 * priority, acceptance, dependsOn and reason valid. Dependencies are also checked against the rest
 * of the reply by the caller.
 */
function parseAssignment(
  entry: unknown,
  index: number,
  count: number,
  members: readonly SquadMember[],
  openSequences: ReadonlySet<number>,
): Checked<LeaderAssignment> {
  const position = index + 1;
  if (!isRecord(entry)) {
    return { ok: false, message: `Việc ${position} không phải một đối tượng.` };
  }
  const extra = Object.keys(entry).find((key) => !ASSIGNMENT_KEYS.includes(key));
  if (extra !== undefined) {
    return { ok: false, message: `Việc ${position} có trường không hỗ trợ: ${clip(extra, 40)}.` };
  }
  const ref = entry['assignee'];
  if (typeof ref !== 'string') {
    return { ok: false, message: `Việc ${position} thiếu người nhận.` };
  }
  const assignee = resolveAssignee(ref, members);
  if (assignee === undefined) {
    return {
      ok: false,
      message: `Việc ${position} giao cho "${clip(ref, 80)}", không có trong danh sách thành viên.`,
    };
  }
  const rawText = entry['text'];
  if (typeof rawText !== 'string') {
    return { ok: false, message: `Việc ${position} thiếu nội dung.` };
  }
  const text = rawText.trim();
  const refusal = refuseText(text);
  if (refusal === 'empty_text') {
    return { ok: false, message: `Việc ${position} không có nội dung.` };
  }
  if (refusal === 'prompt_too_large') {
    return { ok: false, message: `Việc ${position} quá dài.` };
  }
  const rawPriority = entry['priority'];
  if (rawPriority !== undefined && !isWorkItemPriority(rawPriority)) {
    return {
      ok: false,
      message: `Việc ${position} có độ ưu tiên không hợp lệ, cần từ 0 đến ${WORK_ITEM_PRIORITY_MAX}.`,
    };
  }
  const acceptance = checkAcceptance(entry['acceptance'], position);
  if (!acceptance.ok) return acceptance;
  const dependsOn = parseLeaderDependsOn(entry['dependsOn'], position, index, count, openSequences);
  if (!dependsOn.ok) return dependsOn;
  const rawReason = entry['reason'];
  if (rawReason !== undefined && typeof rawReason !== 'string') {
    return { ok: false, message: `Việc ${position} có lý do không phải chữ.` };
  }
  const reason =
    typeof rawReason === 'string' ? clip(rawReason.trim(), SQUAD_REASON_MAX_CHARS) : '';
  return {
    ok: true,
    value: {
      assignee,
      text,
      priority: isWorkItemPriority(rawPriority) ? rawPriority : WORK_ITEM_PRIORITY_DEFAULT,
      dependsOn: dependsOn.value,
      ...(acceptance.value === undefined ? {} : { acceptance: acceptance.value }),
      ...(reason === '' ? {} : { reason }),
    },
  };
}

/** Checks an optional "done when" text: absent or blank means none, and it may not pass the limit. */
function checkAcceptance(raw: unknown, position: number): Checked<string | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  if (typeof raw !== 'string') {
    return { ok: false, message: `Việc ${position} có tiêu chí xong không phải chữ.` };
  }
  const text = raw.trim();
  if (text.length > WORK_ITEM_ACCEPTANCE_MAX_CHARS) {
    return {
      ok: false,
      message: `Việc ${position} có tiêu chí xong dài quá ${WORK_ITEM_ACCEPTANCE_MAX_CHARS} ký tự.`,
    };
  }
  return { ok: true, value: text === '' ? undefined : text };
}

/**
 * Reads a leader row's "dependsOn": an integer is another row's 0-based index, and "#n" is an open
 * work item the leader was shown. Absent means none.
 */
function parseLeaderDependsOn(
  raw: unknown,
  position: number,
  index: number,
  count: number,
  openSequences: ReadonlySet<number>,
): Checked<DependencyRef[]> {
  if (raw === undefined) return { ok: true, value: [] };
  if (!Array.isArray(raw)) {
    return { ok: false, message: `Việc ${position} có "dependsOn" không phải danh sách.` };
  }
  const entries: readonly unknown[] = raw;
  const refs: DependencyRef[] = [];
  for (const entry of entries) {
    const ref = leaderDependencyRef(entry);
    if (ref === null) {
      return {
        ok: false,
        message: `Việc ${position} có mục "dependsOn" không hợp lệ: dùng số thứ tự một việc khác trong đề xuất, hoặc "#n" của việc đang mở.`,
      };
    }
    refs.push(ref);
  }
  const refusal = refuseRefs(refs, position, index, count, (sequence) =>
    openSequences.has(sequence),
  );
  return refusal === null ? { ok: true, value: refs } : { ok: false, message: refusal };
}

/** One entry of a leader's "dependsOn": an integer row index, or "#n" for an open item. */
function leaderDependencyRef(entry: unknown): DependencyRef | null {
  if (typeof entry === 'number' && Number.isInteger(entry)) return { kind: 'row', row: entry };
  if (typeof entry !== 'string') return null;
  const match = SEQUENCE_REF.exec(entry);
  return match === null ? null : { kind: 'item', sequence: Number(match[1]) };
}

/** A board row's "dependsOn": `{kind:'row', row}` or `{kind:'item', sequence}` entries. */
function parseRowDependsOn(raw: unknown, position: number): Checked<DependencyRef[]> {
  if (raw === undefined) return { ok: true, value: [] };
  if (!Array.isArray(raw)) {
    return { ok: false, message: `Việc ${position} có "dependsOn" không phải danh sách.` };
  }
  const entries: readonly unknown[] = raw;
  const refs: DependencyRef[] = [];
  for (const entry of entries) {
    const ref = parseDependencyRef(entry);
    if (ref === null) {
      return { ok: false, message: `Việc ${position} có mục phụ thuộc không hợp lệ.` };
    }
    refs.push(ref);
  }
  return { ok: true, value: refs };
}

/** A row the board sent back, after its own checks. Its dependencies are checked against the rest. */
interface CheckedRow {
  readonly text: string;
  readonly assignee: WorkItemAssignee;
  readonly priority: number;
  readonly acceptance?: string;
  readonly dependsOn: readonly DependencyRef[];
}

function parseSquadRow(entry: unknown, index: number): Checked<CheckedRow> {
  const position = index + 1;
  if (!isRecord(entry)) return { ok: false, message: `Việc ${position} không hợp lệ.` };
  const text = typeof entry['text'] === 'string' ? entry['text'].trim() : '';
  const refusal = refuseText(text);
  if (refusal === 'empty_text') {
    return { ok: false, message: `Việc ${position} không có nội dung.` };
  }
  if (refusal === 'prompt_too_large') {
    return { ok: false, message: `Việc ${position} quá dài.` };
  }
  const assignee = entry['assignee'];
  if (!isWorkItemAssignee(assignee)) {
    return { ok: false, message: `Việc ${position} có người nhận không hợp lệ.` };
  }
  const rawPriority = entry['priority'];
  if (rawPriority !== undefined && !isWorkItemPriority(rawPriority)) {
    return {
      ok: false,
      message: `Việc ${position} có độ ưu tiên không hợp lệ, cần từ 0 đến ${WORK_ITEM_PRIORITY_MAX}.`,
    };
  }
  const acceptance = checkAcceptance(entry['acceptance'], position);
  if (!acceptance.ok) return acceptance;
  const dependsOn = parseRowDependsOn(entry['dependsOn'], position);
  if (!dependsOn.ok) return dependsOn;
  return {
    ok: true,
    value: {
      text,
      assignee: normalizeAssignee(assignee),
      priority: isWorkItemPriority(rawPriority) ? rawPriority : WORK_ITEM_PRIORITY_DEFAULT,
      ...(acceptance.value === undefined ? {} : { acceptance: acceptance.value }),
      dependsOn: dependsOn.value,
    },
  };
}

/**
 * Checks one row's dependencies against its proposal: at most {@link WORK_ITEM_DEPENDS_MAX}, no
 * repeats, no row outside the proposal or the row itself, and only items `isOpen` accepts. `index`
 * is the row's 0-based position and `count` the rows in the proposal. Returns the refusal, or null.
 */
function refuseRefs(
  refs: readonly DependencyRef[],
  position: number,
  index: number,
  count: number,
  isOpen: (sequence: number) => boolean,
): string | null {
  if (refs.length > WORK_ITEM_DEPENDS_MAX) {
    return `Việc ${position} chờ quá ${WORK_ITEM_DEPENDS_MAX} việc, tối đa ${WORK_ITEM_DEPENDS_MAX}.`;
  }
  const seen = new Set<string>();
  for (const ref of refs) {
    if (ref.kind === 'row') {
      if (ref.row < 0 || ref.row >= count) {
        return `Việc ${position} chờ việc ${ref.row + 1}, nhưng đề xuất chỉ có ${count} việc.`;
      }
      if (ref.row === index) return `Việc ${position} không thể chờ chính nó.`;
    } else if (!isOpen(ref.sequence)) {
      return `Việc ${position} chờ "#${ref.sequence}", nhưng đó không phải việc đang mở.`;
    }
    const key = ref.kind === 'row' ? `row:${ref.row}` : `item:${ref.sequence}`;
    if (seen.has(key)) return `Việc ${position} chờ cùng một việc hai lần.`;
    seen.add(key);
  }
  return null;
}

/**
 * The loop message when rows wait for each other in a cycle, or null. `dependencies[i]` is what
 * row i waits for.
 */
function refuseLoop(dependencies: readonly (readonly DependencyRef[])[]): string | null {
  const rows = dependencies.map((_, index) => index);
  const cyclic = graphHasCycle(rows, (index) =>
    (dependencies[index] ?? []).flatMap((ref) => (ref.kind === 'row' ? [ref.row] : [])),
  );
  return cyclic ? 'Các việc trong đề xuất chờ nhau thành vòng lặp.' : null;
}

function resolveAssignee(
  ref: string,
  members: readonly SquadMember[],
): WorkItemAssignee | undefined {
  if (ref === NEW_SESSION_REF) return { kind: 'new-session' };
  return members.find((member) => member.ref === ref)?.assignee;
}

/** Removes one fenced block around the reply, if the leader added one anyway. */
function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```[a-zA-Z]*\s*\n([\s\S]*?)\n?```$/.exec(trimmed);
  return fenced?.[1]?.trim() ?? trimmed;
}

function teamLines(members: readonly SquadMember[]): string[] {
  const lines = members.map((member) => {
    const parts = [
      `- ${member.ref}`,
      member.kind === 'herdr' ? 'herdr pane' : 'omp session',
      `"${clip(member.label, SQUAD_CONTEXT_MEMBER_MAX_CHARS)}"`,
      `status ${member.status}`,
    ];
    if (member.repo) parts.push(`repo ${clip(member.repo, SQUAD_CONTEXT_MEMBER_MAX_CHARS)}`);
    if (member.branch) parts.push(`branch ${clip(member.branch, SQUAD_CONTEXT_MEMBER_MAX_CHARS)}`);
    if (member.cwd) parts.push(`cwd ${member.cwd}`);
    if (member.title) parts.push(`title "${clip(member.title, SQUAD_CONTEXT_MEMBER_MAX_CHARS)}"`);
    parts.push(member.role === '' ? 'role: none' : `role: "${member.role}"`);
    parts.push(`queued items: ${member.queued}`);
    return parts.join(' · ');
  });
  lines.push(`- ${NEW_SESSION_REF} · opens a new omp chat in the folder when assigned`);
  return lines;
}

function itemLines(items: readonly LeaderItemView[]): string[] {
  if (items.length === 0) return ['(none yet)'];
  return items.flatMap((item) => {
    const lines = [
      `- #${item.sequence} [${item.status}] ${clip(item.text, SQUAD_CONTEXT_TEXT_MAX_CHARS)} · assigned to ${item.assignee}`,
    ];
    if (isOpenItemStatus(item.status)) {
      lines.push(`  priority ${priorityLabel(item.priority)}`);
      if (item.acceptance !== undefined) lines.push(`  done when: ${item.acceptance}`);
      if (item.dependsOn.length > 0) {
        lines.push(`  waits for: ${item.dependsOn.map((sequence) => `#${sequence}`).join(', ')}`);
      }
    }
    if (item.result !== undefined) lines.push(`  result: ${item.result}`);
    return lines;
  });
}

function reviewLines(reviews: readonly SquadReview[]): string[] {
  if (reviews.length === 0) return ['(none)'];
  return reviews.flatMap((review) => {
    const lines = [`- ${clip(review.text, SQUAD_CONTEXT_TEXT_MAX_CHARS)}`];
    if (review.acceptance !== undefined) lines.push(`  done when: ${review.acceptance}`);
    if (review.result !== undefined) lines.push(`  result: ${review.result}`);
    return lines;
  });
}

function historyLines(history: readonly SquadEvent[]): string[] {
  const recent = history.slice(-SQUAD_CONTEXT_EVENTS_MAX);
  if (recent.length === 0) return ['(none)'];
  return recent.map((event) =>
    event.message === undefined ? `- ${event.kind}` : `- ${event.kind}: ${event.message}`,
  );
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/**
 * boardView: the board's lanes and cards, derived from server state.
 *
 * The board is a READ of company state, never a place where a status is
 * decided. A card says what the server last reported for that task, names the
 * session and model the server assigned, and shows the evidence it actually
 * holds. Dragging a card does nothing here on purpose: there is no client-side
 * transition to drag toward, and a card that moves before the server agrees is
 * a card lying to the user.
 *
 * Pure and DOM-free; the renderer and the tests consume the same shapes.
 */

import type {
  Attempt,
  CompanyRole,
  CompanySessionSummary,
  HerdrAgent,
  Task,
  VerificationEvidence,
} from '../../../core/src/company.js';
import type {
  OmpAgentInfo,
  SquadRun,
  WorkItem,
  WorkItemAgyRun,
  WorkItemBlocker,
  WorkItemClaudeRun,
  WorkItemConflicts,
  WorkItemDelivery,
  WorkItemJudge,
  WorkItemStatus,
} from '../../../core/src/messages.js';
import { type AgentBoardCard, buildAgentCards } from './agentBoard.js';
import type { CompanyViewState } from './companyState.js';
import type { CompanyLaneId } from './constants.js';
import { COMPANY_LANE_LABELS, COMPANY_LANE_ORDER } from './constants.js';
import type { FolderIdentity } from './folderIdentity.js';
import { samePath } from './folderView.js';
import { squadLaneFor, visibleSquadRuns } from './squadView.js';
import { isParkedAssignee } from './workItemReviewView.js';
import {
  assigneeLabel,
  laneForWorkItem,
  visibleWorkItems,
  workItemCardHead,
  workItemsOf,
} from './workItemView.js';

/**
 * Where a task status is shown. The seven lanes are the board's vocabulary; a
 * status without one of its own (paused, cancelled) is placed where the user
 * would look for it, and the card still prints its exact status.
 */
const LANE_BY_STATUS: Readonly<Record<Task['status'], CompanyLaneId>> = {
  planned: 'planned',
  ready: 'ready',
  running: 'running',
  waiting_input: 'needs_input',
  paused: 'needs_input',
  verifying: 'review',
  changes_requested: 'review',
  done: 'done',
  failed: 'failed',
  cancelled: 'failed',
};

export function laneForTaskStatus(status: Task['status']): CompanyLaneId {
  return LANE_BY_STATUS[status];
}

/** Who a card in the review lane is waiting on. */
export type ReviewOwner = 'QA' | 'Trọng tài';

/** The attempt that most recently ran a task, if the server still holds it. */
export function latestAttemptForTask(state: CompanyViewState, task: Task): Attempt | undefined {
  let latest: Attempt | undefined;
  for (const attemptId of task.attemptIds) {
    const attempt = state.attempts[attemptId];
    if (attempt !== undefined && (latest === undefined || attempt.startedAt >= latest.startedAt)) {
      latest = attempt;
    }
  }
  return latest;
}

/**
 * Who holds a card in the review lane. QA owns the work until it passes; once
 * QA has passed, the Judge owns the decision. A failed Judge verdict stays the
 * Judge's: that failure is what sent the card back.
 */
export function reviewOwnerFor(attempt: Attempt | undefined): ReviewOwner {
  return attempt?.qaVerdict?.['verdict'] === 'pass' ? 'Trọng tài' : 'QA';
}

/**
 * A task that went back to running after its latest attempt failed
 * verification. The repair is the work now, and the card says so.
 */
export function sentBackFor(status: Task['status'], attempt: Attempt | undefined): boolean {
  return status === 'running' && attempt?.status === 'failed';
}

export interface BoardEvidenceSummary {
  total: number;
  passed: number;
  failed: number;
}

export interface BoardCardSession {
  id: string;
  code: string;
  role: CompanyRole;
  status: string;
  requestedModel: string;
  effectiveModel: string | null;
}

export interface BoardCard {
  taskId: string;
  code: string;
  title: string;
  status: Task['status'];
  lane: CompanyLaneId;
  contractId: string;
  contractCode: string;
  phaseTitle: string;
  phaseOrdinal: number | null;
  dependsOnCodes: string[];
  /** Dependencies that are not done yet, so the card can say what it waits on. */
  blockedByCodes: string[];
  session: BoardCardSession | null;
  routeReason: string;
  executionMode: Task['executionMode'];
  evidence: BoardEvidenceSummary;
  pendingQuestions: number;
  /**
   * WHY this card is not moving, when it is not moving. Blocked by a
   * dependency, held for an answer and queued behind a full running lane are
   * three different problems, and the user acts on them differently.
   */
  waitReason: WaitReason;
  selected: boolean;
  /** Who the card waits on while it sits in the review lane; null everywhere else. */
  reviewOwner: ReviewOwner | null;
  /** A repair after a failed verification: the card carries the "trả lại" state. */
  sentBack: boolean;
}

/** A work item card: what the card shows, read from the item the server holds. */
export interface BoardWorkItem {
  id: string;
  workspacePath: string;
  lane: CompanyLaneId;
  status: WorkItemStatus;
  /** The first line of the text: the card's heading. */
  head: string;
  /** Who holds the item, in words. */
  assignee: string;
  /** Why the item waits, needs input, failed or is in review, as the server words it. */
  reason: string | null;
  /** The item's #n in its folder: the number the card names it by. */
  sequence: number;
  /** 0 is the most urgent (P0), 3 the least (P3). */
  priority: number;
  /** Why a queued item is not sent yet; null when nothing holds it. */
  blocker: WorkItemBlocker | null;
  /** The repo the item runs in, as a canonical path; null for the folder root. */
  repo: string | null;
  /** The role the item is filed under; null when none is set. */
  role: CompanyRole | null;
  /** The omp subagent that takes the item; null for the default worker. */
  agent: string | null;
  /** The code areas the item carries, in lowercase. */
  areas: string[];
  updatedAt: string;
  /** The folder the item is filed under when every folder is shown; null in folder mode. */
  folder: FolderIdentity | null;
  /** The squad run that filed the item, when a squad made it; null otherwise. */
  squadRunId: string | null;
  /** The judge's verdict on the item; null when no judge has run on it. */
  judge: WorkItemJudge | null;
  /** The open items and the main checkout this item overlaps; null when it overlaps none. */
  conflicts: WorkItemConflicts | null;
  /** Whether the item's assignee is a parked squad session. */
  parked: boolean;
  /** The Claude Code run on the item, if any. */
  claudeRun: WorkItemClaudeRun | null;
  /** The agy run on the item, if any. */
  agyRun: WorkItemAgyRun | null;
  /** Where the item's branch stands against origin/staging and origin/main, when the server has read it. */
  delivery: WorkItemDelivery | null;
}

/** A squad run card: what the card shows, read from the run the server holds. */
export interface BoardSquad {
  runId: string;
  workspacePath: string;
  lane: CompanyLaneId;
  /** The request's first line: the card's heading. */
  head: string;
  /** The run as the server holds it: status, progress, proposal, error and history. */
  run: SquadRun;
  /** The proposal's rows, each assignee named in words; empty while there is no proposal. */
  rows: { text: string; assignee: string }[];
  /** The folder's work items as the server sent them; a squad card picks its own children out. */
  items: readonly WorkItem[];
  /** The folder's repos as canonical paths: the values a squad row may name. */
  repos: readonly string[];
  /** The folder's subagent catalog: the values a squad row's agent may name. */
  agents: readonly OmpAgentInfo[];
  /** The folder the run is filed under when every folder is shown; null in folder mode. */
  folder: FolderIdentity | null;
  /** The omp sessions the server reports as parked, so a squad child on a parked session shows it. */
  parkedSessionIds: readonly string[];
}

export interface BoardLane {
  id: CompanyLaneId;
  label: string;
  /** Task cards, in the server's order. */
  cards: BoardCard[];
  /** Work item cards, in the order the folders and the server filed them. */
  workItems: BoardWorkItem[];
  /** Squad run cards, in the order the folders and the server filed them. */
  squads: BoardSquad[];
  /** Agents with no task card of their own, drawn after the task cards. */
  agents: AgentBoardCard[];
}

function cardSession(session: CompanySessionSummary | undefined): BoardCardSession | null {
  if (!session) return null;
  return {
    id: session.id,
    code: session.code,
    role: session.role,
    status: session.status,
    requestedModel: session.requestedModel,
    effectiveModel: session.effectiveModel ?? null,
  };
}

/** Evidence attached to a task through its attempts: what actually ran. */
export function evidenceForTask(
  state: CompanyViewState,
  task: Task,
): {
  summary: BoardEvidenceSummary;
  records: VerificationEvidence[];
} {
  const records: VerificationEvidence[] = [];
  for (const attemptId of task.attemptIds) {
    const attempt: Attempt | undefined = state.attempts[attemptId];
    if (!attempt) continue;
    for (const evidenceId of attempt.evidenceIds) {
      const record = state.evidence[evidenceId];
      if (record) records.push(record);
    }
  }
  return {
    summary: {
      total: records.length,
      passed: records.filter((record) => record.exitCode === 0).length,
      failed: records.filter((record) => record.exitCode !== 0 || record.signal !== undefined)
        .length,
    },
    records,
  };
}

/**
 * Whether an item queued for "agent busy" is in fact still at work: its herdr pane is working in the
 * item's own worktree, so the run it waits behind is this item's earlier turn and the queued text is
 * a follow-up the board sends when that turn ends. Such an item is in Đang làm, not Sẵn sàng.
 */
function busyWithOwnTurn(item: WorkItem, agents: readonly HerdrAgent[]): boolean {
  if (item.status !== 'queued' || item.blocker?.kind !== 'agent') return false;
  if (item.assignee.kind !== 'herdr' || item.worktree === undefined) return false;
  const worktree = item.worktree.path;
  const pane = agents.find((agent) => agent.paneId === item.assignee.paneId);
  if (pane?.status !== 'working') return false;
  return [pane.worktreeRoot, pane.cwd].some((path) => path !== undefined && samePath(path, worktree));
}

const OWN_TURN_REASON = 'Agent đang làm việc này; lời nhắn tiếp sẽ gửi khi lượt này xong.';

/** The work items the board shows, as cards: each one's lane, heading, holder, priority and hold. */
function workItemCards(state: CompanyViewState): BoardWorkItem[] {
  return visibleWorkItems(state).map(({ item, workspacePath, folder }) => {
    const ownTurn = busyWithOwnTurn(item, state.herdr.agents);
    return {
      id: item.id,
      workspacePath,
      lane: ownTurn ? 'running' : laneForWorkItem(item.status),
      status: item.status,
      head: workItemCardHead(item.text),
      assignee: assigneeLabel(item.assignee, state, workspacePath),
      reason: ownTurn ? OWN_TURN_REASON : item.reason?.trim() ? item.reason : null,
      sequence: item.sequence,
      priority: item.priority,
      blocker: ownTurn ? null : (item.blocker ?? null),
      repo: item.repo ?? null,
      role: item.role ?? null,
      agent: item.agent ?? null,
      areas: item.areas ?? [],
      updatedAt: item.updatedAt,
      folder,
      squadRunId: item.squadRunId ?? null,
      judge: item.judge ?? null,
      conflicts: item.conflicts ?? null,
      parked: isParkedAssignee(item.assignee, workItemsOf(state, workspacePath).parkedSessionIds),
      claudeRun: item.claudeRun ?? null,
      agyRun: item.agyRun ?? null,
      delivery: item.delivery ?? null,
    };
  });
}

/** The squad runs the board shows, as cards: each one's lane, heading and proposed rows. */
function squadCards(state: CompanyViewState): BoardSquad[] {
  const cards: BoardSquad[] = [];
  for (const { run, workspacePath, folder } of visibleSquadRuns(state)) {
    const lane = squadLaneFor(run);
    if (lane === null) continue;
    const rows = (run.proposal?.rows ?? []).map((row) => ({
      text: row.text,
      assignee: assigneeLabel(row.assignee, state, workspacePath),
    }));
    const work = workItemsOf(state, workspacePath);
    cards.push({
      runId: run.id,
      workspacePath,
      lane,
      head: workItemCardHead(run.request),
      run,
      rows,
      items: work.items,
      repos: work.repos,
      agents: work.agents,
      parkedSessionIds: work.parkedSessionIds,
      folder,
    });
  }
  return cards;
}

export function buildBoardLanes(state: CompanyViewState): BoardLane[] {
  const tasks = Object.values(state.tasks);
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const codeOf = (id: string): string => byId.get(id)?.code ?? id;

  const cards = tasks.map((task): BoardCard => {
    const contract = state.contracts[task.contractId];
    const lane = laneForTaskStatus(task.status);
    const attempt = latestAttemptForTask(state, task);
    const phase = contract?.phases.find((entry) => entry.id === task.phaseId);
    const dependsOnCodes = task.dependsOn.map(codeOf);
    const blockedByCodes = task.dependsOn
      .filter((id) => byId.get(id)?.status !== 'done')
      .map(codeOf);
    const pendingQuestionCount = Object.values(state.questions).filter(
      (question) => question.taskId === task.id && question.status === 'pending',
    ).length;
    return {
      taskId: task.id,
      code: task.code,
      title: task.title,
      status: task.status,
      lane,
      reviewOwner: lane === 'review' ? reviewOwnerFor(attempt) : null,
      sentBack: sentBackFor(task.status, attempt),
      contractId: task.contractId,
      contractCode: contract?.code ?? task.contractId,
      phaseTitle: phase?.title ?? 'Chưa xếp lịch',
      phaseOrdinal: phase?.ordinal ?? null,
      dependsOnCodes,
      blockedByCodes,
      session: cardSession(task.sessionId ? state.sessions[task.sessionId] : undefined),
      routeReason: task.routeReason,
      executionMode: task.executionMode,
      evidence: evidenceForTask(state, task).summary,
      pendingQuestions: pendingQuestionCount,
      waitReason: waitReasonFor(task, blockedByCodes.length, pendingQuestionCount),
      selected: state.selection.taskId === task.id,
    };
  });

  // Creation order is the server's order; Object.values keeps it, and sorting
  // by it would invent a sequence the company never declared.
  // A session or herdr pane that already holds a task, plans a prompt, or runs a work item is shown by that card.
  // Pane ids ("wA:pY") and session ids (UUIDs) never collide, so one set holds both.
  const carded = new Set(tasks.flatMap((task) => (task.sessionId ? [task.sessionId] : [])));
  for (const prompt of planningPrompts(state)) {
    if (prompt.session !== null) carded.add(prompt.session.id);
  }
  // A pane whose item is finished is still shown by that item while the pane itself reads "done".
  const finishedPanes = new Set<string>();
  const workItems = workItemCards(state);
  for (const { item } of visibleWorkItems(state)) {
    const finished = laneForWorkItem(item.status) === 'done';
    if (item.assignee.kind === 'session' && item.assignee.sessionId && !finished) {
      carded.add(item.assignee.sessionId);
    }
    if (item.assignee.kind === 'herdr' && item.assignee.paneId) {
      (finished ? finishedPanes : carded).add(item.assignee.paneId);
    }
  }
  const agents = buildAgentCards(state, carded, finishedPanes);
  const squads = squadCards(state);
  return COMPANY_LANE_ORDER.map((id) => ({
    id,
    label: COMPANY_LANE_LABELS[id],
    cards: cards.filter((card) => card.lane === id),
    workItems: workItems.filter((card) => card.lane === id),
    squads: squads.filter((card) => card.lane === id),
    agents: agents.filter((agent) => agent.lane === id),
  }));
}

/** A prompt a Director is still turning into a Contract. */
export interface PlanningPrompt {
  promptId: string;
  preview: string;
  session: BoardCardSession | null;
}

/**
 * Prompts the board must show before any task exists: sent to a Director and
 * not yet part of a Contract. Without these a prompt vanished from the board
 * for the minutes the Director spent planning it.
 */
export function planningPrompts(state: CompanyViewState): PlanningPrompt[] {
  const planned = new Set(Object.values(state.contracts).flatMap((contract) => contract.promptIds));
  return state.prompts
    .filter((prompt) => !planned.has(prompt.id))
    .filter((prompt) => {
      const session = prompt.targetSessionId ? state.sessions[prompt.targetSessionId] : undefined;
      return session?.role === 'director';
    })
    .map((prompt) => ({
      promptId: prompt.id,
      preview: prompt.preview,
      session: cardSession(
        prompt.targetSessionId ? state.sessions[prompt.targetSessionId] : undefined,
      ),
    }));
}

/** Why a card is not moving. Null when nothing is holding it. */
export type WaitReason = 'awaiting_answer' | 'blocked_by_dependencies' | 'paused' | 'queued' | null;

export const WAIT_REASON_LABELS: Record<Exclude<WaitReason, null>, string> = {
  awaiting_answer: 'đang chờ bạn trả lời',
  blocked_by_dependencies: 'bị chặn bởi một phụ thuộc',
  paused: 'đã tạm dừng',
  queued: 'đang xếp hàng',
};

function waitReasonFor(
  task: Task,
  blockedByCount: number,
  pendingQuestionCount: number,
): WaitReason {
  if (task.status === 'done' || task.status === 'failed' || task.status === 'cancelled') {
    return null;
  }
  // A question the user must answer outranks every scheduling reason: nothing
  // the scheduler does can move this card until that answer arrives.
  if (pendingQuestionCount > 0 || task.status === 'waiting_input') return 'awaiting_answer';
  if (task.status === 'paused') return 'paused';
  if (blockedByCount > 0) return 'blocked_by_dependencies';
  if (task.status === 'ready') return 'queued';
  return null;
}

/**
 * Lane flow, read from the lanes and the settings the server already sent.
 *
 * This is work-in-progress accounting, not a utilisation score: how many cards
 * are actually moving, against the worker limit the company is configured
 * with. There is deliberately no "worker utilisation" percentage here -- a
 * percentage of what is not defined would be decoration.
 */
export interface BoardFlow {
  running: number;
  /** The squad's `maxParallel` when the folder has squad settings, else `settings.maxWorkers`; null before either arrives. */
  runningLimit: number | null;
  ready: number;
  blocked: number;
  awaitingAnswer: number;
  done: number;
  failed: number;
  /** Ready work that exists because the running lane is already at its limit. */
  queuedBehindWip: boolean;
}

export function boardFlow(lanes: readonly BoardLane[], maxWorkers: number | null): BoardFlow {
  const cards = lanes.flatMap((lane) => lane.cards);
  const items = lanes.flatMap((lane) => lane.workItems);
  const count = (predicate: (card: BoardCard) => boolean) =>
    cards.filter((card) => predicate(card)).length;
  // Work item cards move through the same lanes as task cards, so they count the same way.
  const inLane = (id: CompanyLaneId) =>
    count((card) => card.lane === id) + items.filter((item) => item.lane === id).length;
  const running = inLane('running');
  const ready = inLane('ready');
  return {
    running,
    runningLimit: maxWorkers,
    ready,
    blocked: count((card) => card.waitReason === 'blocked_by_dependencies'),
    awaitingAnswer:
      count((card) => card.waitReason === 'awaiting_answer') +
      items.filter((item) => item.status === 'needs_input').length,
    done: inLane('done'),
    failed: inLane('failed'),
    queuedBehindWip: ready > 0 && maxWorkers !== null && running >= maxWorkers,
  };
}

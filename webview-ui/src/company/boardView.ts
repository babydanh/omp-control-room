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
  Task,
  VerificationEvidence,
} from '../../../core/src/company.js';
import type { CompanyViewState } from './companyState.js';
import type { CompanyLaneId } from './constants.js';
import { COMPANY_LANE_LABELS, COMPANY_LANE_ORDER } from './constants.js';

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
}

export interface BoardLane {
  id: CompanyLaneId;
  label: string;
  cards: BoardCard[];
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

export function buildBoardLanes(state: CompanyViewState): BoardLane[] {
  const tasks = Object.values(state.tasks);
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const codeOf = (id: string): string => byId.get(id)?.code ?? id;

  const cards = tasks.map((task): BoardCard => {
    const contract = state.contracts[task.contractId];
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
      lane: laneForTaskStatus(task.status),
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
  return COMPANY_LANE_ORDER.map((id) => ({
    id,
    label: COMPANY_LANE_LABELS[id],
    cards: cards.filter((card) => card.lane === id),
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
  /** `settings.maxWorkers`, or null before the first snapshot. */
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
  const count = (predicate: (card: BoardCard) => boolean) =>
    cards.filter((card) => predicate(card)).length;
  const running = count((card) => card.lane === 'running');
  const ready = count((card) => card.lane === 'ready');
  return {
    running,
    runningLimit: maxWorkers,
    ready,
    blocked: count((card) => card.waitReason === 'blocked_by_dependencies'),
    awaitingAnswer: count((card) => card.waitReason === 'awaiting_answer'),
    done: count((card) => card.lane === 'done'),
    failed: count((card) => card.lane === 'failed'),
    queuedBehindWip: ready > 0 && maxWorkers !== null && running >= maxWorkers,
  };
}

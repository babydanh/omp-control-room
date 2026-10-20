/**
 * sessionPool: the bounded set of logical company sessions.
 *
 * The pool answers one question — "may this work start, and on which session?" —
 * and it answers it without starting anything. State transitions belong to the
 * coordinator; this module only decides, and hands back the records the caller
 * must commit.
 *
 * Three bounds shape every answer:
 *
 *  - `maxRetainedSessions` counts HOT and WARM logical sessions. Archiving frees
 *    a slot; it never deletes a transcript, and an archived session keeps its id
 *    so it can be reopened or exchanged for a parked one later.
 *  - `maxLiveRunners` counts sessions with a live process behind them. Parking
 *    releases a runner without losing the session's history, which is how four
 *    Workers fit inside four runners while Director/Advisor/QA/Judge keep theirs.
 *  - Eviction NEVER touches a session that is live, running, awaiting input, or
 *    pinned by continuity. A session blocked on a human question stays put even
 *    if it is the oldest thing in the pool, because "idle" is exactly what a
 *    waiting session looks like from the outside.
 *
 * When the pool is full and nothing is evictable the answer is an explicit
 * `pool_full` / `live_limit` queue decision naming the blockers. Silently
 * starting work anyway, or quietly deleting a session, would both be worse than
 * waiting.
 */

import type { CompanyRole, CompanySession, Question } from '../../../core/src/company.js';
import { CompanyError } from './companyError.js';
import {
  COMPANY_IDLE_PARK_SECONDS,
  COMPANY_MAX_LIVE_RUNNERS,
  COMPANY_MAX_RETAINED_SESSIONS,
} from './constants.js';

/** Statuses that hold a live process (a runner) behind the session. */
const LIVE_STATUSES: ReadonlySet<CompanySession['status']> = new Set<CompanySession['status']>([
  'starting',
  'idle',
  'busy',
  'waiting_input',
  'pausing',
  'paused',
  'stopping',
]);

/** Statuses the pool may park on its own. */
const PARKABLE_STATUSES: ReadonlySet<CompanySession['status']> = new Set<CompanySession['status']>([
  'idle',
]);

/**
 * Statuses a session may be REUSED from. A parked session reopens on its own
 * native file (epoch bumps); an idle one is handed straight to the new work.
 * `busy`, `waiting_input` and every transitional status are excluded: hijacking
 * a session mid-turn would move an active task onto unrelated context.
 */
const REUSABLE_STATUSES: ReadonlySet<CompanySession['status']> = new Set<CompanySession['status']>([
  'idle',
  'parked',
]);

/**
 * Statuses that may be archived automatically. Only a session with no live
 * process is a candidate; `stopped`, `crashed` and `paused` are outcomes the
 * user may still want to read or restart, so they are not taken silently.
 */
const ARCHIVABLE_STATUSES: ReadonlySet<CompanySession['status']> = new Set<
  CompanySession['status']
>(['parked']);

export interface PoolLimits {
  readonly maxRetainedSessions: number;
  readonly maxLiveRunners: number;
  readonly idleParkSeconds: number;
}

/**
 * Whether a session currently holds a live process. Shared with the scheduler,
 * which counts runners before it hands out work: if the two disagreed about
 * what "live" means, the pool could park four sessions the scheduler still
 * counted, or the reverse.
 */
export function sessionHoldsRunner(session: CompanySession): boolean {
  return LIVE_STATUSES.has(session.status);
}

/** Whether a session belongs to a squad: squad workstream ids, whether opened now or before. */
export function isSquadWorkstream(workstreamId: string): boolean {
  return workstreamId.startsWith('squad-') || workstreamId.startsWith('squad:');
}

export const DEFAULT_POOL_LIMITS: PoolLimits = {
  maxRetainedSessions: COMPANY_MAX_RETAINED_SESSIONS,
  maxLiveRunners: COMPANY_MAX_LIVE_RUNNERS,
  idleParkSeconds: COMPANY_IDLE_PARK_SECONDS,
};

export type ParkRefusal =
  | 'has_active_task'
  | 'pending_question'
  | 'terminal_attached'
  | 'not_idle_long_enough'
  | 'status_not_parkable'
  | 'unknown_session';

export type ParkDecision =
  { readonly park: true } | { readonly park: false; readonly reason: ParkRefusal };

export type ArchiveRefusal =
  | 'unknown_session'
  | 'not_parked'
  | 'has_active_task'
  | 'pending_question'
  | 'pinned'
  | 'handoff_not_stored';

export type ArchiveDecision =
  { readonly archive: true } | { readonly archive: false; readonly reason: ArchiveRefusal };

export interface PoolCounts {
  readonly total: number;
  readonly retained: number;
  readonly archived: number;
  readonly live: number;
}

/** What the caller wants a session for. */
export interface SessionRequest {
  readonly role: CompanyRole;
  readonly workstreamId: string;
  readonly requestedModel: string;
  /** An explicit target the router already validated; reused when it fits. */
  readonly preferSessionId?: string;
  /**
   * Sessions whose continuity the user pinned. They keep their slot and are
   * never archive candidates, however old they are.
   */
  readonly pinnedSessionIds?: readonly string[];
  /** Whether the work needs a runner right now, or may sit parked. */
  readonly requireLiveRunner?: boolean;
}

export type PoolQueueCode = 'pool_full' | 'live_limit';
/** What a new session record needs; its id, code and workspace key are the caller's. */
export interface AllocationDecisionMint {
  readonly role: CompanyRole;
  readonly workstreamId: string;
  readonly requestedModel: string;
  readonly status: CompanySession['status'];
}

export type AllocationDecision =
  | {
      readonly kind: 'reuse';
      readonly session: CompanySession;
      /** The epoch the caller must run under; bumped when a parked session reopens. */
      readonly runEpoch: number;
      readonly reason: string;
    }
  | {
      readonly kind: 'allocate';
      /** Parked sessions that must be archived, in the order they may be taken. */
      readonly archiveCandidates: readonly CompanySession[];
      readonly runEpoch: number;
      readonly reason: string;
      /** What the coordinator must mint; identity and code come from its counters. */
      readonly mint: AllocationDecisionMint;
    }
  | {
      readonly kind: 'queue';
      readonly code: PoolQueueCode;
      readonly detail: string;
      /** Session ids standing between the request and a slot. */
      readonly blockedBy: readonly string[];
    };

export interface SessionPoolOptions {
  readonly limits?: Partial<PoolLimits>;
  /** Milliseconds since the epoch. Injected so idle parking is deterministic in tests. */
  readonly now?: () => number;
}

export class SessionPool {
  private readonly limits: PoolLimits;
  private readonly now: () => number;
  private readonly sessions = new Map<string, CompanySession>();
  private readonly pinned = new Set<string>();

  constructor(options: SessionPoolOptions = {}) {
    this.limits = { ...DEFAULT_POOL_LIMITS, ...options.limits };
    this.now = options.now ?? Date.now;
  }

  /** Insert or replace a session record from the durable state. */
  upsert(session: CompanySession): void {
    this.sessions.set(session.id, session);
  }

  /** Drop a session from the pool view; the caller's state remains the authority. */
  remove(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /** Pin continuity so the slot survives eviction pressure. */
  pin(sessionId: string): void {
    this.pinned.add(sessionId);
  }

  unpin(sessionId: string): void {
    this.pinned.delete(sessionId);
  }

  isPinned(sessionId: string): boolean {
    return this.pinned.has(sessionId);
  }

  get(sessionId: string): CompanySession | undefined {
    return this.sessions.get(sessionId);
  }

  list(): CompanySession[] {
    return [...this.sessions.values()];
  }

  counts(): PoolCounts {
    const all = this.list();
    const retained = all.filter((session) => session.status !== 'archived');
    return {
      total: all.length,
      retained: retained.length,
      archived: all.length - retained.length,
      live: retained.filter((session) => LIVE_STATUSES.has(session.status)).length,
    };
  }

  /**
   * Decide how a request runs: reuse an existing session, mint a new one (and
   * say which parked sessions must be archived first), or queue with the exact
   * blockers. Never starts a process and never mutates a record.
   */
  plan(request: SessionRequest): AllocationDecision {
    const pinned = new Set([...this.pinned, ...(request.pinnedSessionIds ?? [])]);
    const reusable = this.selectReusable(request);

    if (reusable) {
      const parked = reusable.status === 'parked';
      return {
        kind: 'reuse',
        session: reusable,
        runEpoch: parked ? reusable.runEpoch + 1 : reusable.runEpoch,
        reason: parked
          ? `Reopen ${reusable.code}: same workstream and role, history preserved.`
          : `Reuse idle ${reusable.code}: same workstream, role and model.`,
      };
    }

    // The runner limit is checked FIRST: freeing a retained slot for work that
    // still cannot start would trade a live session for nothing.
    const needsRunner = request.requireLiveRunner ?? true;
    if (needsRunner && this.liveCount() >= this.limits.maxLiveRunners) {
      const live = this.retainedSessions().filter((session) => LIVE_STATUSES.has(session.status));
      return {
        kind: 'queue',
        code: 'live_limit',
        detail: `All ${this.limits.maxLiveRunners} live runners are in use. Park an idle role to start new work.`,
        blockedBy: live.map((session) => session.id),
      };
    }

    const retained = this.retainedSessions();
    if (retained.length >= this.limits.maxRetainedSessions) {
      const candidates = this.archiveCandidates(pinned);
      if (candidates.length === 0) {
        return {
          kind: 'queue',
          code: 'pool_full',
          detail:
            `Cả ${this.limits.maxRetainedSessions} phiên đang giữ đều đang bận, đang chờ phản hồi, hoặc đã được ghim. ` +
            'Hãy giải phóng hoặc lưu trữ một phiên để chạy công việc mới.',
          blockedBy: retained.map((session) => session.id),
        };
      }
      return {
        kind: 'allocate',
        mint: this.mintFor(request, needsRunner),
        archiveCandidates: candidates,
        runEpoch: 1,
        reason: `Archive ${candidates[0].code} (parked, no task, no pending question) to free a retained slot.`,
      };
    }

    return {
      kind: 'allocate',
      mint: this.mintFor(request, needsRunner),
      archiveCandidates: [],
      runEpoch: 1,
      reason: `Retained ${this.counts().retained + 1}/${this.limits.maxRetainedSessions}; new session for workstream ${request.workstreamId}.`,
    };
  }

  /**
   * May this session park now? Parking disposes its process, so anything that
   * still owes the user something keeps its runner.
   */
  planPark(
    sessionId: string,
    context: {
      questions?: readonly Question[];
      attachedTerminalSessionIds?: readonly string[];
    } = {},
  ): ParkDecision {
    const session = this.sessions.get(sessionId);
    if (!session) return { park: false, reason: 'unknown_session' };
    if (!PARKABLE_STATUSES.has(session.status)) {
      return { park: false, reason: 'status_not_parkable' };
    }
    if (session.activeTaskId) return { park: false, reason: 'has_active_task' };
    if (this.hasPendingQuestion(sessionId, context.questions ?? [])) {
      return { park: false, reason: 'pending_question' };
    }
    if ((context.attachedTerminalSessionIds ?? []).includes(sessionId)) {
      return { park: false, reason: 'terminal_attached' };
    }
    const idleMs = this.now() - Date.parse(session.lastUsedAt);
    if (!Number.isFinite(idleMs) || idleMs < this.limits.idleParkSeconds * 1000) {
      return { park: false, reason: 'not_idle_long_enough' };
    }
    return { park: true };
  }

  /**
   * May this session be archived? Archiving frees a retained slot, so a session
   * with a live process, an active task, a pending question or a pin is never a
   * candidate. The caller must additionally have stored the handoff first —
   * `handoffStored` is asserted here so the ordering cannot be forgotten.
   */
  planArchive(
    sessionId: string,
    context: { questions?: readonly Question[]; handoffStored: boolean },
  ): ArchiveDecision {
    const session = this.sessions.get(sessionId);
    if (!session) return { archive: false, reason: 'unknown_session' };
    if (!ARCHIVABLE_STATUSES.has(session.status)) return { archive: false, reason: 'not_parked' };
    if (session.activeTaskId) return { archive: false, reason: 'has_active_task' };
    if (this.isPinned(sessionId)) return { archive: false, reason: 'pinned' };
    if (this.hasPendingQuestion(sessionId, context.questions ?? [])) {
      return { archive: false, reason: 'pending_question' };
    }
    if (!context.handoffStored) return { archive: false, reason: 'handoff_not_stored' };
    return { archive: true };
  }

  /**
   * Parked sessions that may be archived right now, oldest first. A session is
   * only a candidate when it is parked, has no active task, and has no pending
   * question — the same rule {@link planArchive} applies to a single session.
   */
  archiveCandidates(pinned: ReadonlySet<string> = new Set()): CompanySession[] {
    return [...this.sessions.values()]
      .filter(
        (session) =>
          ARCHIVABLE_STATUSES.has(session.status) &&
          !pinned.has(session.id) &&
          !session.activeTaskId,
      )
      .sort((left, right) => {
        const byAge = Date.parse(left.lastUsedAt) - Date.parse(right.lastUsedAt);
        if (byAge !== 0) return byAge;
        return left.code.localeCompare(right.code);
      });
  }

  /**
   * Parked sessions idle past the threshold, oldest first. The caller decides
   * which to park; the pool only ranks them.
   */
  parkCandidates(
    context: {
      questions?: readonly Question[];
      attachedTerminalSessionIds?: readonly string[];
    } = {},
  ): CompanySession[] {
    return [...this.sessions.values()]
      .filter(
        (session) =>
          PARKABLE_STATUSES.has(session.status) &&
          !session.activeTaskId &&
          !this.hasPendingQuestion(session.id, context.questions ?? []) &&
          !(context.attachedTerminalSessionIds ?? []).includes(session.id) &&
          this.now() - Date.parse(session.lastUsedAt) >= this.limits.idleParkSeconds * 1000,
      )
      .sort((left, right) => Date.parse(left.lastUsedAt) - Date.parse(right.lastUsedAt));
  }

  /** Live runners in use; a parked or archived session holds none. */
  liveCount(): number {
    return this.retainedSessions().filter((session) => LIVE_STATUSES.has(session.status)).length;
  }

  /**
   * Swap a parked session out for an archived one: the archived session takes
   * the retained slot and the parked one is released. Ids survive the exchange,
   * so both histories stay reachable.
   */
  exchangeSlots(archivedSessionId: string, parkedSessionId: string): void {
    const archived = this.sessions.get(archivedSessionId);
    const parked = this.sessions.get(parkedSessionId);
    if (!archived || !parked) {
      throw new CompanyError(
        'company_session_unknown',
        `Cannot exchange ${archivedSessionId} with ${parkedSessionId}: one of them is unknown.`,
      );
    }
    if (archived.status !== 'archived') {
      throw new CompanyError(
        'company_session_not_archived',
        `${archived.code} is ${archived.status}, not archived.`,
      );
    }
    if (!ARCHIVABLE_STATUSES.has(parked.status)) {
      throw new CompanyError(
        'company_session_not_parked',
        `${parked.code} is ${parked.status}, so it cannot release its slot.`,
      );
    }
    this.sessions.set(archived.id, { ...archived, status: 'parked' });
    this.sessions.set(parked.id, { ...parked, status: 'archived' });
  }

  private retainedSessions(): CompanySession[] {
    return this.list().filter((session) => session.status !== 'archived');
  }

  /**
   * Best reusable session for a request, or undefined when none fits.
   *
   * Reuse requires the SAME workstream, role and model. An idle Worker from
   * another workstream is not a fallback: absorbing its work would move an
   * active task onto unrelated context, which is the one thing routing exists to
   * prevent. A session the router already validated as an explicit target wins
   * outright.
   */
  private selectReusable(request: SessionRequest): CompanySession | undefined {
    const candidates = this.retainedSessions().filter(
      (session) =>
        REUSABLE_STATUSES.has(session.status) &&
        session.role === request.role &&
        session.workstreamId === request.workstreamId &&
        session.requestedModel === request.requestedModel,
    );
    if (candidates.length === 0) return undefined;

    const byId = candidates.find((session) => session.id === request.preferSessionId);
    if (byId) return byId;

    // An idle session is preferred over reopening a parked one: it keeps the
    // runner that is already warm and costs no process spawn.
    return candidates.sort((left, right) => {
      if (left.status !== right.status) return left.status === 'idle' ? -1 : 1;
      return Date.parse(right.lastUsedAt) - Date.parse(left.lastUsedAt);
    })[0];
  }

  /** The facts a new session record needs; identity and code come from the caller. */
  private mintFor(request: SessionRequest, needsRunner: boolean): AllocationDecisionMint {
    return {
      role: request.role,
      workstreamId: request.workstreamId,
      requestedModel: request.requestedModel,
      status: needsRunner ? 'starting' : 'parked',
    };
  }

  private hasPendingQuestion(sessionId: string, questions: readonly Question[]): boolean {
    return questions.some(
      (question) => question.sessionId === sessionId && question.status === 'pending',
    );
  }
}

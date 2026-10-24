/**
 * scheduler: which task runs next, and what it must own before it may start.
 *
 * The DAG decides what is allowed to run; this module decides what runs NOW,
 * under three bounds that all of them share:
 *
 *  - `maxWorkers` — concurrent tasks.
 *  - `maxConcurrentModelCalls` — concurrent provider calls. Every dispatch takes
 *    one, and native subagents take their own from the SAME table, so four
 *    parents cannot spawn sixteen children past the limit.
 *  - `maxLiveRunners` — sessions with a process behind them. Only a task whose
 *    `executionMode` is `session` consumes one; inline work runs inside a session
 *    that already holds a runner.
 *
 * Order is phase ordinal, then creation order, so a Contract reads top to bottom
 * and two tasks in one phase start in the order the Director planned them.
 *
 * The invariant this module exists to hold: a task appears in `dispatch` ONLY
 * when its scopes and shared resources were acquired AND its worker/model leases
 * were granted. If the lease is refused after the lock was taken, the lock is
 * released again — a task that never started must not wedge the files it named.
 */

import type { CompanySession, Contract, Phase, Task } from '../../../core/src/company.js';
import {
  COMPANY_MAX_LIVE_RUNNERS,
  COMPANY_MAX_MODEL_CALLS,
  COMPANY_MAX_WORKERS,
} from './constants.js';
import { sessionHoldsRunner } from './sessionPool.js';
import { WorkspaceLockTable } from './workspaceLocks.js';

export interface SchedulerLimits {
  readonly maxWorkers: number;
  readonly maxConcurrentModelCalls: number;
  readonly maxLiveRunners: number;
}

export const DEFAULT_SCHEDULER_LIMITS: SchedulerLimits = {
  maxWorkers: COMPANY_MAX_WORKERS,
  maxConcurrentModelCalls: COMPANY_MAX_MODEL_CALLS,
  maxLiveRunners: COMPANY_MAX_LIVE_RUNNERS,
};

/** Task statuses the scheduler may start from, including a bounded repair cycle. */
const RUNNABLE_STATUSES: ReadonlySet<Task['status']> = new Set<Task['status']>([
  'planned',
  'ready',
  'changes_requested',
]);

/** Contract statuses that authorize the scheduler to start anything. */
const DISPATCHABLE_CONTRACT_STATUSES: ReadonlySet<Contract['status']> = new Set<Contract['status']>(
  ['approved', 'running'],
);

/**
 * Session statuses that mean the session is already committed to something else.
 * A task assigned to one of these waits rather than moving its work onto
 * unrelated context.
 */
const BUSY_SESSION_STATUSES: ReadonlySet<CompanySession['status']> = new Set<
  CompanySession['status']
>(['starting', 'busy', 'waiting_input', 'pausing', 'stopping']);

export type ExhaustedCapacity = 'workers' | 'modelCalls' | 'liveRunners';

export interface CapacityGrant {
  readonly ownerId: string;
  readonly workers: number;
  readonly modelCalls: number;
  readonly liveRunners: number;
}

export interface CapacitySnapshot {
  readonly workers: number;
  readonly modelCalls: number;
  readonly liveRunners: number;
  readonly limits: SchedulerLimits;
}

/** Capacity consumed outside this table: a Director turn, a native child call. */
export interface ExternalCapacity {
  readonly workers: number;
  readonly modelCalls: number;
  readonly liveRunners: number;
}

/**
 * All-or-nothing capacity accounting. A partial grant is worse than none: the
 * caller would believe it holds a worker while another dispatcher hands the same
 * slot to somebody else.
 */
export class CapacityTable {
  private limits: SchedulerLimits;
  private readonly grants = new Map<string, CapacityGrant>();
  private external: { workers: number; modelCalls: number; liveRunners: number } = {
    workers: 0,
    modelCalls: 0,
    liveRunners: 0,
  };

  constructor(
    limits: SchedulerLimits = DEFAULT_SCHEDULER_LIMITS,
    external: Partial<ExternalCapacity> = {},
  ) {
    this.limits = limits;
    this.external = {
      workers: external.workers ?? 0,
      modelCalls: external.modelCalls ?? 0,
      liveRunners: external.liveRunners ?? 0,
    };
  }
  setLiveRunnerLimit(maxLiveRunners: number): void {
    this.limits = { ...this.limits, maxLiveRunners };
  }

  /** Replace capacity consumed outside this table (a Director turn, a native child). */
  setExternal(usage: Partial<ExternalCapacity>): void {
    this.external = {
      workers: usage.workers ?? 0,
      modelCalls: usage.modelCalls ?? 0,
      liveRunners: usage.liveRunners ?? 0,
    };
  }

  /**
   * Grant every requested unit or nothing, naming the pool that ran out.
   * A zero request is not a grant: an owner with no capacity cannot be released.
   */
  tryAcquire(
    ownerId: string,
    want: { workers?: number; modelCalls?: number; liveRunners?: number },
  ): { granted: true; grant: CapacityGrant } | { granted: false; exhausted: ExhaustedCapacity } {
    const workers = want.workers ?? 0;
    const modelCalls = want.modelCalls ?? 0;
    const liveRunners = want.liveRunners ?? 0;
    const snapshot = this.snapshot();
    if (snapshot.workers + workers > snapshot.limits.maxWorkers) {
      return { granted: false, exhausted: 'workers' };
    }
    if (snapshot.modelCalls + modelCalls > snapshot.limits.maxConcurrentModelCalls) {
      return { granted: false, exhausted: 'modelCalls' };
    }
    if (snapshot.liveRunners + liveRunners > snapshot.limits.maxLiveRunners) {
      return { granted: false, exhausted: 'liveRunners' };
    }
    const grant: CapacityGrant = { ownerId, workers, modelCalls, liveRunners };
    this.grants.set(ownerId, grant);
    return { granted: true, grant };
  }

  release(ownerId: string): void {
    this.grants.delete(ownerId);
  }

  snapshot(): CapacitySnapshot {
    let workers = this.external.workers;
    let modelCalls = this.external.modelCalls;
    let liveRunners = this.external.liveRunners;
    for (const grant of this.grants.values()) {
      workers += grant.workers;
      modelCalls += grant.modelCalls;
      liveRunners += grant.liveRunners;
    }
    return { workers, modelCalls, liveRunners, limits: this.limits };
  }
}

export type DispatchHoldReason =
  | 'contract_not_approved'
  | 'status_not_runnable'
  | 'already_dispatched'
  | 'dependency_not_done'
  | 'dependency_unknown'
  | 'dependency_cycle'
  | 'session_busy'
  | 'scope_conflict'
  | 'resource_conflict'
  | 'worker_limit'
  | 'model_call_limit'
  | 'live_runner_limit';

export interface DispatchEntry {
  readonly taskId: string;
  readonly code: string;
  readonly executionMode: Task['executionMode'];
  readonly phaseOrdinal: number;
  readonly creationIndex: number;
  /** True when a scope could not be resolved and therefore locked the workspace. */
  readonly workspaceWide: boolean;
  readonly leases: CapacityGrant;
}

export interface HeldDispatch {
  readonly taskId: string;
  readonly code: string;
  readonly reason: DispatchHoldReason;
  readonly detail: string;
}

export interface DispatchPlan {
  readonly dispatch: DispatchEntry[];
  readonly waiting: HeldDispatch[];
  readonly capacity: CapacitySnapshot;
}

export interface DispatchInput {
  readonly contract: Contract;
  /** Managed sessions, for the live-runner count and per-session busy checks. */
  readonly sessions: readonly CompanySession[];
}

export interface SchedulerOptions {
  readonly limits?: Partial<SchedulerLimits>;
  readonly locks: WorkspaceLockTable;
}

function phaseOrder(phases: readonly Phase[]): Map<string, number> {
  return new Map(phases.map((phase) => [phase.id, phase.ordinal]));
}

/**
 * Detect a task that can never run because it sits on, or upstream of, a cycle.
 * A cycle member's dependencies never reach `done`, so without this the task
 * would sit in the queue with a reason that looks like ordinary waiting.
 */
function cycleCodes(tasks: readonly Task[]): Set<string> {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const cyclic = new Set<string>();
  const state = new Map<string, 'visiting' | 'done'>();

  const visit = (task: Task): void => {
    const seen = state.get(task.id);
    if (seen === 'done') return;
    if (seen === 'visiting') {
      cyclic.add(task.code);
      return;
    }
    state.set(task.id, 'visiting');
    for (const dependencyId of task.dependsOn) {
      const dependency = byId.get(dependencyId);
      if (!dependency) continue;
      const before = cyclic.size;
      visit(dependency);
      // A dependency that is itself cyclic makes this task unreachable too.
      if (cyclic.size !== before && cyclic.has(dependency.code)) cyclic.add(task.code);
    }
    state.set(task.id, 'done');
  };

  for (const task of tasks) visit(task);
  return cyclic;
}

export class Scheduler {
  private readonly locks: WorkspaceLockTable;
  private readonly capacity: CapacityTable;
  private readonly dispatched = new Set<string>();

  constructor(options: SchedulerOptions) {
    this.locks = options.locks;
    this.capacity = new CapacityTable({
      maxWorkers: options.limits?.maxWorkers ?? COMPANY_MAX_WORKERS,
      maxConcurrentModelCalls: options.limits?.maxConcurrentModelCalls ?? COMPANY_MAX_MODEL_CALLS,
      maxLiveRunners: options.limits?.maxLiveRunners ?? COMPANY_MAX_LIVE_RUNNERS,
    });
  }

  /**
   * Choose what runs now. Each candidate is taken in phase-then-creation order
   * and either dispatched with both its lock and its leases, or reported as
   * waiting with the exact reason — never both, never neither.
   */
  plan(input: DispatchInput): DispatchPlan {
    const dispatch: DispatchEntry[] = [];
    const waiting: HeldDispatch[] = [];
    const ordinals = phaseOrder(input.contract.phases);
    const byId = new Map(input.contract.tasks.map((task) => [task.id, task]));
    const cyclic = cycleCodes(input.contract.tasks);
    const done = new Set(
      input.contract.tasks.filter((task) => task.status === 'done').map((task) => task.id),
    );
    const sessionsById = new Map(input.sessions.map((session) => [session.id, session]));
    this.capacity.setExternal({
      liveRunners: input.sessions.filter((session) => sessionHoldsRunner(session)).length,
    });

    const ordered = input.contract.tasks
      .map((task, creationIndex) => ({ task, creationIndex }))
      .sort((left, right) => {
        const byPhase =
          (ordinals.get(left.task.phaseId) ?? Number.MAX_SAFE_INTEGER) -
          (ordinals.get(right.task.phaseId) ?? Number.MAX_SAFE_INTEGER);
        return byPhase !== 0 ? byPhase : left.creationIndex - right.creationIndex;
      });

    if (!DISPATCHABLE_CONTRACT_STATUSES.has(input.contract.status)) {
      return {
        dispatch,
        waiting: ordered.map(({ task }) => ({
          taskId: task.id,
          code: task.code,
          reason: 'contract_not_approved' as const,
          detail: `Contract ${input.contract.code} is ${input.contract.status}; work starts only after approval.`,
        })),
        capacity: this.capacity.snapshot(),
      };
    }

    for (const { task, creationIndex } of ordered) {
      const held = this.holdReason(task, {
        byId,
        cyclic,
        done,
        sessionsById,
      });
      if (held) {
        waiting.push({
          taskId: task.id,
          code: task.code,
          reason: held.reason,
          detail: held.detail,
        });
        continue;
      }

      const lock = this.locks.acquire({
        ownerId: task.id,
        scopes: task.writeScopes,
        resources: task.sharedResources,
      });
      if (!lock.granted) {
        const first = lock.conflicts[0];
        // Locks are held by task id; the user reads task codes, so translate
        // the ids this Contract knows and fall back to the raw id otherwise.
        const holders = first.ownerIds
          .map((ownerId) => byId.get(ownerId)?.code ?? ownerId)
          .join(', ');
        waiting.push({
          taskId: task.id,
          code: task.code,
          reason: first.kind === 'resource' ? 'resource_conflict' : 'scope_conflict',
          detail: `${first.declaredPath} is held by ${holders}.`,
        });
        continue;
      }

      const leased = this.capacity.tryAcquire(task.id, {
        workers: 1,
        modelCalls: 1,
        liveRunners: task.executionMode === 'session' ? 1 : 0,
      });
      if (!leased.granted) {
        this.locks.release(task.id);
        waiting.push({
          taskId: task.id,
          code: task.code,
          reason:
            leased.exhausted === 'workers'
              ? 'worker_limit'
              : leased.exhausted === 'modelCalls'
                ? 'model_call_limit'
                : 'live_runner_limit',
          detail: `No ${leased.exhausted} capacity left.`,
        });
        continue;
      }

      this.dispatched.add(task.id);
      dispatch.push({
        taskId: task.id,
        code: task.code,
        executionMode: task.executionMode,
        phaseOrdinal: ordinals.get(task.phaseId) ?? Number.MAX_SAFE_INTEGER,
        creationIndex,
        workspaceWide: lock.scopes.some((scope) => scope.workspaceWide),
        leases: leased.grant,
      });
    }

    return { dispatch, waiting, capacity: this.capacity.snapshot() };
  }

  /** Give back a finished task's lock and leases so its files and slots are free. */
  release(taskId: string): void {
    this.dispatched.delete(taskId);
    this.locks.release(taskId);
    this.capacity.release(taskId);
  }

  capacitySnapshot(): CapacitySnapshot {
    return this.capacity.snapshot();
  }

  setLiveRunnerLimit(maxLiveRunners: number): void {
    this.capacity.setLiveRunnerLimit(maxLiveRunners);
  }

  /**
   * Why this task may not start, or null when it may. Dependency checks run
   * before capacity so a task blocked on unfinished work is not reported as
   * competing for a slot it will never use.
   */
  private holdReason(
    task: Task,
    context: {
      byId: ReadonlyMap<string, Task>;
      cyclic: ReadonlySet<string>;
      done: ReadonlySet<string>;
      sessionsById: ReadonlyMap<string, CompanySession>;
    },
  ): { reason: DispatchHoldReason; detail: string } | null {
    if (!RUNNABLE_STATUSES.has(task.status)) {
      return { reason: 'status_not_runnable', detail: `${task.code} is ${task.status}.` };
    }
    if (this.dispatched.has(task.id)) {
      return {
        reason: 'already_dispatched',
        detail: `${task.code} already holds its lock and leases.`,
      };
    }
    if (context.cyclic.has(task.code)) {
      return { reason: 'dependency_cycle', detail: `${task.code} sits on a dependency cycle.` };
    }
    const unknown = task.dependsOn.filter((dependencyId) => !context.byId.has(dependencyId));
    if (unknown.length > 0) {
      return {
        reason: 'dependency_unknown',
        detail: `${task.code} depends on ${unknown.length} task(s) that are not in this Contract.`,
      };
    }
    const unfinished = task.dependsOn.filter((dependencyId) => !context.done.has(dependencyId));
    if (unfinished.length > 0) {
      return {
        reason: 'dependency_not_done',
        detail: `${task.code} waits on ${unfinished.length} unfinished task(s).`,
      };
    }
    if (task.sessionId) {
      const session = context.sessionsById.get(task.sessionId);
      if (session && BUSY_SESSION_STATUSES.has(session.status)) {
        return {
          reason: 'session_busy',
          detail: `${task.code} is assigned to ${session.code}, which is ${session.status}.`,
        };
      }
    }
    return null;
  }
}

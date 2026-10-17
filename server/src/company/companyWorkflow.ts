/**
 * companyWorkflow: the decisions that decide whether work may start.
 *
 * This module is deliberately pure. It answers four questions the rest of the
 * runtime asks constantly, and none of them need a process, a socket or a
 * model:
 *
 *   - Is this Contract schedulable at all? (cycles, empty acceptance, criteria
 *     that map to no requirement)
 *   - Which tasks may run right now, given dependencies and the worker bound?
 *   - Did the work actually pass? (evidence, not prose)
 *   - When do we stop asking a Worker to repair the same thing?
 *
 * Every rule here fails closed. An unknown dependency, a task whose scope
 * overlaps a running one, or a criterion with no successful evidence blocks
 * work rather than optimistically allowing it.
 */

import type {
  AcceptanceCriterion,
  Contract,
  Task,
  VerificationEvidence,
  WriteScope,
} from '../../../core/src/company.js';
import { COMPANY_MAX_WORKERS } from './constants.js';

export interface ContractIssue {
  code: string;
  message: string;
  taskCode?: string;
  requirementId?: string;
  criterionId?: string;
}

export interface ContractValidation {
  ok: boolean;
  issues: ContractIssue[];
}

export interface ScheduleLimits {
  maxWorkers: number;
}

export type HoldReason = 'dependency_not_done' | 'scope_conflict' | 'status_not_runnable';

export interface HeldTask {
  code: string;
  reason: HoldReason;
}

export interface SchedulePlan {
  runnable: Task[];
  /** Ready but waiting for a worker slot. */
  queued: Task[];
  held: HeldTask[];
}

export interface CriterionVerdict {
  id: string;
  passed: boolean;
  evidenceIds: string[];
  reason: string;
}

export interface VerificationVerdict {
  passed: boolean;
  criteria: CriterionVerdict[];
  issues: string[];
}

/** Task statuses the scheduler may start from. */
const RUNNABLE_STATUSES = new Set<Task['status']>(['planned', 'ready']);

/** Automatic repair cycles allowed after the first attempt. */
export const MAX_AUTOMATIC_REPAIR_CYCLES = 2;

// ── Path identity for scope conflict checks ──────────────────────────────

function normalizeScopePath(scopePath: string): string {
  const forwardSlashed = scopePath.replace(/\\/g, '/').replace(/^\.\//, '');
  // Folding unconditionally is the safe direction here: a false conflict
  // costs a queue slot, a missed one costs a corrupted tree.
  return forwardSlashed.toLowerCase();
}

function scopeContains(outer: string, inner: string): boolean {
  return inner === outer || inner.startsWith(`${outer}/`);
}

/**
 * Lexical overlap check on normalized write scopes: same file, or one scope
 * contains the other, or case-equivalent spellings.
 *
 * This is a PLANNER approximation and deliberately stays pure so scheduling
 * needs no filesystem access. A `false` result is NOT proof of disjointness:
 * a symlink or junction inside the workspace can make `src/link` and `lib/`
 * the same bytes on disk, and this check cannot see that. The dispatch path
 * must re-check the chosen scopes with realpaths before handing work to a
 * runner, and lock the whole workspace when a scope does not resolve.
 */
export function writeScopesOverlap(left: WriteScope[], right: WriteScope[]): boolean {
  for (const a of left) {
    for (const b of right) {
      const first = normalizeScopePath(a.path);
      const second = normalizeScopePath(b.path);
      if (a.kind === 'directory' || b.kind === 'directory') {
        if (scopeContains(first, second) || scopeContains(second, first)) return true;
      } else if (first === second) {
        return true;
      }
    }
  }
  return false;
}

// ── Graph checks ────────────────────────────────────────────────────────

/**
 * Codes of tasks that sit on a dependency cycle. An iterative colouring DFS
 * marks everything between a back edge and its target, so a loop is reported
 * once per member rather than as several overlapping "problems".
 */
export function detectDependencyCycles(tasks: Task[]): string[] {
  const byId = new Map(tasks.map((entry) => [entry.id, entry]));
  const state = new Map<string, 'visiting' | 'done'>();
  const inCycle = new Set<string>();

  for (const root of tasks) {
    if (state.has(root.id)) continue;
    const stack: Array<{ id: string; index: number }> = [{ id: root.id, index: 0 }];
    state.set(root.id, 'visiting');
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const current = byId.get(frame.id);
      const dependency = current?.dependsOn[frame.index];
      if (current === undefined || dependency === undefined) {
        state.set(frame.id, 'done');
        stack.pop();
        continue;
      }
      frame.index += 1;
      if (!byId.has(dependency)) continue; // unknown dependency: reported below
      const seen = state.get(dependency);
      if (seen === 'visiting') {
        const start = stack.findIndex((entry) => entry.id === dependency);
        for (const entry of stack.slice(start === -1 ? 0 : start)) inCycle.add(entry.id);
        continue;
      }
      if (seen === 'done') continue;
      state.set(dependency, 'visiting');
      stack.push({ id: dependency, index: 0 });
    }
  }

  return tasks.filter((entry) => inCycle.has(entry.id)).map((entry) => entry.code);
}

export function validateContract(contract: Contract): ContractValidation {
  const issues: ContractIssue[] = [];
  const tasks = contract.tasks;

  const codes = new Set<string>();
  for (const entry of tasks) {
    if (codes.has(entry.code)) {
      issues.push({
        code: 'task_code_duplicated',
        message: `Mã nhiệm vụ ${entry.code} xuất hiện nhiều lần hơn một.`,
        taskCode: entry.code,
      });
    }
    codes.add(entry.code);
  }

  const byId = new Set(tasks.map((entry) => entry.id));
  for (const entry of tasks) {
    if (entry.acceptance.length === 0) {
      issues.push({
        code: 'task_acceptance_empty',
        message: `Nhiệm vụ ${entry.code} không có tiêu chí nghiệm thu nào.`,
        taskCode: entry.code,
      });
    }
    for (const dependency of entry.dependsOn) {
      if (!byId.has(dependency)) {
        issues.push({
          code: 'task_dependency_unknown',
          message: `Nhiệm vụ ${entry.code} phụ thuộc vào một nhiệm vụ không có trong hợp đồng.`,
          taskCode: entry.code,
        });
      }
    }
  }

  for (const code of detectDependencyCycles(tasks)) {
    issues.push({
      code: 'contract_dependency_cycle',
      message: `Nhiệm vụ ${code} tham gia một vòng lặp phụ thuộc.`,
      taskCode: code,
    });
  }

  for (const criterion of contract.acceptance) {
    if (criterion.requirementIds.length === 0) {
      issues.push({
        code: 'criterion_without_requirement',
        message: 'Một tiêu chí nghiệm thu không ánh xạ tới yêu cầu nào.',
        criterionId: criterion.id,
      });
    }
  }

  // Every requirement must be planned for. An uncovered requirement is the
  // classic "the agent quietly dropped a third of the request" failure, so it
  // blocks approval instead of being discovered after the work runs.
  const taskedRequirements = new Set(tasks.flatMap((entry) => entry.requirementIds));
  for (const requirement of contract.requirements) {
    if (!taskedRequirements.has(requirement.id)) {
      issues.push({
        code: 'requirement_without_task',
        message: `Yêu cầu "${requirement.text}" chưa có nhiệm vụ nào được lên kế hoạch cho nó.`,
        requirementId: requirement.id,
      });
    }
  }

  return { ok: issues.length === 0, issues };
}

// ── Scheduling ───────────────────────────────────────────────────────────

/**
 * Choose what runs now. Callers pass tasks already ordered by phase ordinal
 * then creation order, and this function preserves that order.
 *
 * A task joins `runnable` only when its dependencies are done and its write
 * scopes do not collide with a task already selected. Everything else is either
 * `queued` (ready, waiting for a worker slot) or `held` (not startable yet), so
 * the UI can say which is which.
 */
export function selectReadyTasks(
  tasks: Task[],
  limits: ScheduleLimits = { maxWorkers: COMPANY_MAX_WORKERS },
): SchedulePlan {
  const done = new Set(
    tasks
      .filter((entry) => entry.status === 'done' || entry.status === 'verifying')
      .map((entry) => entry.id),
  );
  const runnable: Task[] = [];
  const queued: Task[] = [];
  const held: HeldTask[] = [];

  for (const entry of tasks) {
    if (!RUNNABLE_STATUSES.has(entry.status)) {
      held.push({ code: entry.code, reason: 'status_not_runnable' });
      continue;
    }
    if (entry.dependsOn.some((dependency) => !done.has(dependency))) {
      held.push({ code: entry.code, reason: 'dependency_not_done' });
      continue;
    }
    const clashes = runnable.some((selected) =>
      writeScopesOverlap(selected.writeScopes, entry.writeScopes),
    );
    if (clashes) {
      held.push({ code: entry.code, reason: 'scope_conflict' });
      continue;
    }
    if (runnable.length >= limits.maxWorkers) {
      queued.push(entry);
      continue;
    }
    runnable.push(entry);
  }

  return { runnable, queued, held };
}

// ── Verification ─────────────────────────────────────────────────────────

/**
 * Decide pass/fail from evidence alone.
 *
 * A criterion passes only when some command mapped to it exited 0. A missing
 * exit code (timeout, kill) is a failure, never a pass. Optional criteria are
 * evaluated and reported but never block the verdict.
 *
 * Evidence identifies the COMMAND it ran, not the criterion, so the caller
 * supplies the criterion -> command-id mapping from the Contract's
 * VerificationProfiles.
 */
export function evaluateVerification(
  criteria: readonly AcceptanceCriterion[],
  commandsByCriterion: ReadonlyMap<string, readonly string[]>,
  evidence: readonly VerificationEvidence[],
): VerificationVerdict {
  const verdicts: CriterionVerdict[] = [];
  const issues: string[] = [];

  for (const criterion of criteria) {
    const commandIds = new Set(commandsByCriterion.get(criterion.id) ?? []);
    const matching = evidence.filter((entry) => commandIds.has(entry.command.id));
    const passing = matching.filter((entry) => entry.exitCode === 0);

    if (passing.length > 0) {
      verdicts.push({
        id: criterion.id,
        passed: true,
        evidenceIds: passing.map((entry) => entry.id),
        reason: 'Verification command exited 0.',
      });
      continue;
    }

    const timedOut = matching.filter((entry) => entry.exitCode === undefined);
    const reason =
      matching.length === 0
        ? 'No verification evidence was recorded for this criterion.'
        : timedOut.length > 0
          ? 'Verification produced no exit code (timeout or kill); that is a failure, never a pass.'
          : 'Verification command did not exit 0.';

    verdicts.push({
      id: criterion.id,
      passed: false,
      evidenceIds: matching.map((entry) => entry.id),
      reason,
    });
    if (criterion.required) issues.push(`${criterion.id}: ${reason}`);
  }

  const requiredVerdicts = verdicts.filter((verdict) =>
    criteria.some((criterion) => criterion.id === verdict.id && criterion.required),
  );
  return {
    passed: requiredVerdicts.every((verdict) => verdict.passed),
    criteria: verdicts,
    issues,
  };
}

// ── Repair bound ─────────────────────────────────────────────────────────

/**
 * How a failed attempt is handled. Two automatic repair cycles after the first
 * attempt; after that the task fails and waits for the user, so a failing task
 * can never loop on the model forever.
 */
export function nextAttemptOutcome(attemptsSoFar: number): {
  status: 'changes_requested' | 'failed';
  repairCycles: number;
} {
  // Attempt 1 failing earns the first repair, attempt 2 the second; a third
  // failure is terminal.
  if (attemptsSoFar > MAX_AUTOMATIC_REPAIR_CYCLES) {
    return { status: 'failed', repairCycles: MAX_AUTOMATIC_REPAIR_CYCLES };
  }
  return { status: 'changes_requested', repairCycles: attemptsSoFar };
}

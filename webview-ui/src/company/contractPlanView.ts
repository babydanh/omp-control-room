import type {
  Contract,
  Requirement,
  Task,
  VerificationEvidence,
} from '../../../core/src/company.js';

/**
 * contractPlanView: the explanation shown BEFORE a Contract is approved.
 *
 * The panel's job is to answer "what exactly am I about to let this run?" — the
 * goals as the user phrased them, the phases in order, the tasks with their
 * dependencies and the exact paths they may write, and the acceptance criteria
 * with their current evidence state.
 *
 * It also refuses to say "approve" when the plan has a hole. A requirement
 * nobody planned for, a task with no acceptance criterion, or a Contract with
 * no criteria at all are gaps, and gaps block approval with a sentence the
 * user can act on. Presenting a confident plan over an incomplete one is worse
 * than presenting it unfinished.
 *
 * Pure and DOM-free: the renderer consumes this, and the node test suite
 * exercises it directly.
 */

export type PlanGapCode =
  'requirement_without_task' | 'task_without_acceptance' | 'contract_without_acceptance';

export interface PlanGap {
  code: PlanGapCode;
  message: string;
}

export interface PlanGoalView {
  id: string;
  text: string;
  kind: Requirement['kind'];
  covered: boolean;
  taskCodes: string[];
}

export interface PlanTaskView {
  code: string;
  title: string;
  status: Task['status'];
  dependsOnCodes: string[];
  writeScopes: string[];
  readScopes: string[];
  routeReason: string;
}

export interface PlanPhaseView {
  id: string;
  title: string;
  ordinal: number;
  tasks: PlanTaskView[];
  acceptanceIds: string[];
}

export type AcceptanceState = 'passed' | 'failed' | 'not_run';

export interface PlanAcceptanceView {
  id: string;
  description: string;
  required: boolean;
  state: AcceptanceState;
  evidenceCount: number;
}

export interface ContractPlanView {
  code: string;
  revision: number;
  status: Contract['status'];
  goals: PlanGoalView[];
  phases: PlanPhaseView[];
  acceptance: PlanAcceptanceView[];
  gaps: PlanGap[];
  approvalBlockers: string[];
  canApprove: boolean;
  summary: {
    requirementCount: number;
    coveredRequirementCount: number;
    taskCount: number;
    scopeCount: number;
    assumptionCount: number;
    decisionCount: number;
  };
}

function scopeLabel(path: string, kind: 'file' | 'directory'): string {
  return kind === 'directory' ? `${path}/` : path;
}

export function buildContractPlanView(
  contract: Contract,
  commandsByCriterion: ReadonlyMap<string, readonly string[]> = new Map(),
  evidence: readonly VerificationEvidence[] = [],
): ContractPlanView {
  const tasksById = new Map(contract.tasks.map((task) => [task.id, task]));
  const codeOf = (id: string): string => tasksById.get(id)?.code ?? id;

  const goals: PlanGoalView[] = contract.requirements.map((requirement) => {
    const covering = contract.tasks.filter((task) => task.requirementIds.includes(requirement.id));
    return {
      id: requirement.id,
      text: requirement.text,
      kind: requirement.kind,
      covered: covering.length > 0,
      taskCodes: covering.map((task) => task.code),
    };
  });

  const tasksInPhase = (phaseId: string): PlanTaskView[] =>
    contract.tasks
      .filter((task) => task.phaseId === phaseId)
      .map((task) => ({
        code: task.code,
        title: task.title,
        status: task.status,
        dependsOnCodes: task.dependsOn.map(codeOf),
        writeScopes: task.writeScopes.map((scope) => scopeLabel(scope.path, scope.kind)),
        readScopes: task.readScopes.map((scope) => scopeLabel(scope.path, scope.kind)),
        routeReason: task.routeReason,
      }));

  const phases: PlanPhaseView[] = [...contract.phases]
    .sort((left, right) => left.ordinal - right.ordinal)
    .map((phase) => ({
      id: phase.id,
      title: phase.title,
      ordinal: phase.ordinal,
      tasks: tasksInPhase(phase.id),
      acceptanceIds: [...phase.acceptanceIds],
    }));

  // A task in no phase is still part of the plan; show it rather than hide it.
  const phased = new Set(contract.phases.map((phase) => phase.id));
  const orphans = contract.tasks.filter((task) => !phased.has(task.phaseId));
  if (orphans.length > 0) {
    phases.push({
      id: 'unscheduled',
      title: 'Chưa xếp lịch',
      ordinal: Number.MAX_SAFE_INTEGER,
      tasks: orphans.map((task) => ({
        code: task.code,
        title: task.title,
        status: task.status,
        dependsOnCodes: task.dependsOn.map(codeOf),
        writeScopes: task.writeScopes.map((scope) => scopeLabel(scope.path, scope.kind)),
        readScopes: task.readScopes.map((scope) => scopeLabel(scope.path, scope.kind)),
        routeReason: task.routeReason,
      })),
      acceptanceIds: [],
    });
  }

  const acceptance: PlanAcceptanceView[] = contract.acceptance.map((criterion) => {
    const commandIds = new Set(commandsByCriterion.get(criterion.id) ?? []);
    const matching = evidence.filter((entry) => commandIds.has(entry.command.id));
    const passing = matching.filter((entry) => entry.exitCode === 0);
    const state: AcceptanceState =
      passing.length > 0 ? 'passed' : matching.length > 0 ? 'failed' : 'not_run';
    return {
      id: criterion.id,
      description: criterion.description,
      required: criterion.required,
      state,
      evidenceCount: matching.length,
    };
  });

  const gaps: PlanGap[] = [];
  for (const goal of goals.filter((entry) => !entry.covered)) {
    gaps.push({
      code: 'requirement_without_task',
      message: `"${goal.text}" chưa có nhiệm vụ nào được lên kế hoạch cho nó.`,
    });
  }
  for (const task of contract.tasks.filter((entry) => entry.acceptance.length === 0)) {
    gaps.push({
      code: 'task_without_acceptance',
      message: `${task.code} (${task.title}) không nêu tiêu chí nghiệm thu nào.`,
    });
  }
  if (contract.acceptance.length === 0) {
    gaps.push({
      code: 'contract_without_acceptance',
      message:
        'Hợp đồng này không có tiêu chí nghiệm thu nào, nên không có gì chứng minh nó đã xong.',
    });
  }

  const scopes = new Set<string>();
  for (const task of contract.tasks) {
    for (const scope of task.writeScopes) scopes.add(scopeLabel(scope.path, scope.kind));
  }

  return {
    code: contract.code,
    revision: contract.revision,
    status: contract.status,
    goals,
    phases,
    acceptance,
    gaps,
    approvalBlockers: gaps.map((gap) => gap.message),
    canApprove: gaps.length === 0,
    summary: {
      requirementCount: goals.length,
      coveredRequirementCount: goals.filter((goal) => goal.covered).length,
      taskCount: contract.tasks.length,
      scopeCount: scopes.size,
      assumptionCount: contract.assumptions.length,
      decisionCount: contract.decisions.length,
    },
  };
}

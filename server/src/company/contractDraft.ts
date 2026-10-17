import { randomUUID } from 'node:crypto';

import type {
  AcceptanceCriterion,
  CompanyEvent,
  CompanyState,
  Contract,
  Phase,
  RelatedWorkspaceFile,
  Requirement,
  Task,
  VerificationCommand,
  VerificationProfile,
} from '../../../core/src/company.js';
import { CompanyError } from './companyError.js';
import { type ContractIssue, validateContractDraft } from './contractValidator.js';

/** A task proposal omits fields the coordinator, not the model, owns. */
export type ProposedTask = Omit<
  Task,
  'code' | 'contractId' | 'status' | 'attemptIds' | 'sessionId'
>;

/** Model-authored plan fields. Identity, revision, status and codes are server-owned. */
export interface ContractDraftProposal {
  title?: string;
  summary?: string;
  requirements: Requirement[];
  phases: Phase[];
  tasks: ProposedTask[];
  assumptions: string[];
  decisions: string[];
  risks?: string[];
  acceptance: AcceptanceCriterion[];
  relatedFiles?: RelatedWorkspaceFile[];
  /**
   * Which discovered verification profile proves each acceptance criterion.
   *
   * A binding only: the coordinator resolves the profile this workspace already
   * discovered and takes its command from there, so a proposal can never
   * introduce a command to run.
   */
  verificationProfiles?: Readonly<Record<string, unknown>>;
}

export interface ContractDraftInput {
  promptId: string;
  proposal: ContractDraftProposal;
  /** Keyed by acceptance-criterion id, as persisted in CompanySettings. */
  verificationProfiles: Readonly<Record<string, VerificationProfile>>;
  now: string;
  newEvent: { id: string };
}

export class ContractDraftValidationError extends CompanyError {
  readonly issues: readonly ContractIssue[];

  constructor(issues: readonly ContractIssue[]) {
    super('contract_draft_invalid', issues.map((entry) => entry.message).join(' '));
    this.issues = issues;
  }
}

function assertDraftShape(input: ContractDraftInput): void {
  const { proposal, verificationProfiles } = input;
  const hasObjectItems = (items: readonly unknown[]): boolean =>
    items.every((value) => value !== null && typeof value === 'object' && !Array.isArray(value));
  if (
    proposal === null ||
    typeof proposal !== 'object' ||
    Array.isArray(proposal) ||
    !Array.isArray(proposal.requirements) ||
    !Array.isArray(proposal.phases) ||
    !Array.isArray(proposal.tasks) ||
    !Array.isArray(proposal.assumptions) ||
    !Array.isArray(proposal.decisions) ||
    !Array.isArray(proposal.acceptance) ||
    verificationProfiles === null ||
    typeof verificationProfiles !== 'object' ||
    Array.isArray(verificationProfiles) ||
    !hasObjectItems(proposal.requirements) ||
    !hasObjectItems(proposal.phases) ||
    !hasObjectItems(proposal.tasks) ||
    !hasObjectItems(proposal.acceptance) ||
    !Object.values(verificationProfiles).every(
      (profile) => profile !== null && typeof profile === 'object' && !Array.isArray(profile),
    )
  ) {
    throw new CompanyError(
      'contract_draft_malformed',
      'The Director returned a malformed Contract draft.',
    );
  }
}

function formatCode(prefix: 'PA-C' | 'PA-T', ordinal: number): string {
  return `${prefix}${String(ordinal).padStart(4, '0')}`;
}

function assertUuidIds(proposal: ContractDraftProposal): void {
  const ids = [
    ...proposal.requirements.map((entry) => entry.id),
    ...proposal.phases.map((entry) => entry.id),
    ...proposal.tasks.map((entry) => entry.id),
    ...proposal.acceptance.map((entry) => entry.id),
  ];
  const seen = new Set<string>();
  for (const id of ids) {
    if (
      typeof id !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(id)
    ) {
      throw new CompanyError(
        'contract_draft_id_invalid',
        'Every proposed requirement, phase, task, and criterion needs a UUID.',
      );
    }
    if (seen.has(id)) {
      throw new CompanyError('contract_draft_id_duplicated', `The draft reuses entity id ${id}.`);
    }
    seen.add(id);
  }
}

function assertUniqueAgainstState(
  state: CompanyState,
  proposal: ContractDraftProposal,
  replaced: Contract | undefined,
): void {
  // The draft being revised is replaced whole in the same event, so its ids are
  // free to reuse: a revision that keeps its requirement ids is the same plan.
  const used = new Set<string>();
  for (const contract of Object.values(state.contracts)) {
    if (contract.id === replaced?.id) continue;
    for (const requirement of contract.requirements) used.add(requirement.id);
    for (const phase of contract.phases) used.add(phase.id);
    for (const task of contract.tasks) used.add(task.id);
    for (const criterion of contract.acceptance) used.add(criterion.id);
  }
  const replacedTasks = new Set(replaced?.tasks.map((task) => task.id) ?? []);
  for (const taskId of Object.keys(state.tasks)) {
    if (!replacedTasks.has(taskId)) used.add(taskId);
  }

  const proposed = [
    ...proposal.requirements.map((entry) => entry.id),
    ...proposal.phases.map((entry) => entry.id),
    ...proposal.tasks.map((entry) => entry.id),
    ...proposal.acceptance.map((entry) => entry.id),
  ];
  const collision = proposed.find((id) => used.has(id));
  if (collision) {
    throw new CompanyError(
      'contract_draft_id_conflict',
      `The draft reuses an existing Company entity id: ${collision}.`,
    );
  }
}

function normalizeRequirement(value: Requirement): Requirement {
  return {
    id: value.id,
    promptId: value.promptId,
    fragmentIds: [...value.fragmentIds],
    text: value.text,
    kind: value.kind,
    status: value.status,
  };
}

function normalizePhase(value: Phase): Phase {
  return {
    id: value.id,
    title: value.title,
    ordinal: value.ordinal,
    taskIds: [...value.taskIds],
    acceptanceIds: [...value.acceptanceIds],
  };
}

function normalizeTask(value: ProposedTask, contractId: string, code: string): Task {
  const task: Task = {
    id: value.id,
    code,
    contractId,
    phaseId: value.phaseId,
    title: value.title,
    requirementIds: [...value.requirementIds],
    dependsOn: [...value.dependsOn],
    workstreamId: value.workstreamId,
    readScopes: value.readScopes.map((scope) => ({
      path: scope.path,
      kind: scope.kind,
      operations: [...scope.operations],
    })),
    writeScopes: value.writeScopes.map((scope) => ({
      path: scope.path,
      kind: scope.kind,
      operations: [...scope.operations],
    })),
    sharedResources: [...value.sharedResources],
    acceptance: [...value.acceptance],
    executionMode: value.executionMode,
    status: 'planned',
    attemptIds: [],
    routeReason: value.routeReason,
  };
  if (value.relatedFiles !== undefined) {
    task.relatedFiles = value.relatedFiles.map((file) => ({
      path: file.path,
      relation: file.relation,
      ...(file.reason === undefined ? {} : { reason: file.reason }),
      ...(file.artifactId === undefined ? {} : { artifactId: file.artifactId }),
    }));
  }
  return task;
}

function normalizeCriterion(value: AcceptanceCriterion): AcceptanceCriterion {
  return {
    id: value.id,
    requirementIds: [...value.requirementIds],
    description: value.description,
    kind: value.kind,
    required: value.required,
  };
}

function normalizeVerificationProfile(value: VerificationProfile): VerificationProfile {
  return {
    id: value.id,
    criterionIds: [...value.criterionIds],
    commands: value.commands.map((command: VerificationCommand) => ({
      id: command.id,
      executable: command.executable,
      argv: [...command.argv],
      cwd: command.cwd,
      timeoutSeconds: command.timeoutSeconds,
    })),
    prerequisites: [...value.prerequisites],
    outputScopes: [...value.outputScopes],
  };
}

function normalizeProfiles(
  profiles: Readonly<Record<string, VerificationProfile>>,
): Record<string, VerificationProfile> {
  return Object.fromEntries(
    Object.entries(profiles).map(([criterionId, profile]) => [
      criterionId,
      normalizeVerificationProfile(profile),
    ]),
  );
}

function ensureDraftCanBeRevised(state: CompanyState, contract: Contract): void {
  if (contract.status !== 'clarifying' && contract.status !== 'architecture_review') {
    throw new CompanyError(
      'contract_revision_closed',
      `Contract ${contract.code} cannot be revised while it is ${contract.status}.`,
    );
  }
  const tasks = contract.tasks.map((task) => state.tasks[task.id] ?? task);
  if (
    tasks.some(
      (task) =>
        task.attemptIds.length > 0 || task.sessionId !== undefined || task.status !== 'planned',
    )
  ) {
    throw new CompanyError(
      'contract_revision_has_work',
      `Contract ${contract.code} has started work and cannot be replaced as a draft.`,
    );
  }
}

/**
 * Validate a Director proposal before creating one atomic journal event. The
 * coordinator owns IDs, codes, status, revisions and the persisted verifier map.
 */
export function createContractDraft(
  state: CompanyState,
  input: ContractDraftInput,
): { events: CompanyEvent[] } {
  assertDraftShape(input);
  const prompt = state.prompts[input.promptId];
  if (!prompt) {
    throw new CompanyError('prompt_not_found', `Unknown prompt: ${input.promptId}`);
  }
  assertUuidIds(input.proposal);

  // A prompt names the Contract it revises, or it is planned for the first time.
  // A Director that submits again for the same prompt -- after an Advisor asked
  // for changes -- is revising that draft, not opening a second Contract.
  const existing =
    prompt.targetContractId === undefined
      ? Object.values(state.contracts).find((contract) => contract.promptIds.includes(prompt.id))
      : state.contracts[prompt.targetContractId];
  if (prompt.targetContractId !== undefined && existing === undefined) {
    throw new CompanyError(
      'contract_not_found',
      `Unknown target Contract: ${prompt.targetContractId}`,
    );
  }
  if (existing) ensureDraftCanBeRevised(state, existing);
  assertUniqueAgainstState(state, input.proposal, existing);

  const contractId = existing?.id ?? randomUUID();
  const contractCode = existing?.code ?? formatCode('PA-C', state.counters.contract + 1);
  const revision = (existing?.revision ?? 0) + 1;
  const taskOffset = state.counters.task;
  const requirements = input.proposal.requirements.map(normalizeRequirement);
  const phases = input.proposal.phases.map(normalizePhase);
  const acceptance = input.proposal.acceptance.map(normalizeCriterion);
  const tasks = input.proposal.tasks.map((task, index) =>
    normalizeTask(task, contractId, formatCode('PA-T', taskOffset + index + 1)),
  );
  const verificationProfiles = normalizeProfiles(input.verificationProfiles);
  const mergedProfiles = { ...state.settings.verificationProfiles, ...verificationProfiles };
  // Which tasks sit in a phase, and which criteria those tasks verify, are
  // SERVER-owned linkage: the task ids are minted below, so a Director cannot
  // name them. Deriving the membership means a draft states only what a human
  // wrote — the task's own `phaseId` — and the graph is consistent by
  // construction instead of by a model repeating ids it was never given.
  const phasesWithDerivedMembership = phases.map((phase) => {
    const phaseTasks = tasks.filter((task) => task.phaseId === phase.id);
    const criterionIds = [...new Set(phaseTasks.flatMap((task) => [...task.acceptance]))];
    return {
      ...phase,
      taskIds: phaseTasks.map((task) => task.id),
      acceptanceIds: criterionIds.filter((id) =>
        acceptance.some((criterion) => criterion.id === id),
      ),
    };
  });
  const candidate: Contract = {
    id: contractId,
    code: contractCode,
    revision,
    ...(input.proposal.title === undefined ? {} : { title: input.proposal.title }),
    ...(input.proposal.summary === undefined ? {} : { summary: input.proposal.summary }),
    promptIds: [...new Set([...(existing?.promptIds ?? []), prompt.id])],
    requirements,
    phases: phasesWithDerivedMembership,
    tasks,
    assumptions: [...input.proposal.assumptions],
    decisions: [...input.proposal.decisions],
    ...(input.proposal.risks === undefined ? {} : { risks: [...input.proposal.risks] }),
    acceptance,
    ...(existing?.architectureReviews === undefined
      ? {}
      : { architectureReviews: [...existing.architectureReviews] }),
    ...(input.proposal.relatedFiles === undefined
      ? {}
      : { relatedFiles: input.proposal.relatedFiles.map((file) => ({ ...file })) }),
    status: 'architecture_review',
  };
  const validation = validateContractDraft(candidate, prompt, mergedProfiles);
  if (!validation.ok) throw new ContractDraftValidationError(validation.issues);

  const changes: CompanyEvent['changes'] = [];
  if (existing) {
    for (const task of existing.tasks) changes.push({ entity: 'task', op: 'remove', id: task.id });
  }
  changes.push({ entity: 'contract', op: 'put', id: contractId, value: candidate });
  for (const task of tasks) changes.push({ entity: 'task', op: 'put', id: task.id, value: task });
  if (Object.keys(verificationProfiles).length > 0) {
    changes.push({
      entity: 'settings',
      op: 'put',
      id: 'settings',
      value: { ...state.settings, verificationProfiles: mergedProfiles },
    });
  }
  changes.push({
    entity: 'counters',
    op: 'put',
    id: 'counters',
    value: {
      ...state.counters,
      contract: state.counters.contract + (existing ? 0 : 1),
      task: state.counters.task + tasks.length,
    },
  });

  return {
    events: [
      {
        id: input.newEvent.id || randomUUID(),
        sequence: state.revision + 1,
        at: input.now,
        baseRevision: state.revision,
        changes,
      },
    ],
  };
}

/**
 * contractValidator: may this Contract be put in front of the user?
 *
 * `companyWorkflow.validateContract` answers the structural question — can this
 * DAG be scheduled at all. This module answers the question before that one:
 * does this Contract actually answer the request it claims to answer? It takes
 * the proposed record together with the stored prompt that produced it and the
 * verification profiles the company has configured, and reports every
 * disagreement provable from those three values alone.
 *
 * It is pure and total: no filesystem, no clock, no network, no mutation of
 * its arguments. Symlink, junction and realpath escapes need the workspace on
 * disk and belong to the coordinator, which checks again immediately before
 * dispatch — the lexical checks here stop a malformed draft, not a clever one.
 *
 * Every rule fails closed. A prompt fragment nobody classified, a required
 * command with no configured way to run it, a scope that leaves the workspace,
 * or a phase that claims another phase's criterion all block approval instead
 * of being assumed harmless.
 */

import type {
  AcceptanceCriterion,
  CompanyPrompt,
  Contract,
  Phase,
  Requirement,
  Task,
  VerificationCommand,
  VerificationProfile,
} from '../../../core/src/company.js';
import type { ContractIssue, ContractValidation } from './companyWorkflow.js';
import { validateContract } from './companyWorkflow.js';

export type { ContractIssue, ContractValidation };

const READ_OPERATIONS: ReadonlySet<string> = new Set(['read', 'list', 'search']);
const WRITE_OPERATIONS: ReadonlySet<string> = new Set(['create', 'modify']);
const SCOPE_KINDS: ReadonlySet<string> = new Set(['file', 'directory']);
const CRITERION_KINDS: ReadonlySet<string> = new Set(['command', 'surface', 'review']);
/** A verification command that asks to run for a day is a typo, not a suite. */
const MAX_VERIFICATION_TIMEOUT_SECONDS = 86_400;

/** How a declared path fails to be a normalized workspace-relative path. */
type WorkspacePathProblem =
  'empty' | 'absolute' | 'drive_prefix' | 'segment_empty' | 'traversal' | 'not_normalized';

const PATH_PROBLEM_DETAIL: Readonly<Record<WorkspacePathProblem, string>> = {
  empty: 'is empty',
  absolute: 'is absolute instead of workspace-relative',
  drive_prefix: 'carries a drive prefix instead of being workspace-relative',
  segment_empty: 'has an empty path segment',
  traversal: 'contains a "." or ".." segment, which can leave the workspace',
  not_normalized: 'is not a normalized workspace-relative path',
};

/**
 * Classify a declared path lexically. Realpath, symlink and junction escapes
 * are the coordinator's check, run immediately before dispatch.
 */
function classifyWorkspacePath(raw: unknown): WorkspacePathProblem | null {
  if (typeof raw !== 'string' || raw.length === 0) return 'empty';
  if (raw !== raw.trim()) return 'not_normalized';
  if (raw.startsWith('/') || raw.startsWith('\\')) return 'absolute';
  if (/^[a-zA-Z]:/u.test(raw)) return 'drive_prefix';
  if (raw.includes('\\')) return 'not_normalized';
  for (let index = 0; index < raw.length; index += 1) {
    const code = raw.charCodeAt(index);
    // Control characters, NUL included, are never part of a declared path.
    if (code < 0x20 || code === 0x7f) return 'not_normalized';
  }
  for (const segment of raw.split('/')) {
    if (segment.length === 0) return 'segment_empty';
    if (segment === '.' || segment === '..') return 'traversal';
    if (segment.includes(':')) return 'not_normalized';
  }
  return null;
}

/** Model-authored arrays arrive as JSON; treat anything else as empty. */
function list<T>(value: readonly T[] | undefined): readonly T[] {
  return Array.isArray(value) ? value : [];
}

function issue(code: string, message: string, detail?: Partial<ContractIssue>): ContractIssue {
  return detail ? { code, message, ...detail } : { code, message };
}

/** Human label for a requirement that has to stay legible in a correction. */
function requirementLabel(requirement: Requirement): string {
  const text = typeof requirement.text === 'string' ? requirement.text.trim() : '';
  return text.length > 0 ? `"${text.slice(0, 60)}"` : requirement.id;
}

// ── Prompt ↔ contract ───────────────────────────────────────────────────

function validatePromptLink(
  contract: Contract,
  prompt: CompanyPrompt,
  issues: ContractIssue[],
): void {
  const promptIds = list(contract.promptIds);
  if (!promptIds.includes(prompt.id)) {
    issues.push(
      issue(
        'contract_prompt_missing',
        `The Contract does not list prompt ${prompt.id}, which is the request it was written for.`,
      ),
    );
  }
  const linked = new Set<string>();
  for (const promptId of promptIds) {
    if (linked.has(promptId)) {
      issues.push(
        issue(
          'contract_prompt_duplicated',
          `The Contract lists prompt ${promptId} more than once.`,
        ),
      );
    }
    linked.add(promptId);
  }

  const fragments = list(prompt.fragments);
  if (fragments.length === 0) {
    issues.push(
      issue(
        'prompt_without_fragments',
        `Prompt ${prompt.id} was split into no fragments, so nothing here can be checked against the request.`,
      ),
    );
  }
  const seen = new Set<string>();
  for (const fragment of fragments) {
    if (seen.has(fragment.id)) {
      issues.push(
        issue(
          'prompt_fragment_duplicated',
          `Prompt fragment ${fragment.id} appears twice, so its coverage cannot be counted.`,
        ),
      );
    }
    seen.add(fragment.id);
  }
}

// ── Requirements and prompt coverage ────────────────────────────────────

/**
 * Every fragment must be classified, and classified once. A fragment nobody
 * read is the silent "the agent dropped a third of the request" failure; a
 * fragment two requirements claim means the plan disagrees with itself.
 */
function validateRequirements(
  contract: Contract,
  prompt: CompanyPrompt,
  issues: ContractIssue[],
): void {
  const fragmentIds = new Set(list(prompt.fragments).map((fragment) => fragment.id));
  const owners = new Map<string, Set<string>>();
  const requirementIds = new Set<string>();

  for (const requirement of list(contract.requirements)) {
    if (requirementIds.has(requirement.id)) {
      issues.push(
        issue(
          'requirement_id_duplicated',
          `Requirement id ${requirement.id} is used by more than one requirement.`,
          { requirementId: requirement.id },
        ),
      );
    }
    requirementIds.add(requirement.id);

    if (typeof requirement.text !== 'string' || requirement.text.trim().length === 0) {
      issues.push(
        issue('requirement_text_empty', 'A requirement has no text to read.', {
          requirementId: requirement.id,
        }),
      );
    }
    if (requirement.promptId !== prompt.id) {
      issues.push(
        issue(
          'requirement_prompt_unknown',
          `Requirement ${requirementLabel(requirement)} belongs to prompt ${requirement.promptId}, not to the prompt this Contract answers.`,
          { requirementId: requirement.id },
        ),
      );
      continue;
    }

    const claimed = list(requirement.fragmentIds);
    if (claimed.length === 0) {
      issues.push(
        issue(
          'requirement_fragment_empty',
          `Requirement ${requirementLabel(requirement)} classifies none of the prompt fragments.`,
          { requirementId: requirement.id },
        ),
      );
    }
    const seen = new Set<string>();
    for (const fragmentId of claimed) {
      if (seen.has(fragmentId)) {
        issues.push(
          issue(
            'requirement_fragment_duplicated',
            `Requirement ${requirementLabel(requirement)} lists fragment ${fragmentId} twice.`,
            { requirementId: requirement.id },
          ),
        );
        continue;
      }
      seen.add(fragmentId);
      if (!fragmentIds.has(fragmentId)) {
        issues.push(
          issue(
            'requirement_fragment_unknown',
            `Requirement ${requirementLabel(requirement)} lists fragment ${fragmentId}, which is not a fragment of prompt ${prompt.id}.`,
            { requirementId: requirement.id },
          ),
        );
        continue;
      }
      const covering = owners.get(fragmentId) ?? new Set<string>();
      covering.add(requirement.id);
      owners.set(fragmentId, covering);
    }
  }

  for (const fragment of list(prompt.fragments)) {
    const covering = owners.get(fragment.id);
    if (!covering || covering.size === 0) {
      issues.push(
        issue(
          'prompt_fragment_uncovered',
          `Prompt fragment ${fragment.ordinal + 1} is not classified by any requirement.`,
        ),
      );
    } else if (covering.size > 1) {
      issues.push(
        issue(
          'prompt_fragment_covered_twice',
          `Prompt fragment ${fragment.ordinal + 1} is claimed by ${covering.size} requirements, so the plan disagrees with itself.`,
        ),
      );
    }
  }
}

// ── Acceptance criteria ─────────────────────────────────────────────────

function validateCriteria(
  contract: Contract,
  requirementIds: ReadonlySet<string>,
  issues: ContractIssue[],
): Map<string, AcceptanceCriterion> {
  const byId = new Map<string, AcceptanceCriterion>();
  for (const criterion of list(contract.acceptance)) {
    if (byId.has(criterion.id)) {
      issues.push(
        issue(
          'criterion_id_duplicated',
          `Acceptance criterion id ${criterion.id} is used by more than one criterion.`,
          { criterionId: criterion.id },
        ),
      );
    }
    byId.set(criterion.id, criterion);

    if (typeof criterion.description !== 'string' || criterion.description.trim().length === 0) {
      issues.push(
        issue('criterion_description_empty', 'An acceptance criterion has no description.', {
          criterionId: criterion.id,
        }),
      );
    }
    if (!CRITERION_KINDS.has(criterion.kind)) {
      issues.push(
        issue(
          'criterion_kind_invalid',
          `Acceptance criterion "${criterion.description}" has kind ${String(criterion.kind)}, which is not command, surface or review.`,
          { criterionId: criterion.id },
        ),
      );
    }

    const seen = new Set<string>();
    for (const requirementId of list(criterion.requirementIds)) {
      if (seen.has(requirementId)) {
        issues.push(
          issue(
            'criterion_requirement_duplicated',
            `Acceptance criterion "${criterion.description}" lists requirement ${requirementId} twice.`,
            { criterionId: criterion.id, requirementId },
          ),
        );
        continue;
      }
      seen.add(requirementId);
      if (!requirementIds.has(requirementId)) {
        issues.push(
          issue(
            'criterion_requirement_unknown',
            `Acceptance criterion "${criterion.description}" refers to requirement ${requirementId}, which this Contract does not define.`,
            { criterionId: criterion.id, requirementId },
          ),
        );
      }
    }
  }
  return byId;
}

// ── Verification profiles ───────────────────────────────────────────────

/**
 * Profiles are keyed by acceptance criterion id, so one profile may serve
 * several criteria by appearing under several keys with the same value. Claims
 * are therefore counted per profile VALUE: the same profile serving two
 * criteria resolves to one, while two different profiles claiming one criterion
 * is a conflict nobody can run deterministically.
 */
function validateVerification(
  contract: Contract,
  criteriaById: ReadonlyMap<string, AcceptanceCriterion>,
  verificationProfiles: Readonly<Record<string, VerificationProfile>>,
  issues: ContractIssue[],
): void {
  const claimants = new Map<string, Set<VerificationProfile>>();
  for (const [key, profile] of Object.entries(verificationProfiles)) {
    const criterionIds = list(profile.criterionIds);
    // A profile that serves no criterion of this contract is another
    // contract's business, or an unbound profile discovery left in settings.
    // Its key has nothing to be consistent with HERE, so it is skipped before
    // the key rule: a workspace that discovered its `test` script holds a
    // profile keyed `test` claiming nothing, and that is not a defect of this
    // Contract.
    if (!criterionIds.some((criterionId) => criteriaById.has(criterionId))) continue;
    if (!criterionIds.includes(key)) {
      issues.push(
        issue(
          'verification_profile_key_unmatched',
          `Verification profile "${profile.id}" is keyed by ${key} but does not claim that criterion.`,
        ),
      );
    }

    for (const criterionId of criterionIds) {
      if (!criteriaById.has(criterionId) && !(criterionId in verificationProfiles)) {
        issues.push(
          issue(
            'verification_profile_criterion_unknown',
            `Verification profile "${profile.id}" claims acceptance criterion ${criterionId}, which this Contract does not define and the company never keyed.`,
          ),
        );
      }
      const claiming = claimants.get(criterionId) ?? new Set<VerificationProfile>();
      claiming.add(profile);
      claimants.set(criterionId, claiming);
    }

    const commands = list(profile.commands);
    if (commands.length === 0) {
      issues.push(
        issue(
          'verification_profile_without_commands',
          `Verification profile "${profile.id}" runs no command, so it can produce no evidence.`,
        ),
      );
    }
    const commandIds = new Set<string>();
    for (const command of commands) {
      validateCommand(command, profile.id, commandIds, issues);
    }
  }

  for (const criterion of list(contract.acceptance)) {
    if (criterion.required === false) continue;
    // Done is earned only from a command that exited 0, so a required
    // "review" or "surface" criterion can never pass: the approved Contract
    // would sit in verification forever. Refusing it here tells the Director
    // while the plan is still a draft.
    if (criterion.kind !== 'command') {
      issues.push(
        issue(
          'criterion_required_without_command',
          `Acceptance criterion "${criterion.description}" is ${criterion.kind} and required, but only a command criterion can be proven. Make it required: false, or bind a command criterion to a verification profile.`,
          { criterionId: criterion.id },
        ),
      );
      continue;
    }
    // `required` is true on anything but an explicit false, so a criterion that
    // lost the flag cannot quietly escape the evidence it was promised.
    const claiming = claimants.get(criterion.id);
    if (!claiming || claiming.size === 0) {
      issues.push(
        issue(
          'criterion_verification_profile_missing',
          `Required command criterion "${criterion.description}" has no verification profile configured to run it.`,
          { criterionId: criterion.id },
        ),
      );
    } else if (claiming.size > 1) {
      issues.push(
        issue(
          'criterion_verification_profile_ambiguous',
          `Required command criterion "${criterion.description}" is claimed by ${claiming.size} verification profiles, so it does not resolve to exactly one.`,
          { criterionId: criterion.id },
        ),
      );
    }
  }

  // A task whose criteria are all optional would pass with no evidence at all,
  // so every task must be held to at least one required command criterion.
  const provable = new Set(
    list(contract.acceptance)
      .filter((criterion) => criterion.required !== false && criterion.kind === 'command')
      .map((criterion) => criterion.id),
  );
  for (const task of list(contract.tasks)) {
    if (list(task.acceptance).some((id) => provable.has(id))) continue;
    issues.push(
      issue(
        'task_without_required_command',
        `Task "${task.title}" has no required command criterion, so nothing could ever prove it done.`,
      ),
    );
  }
}

function validateCommand(
  command: VerificationCommand,
  profileId: string,
  seenIds: Set<string>,
  issues: ContractIssue[],
): void {
  const id = typeof command.id === 'string' ? command.id : '';
  if (id.length === 0) {
    issues.push(
      issue(
        'verification_command_id_empty',
        `A command of verification profile "${profileId}" has no id.`,
      ),
    );
  } else if (seenIds.has(id)) {
    issues.push(
      issue(
        'verification_command_id_duplicated',
        `Verification profile "${profileId}" has two commands with id ${id}.`,
      ),
    );
  }
  seenIds.add(id);

  if (typeof command.executable !== 'string' || command.executable.trim().length === 0) {
    issues.push(
      issue(
        'verification_command_executable_empty',
        `Command ${id} of verification profile "${profileId}" names no executable to run.`,
      ),
    );
  }
  const argv = command.argv;
  if (
    !Array.isArray(argv) ||
    argv.some((value) => typeof value !== 'string' || value.length === 0)
  ) {
    issues.push(
      issue(
        'verification_command_argv_invalid',
        `Command ${id} of verification profile "${profileId}" has empty or non-text arguments.`,
      ),
    );
  }

  const cwd = typeof command.cwd === 'string' ? command.cwd : '';
  // "." is the workspace root: the one path that is relative by definition.
  if (cwd !== '.') {
    const problem = classifyWorkspacePath(cwd);
    if (problem) {
      issues.push(
        issue(
          `verification_command_cwd_${problem}`,
          `Command ${id} of verification profile "${profileId}" runs in "${cwd}", which ${PATH_PROBLEM_DETAIL[problem]}.`,
        ),
      );
    }
  }

  const timeout = command.timeoutSeconds;
  if (
    typeof timeout !== 'number' ||
    !Number.isInteger(timeout) ||
    timeout < 1 ||
    timeout > MAX_VERIFICATION_TIMEOUT_SECONDS
  ) {
    issues.push(
      issue(
        'verification_command_timeout_invalid',
        `Command ${id} of verification profile "${profileId}" must time out after a whole number of seconds between 1 and ${MAX_VERIFICATION_TIMEOUT_SECONDS}.`,
      ),
    );
  }
}

// ── Phases and tasks ────────────────────────────────────────────────────

function validatePhasesAndTasks(
  contract: Contract,
  requirementIds: ReadonlySet<string>,
  criteriaById: ReadonlyMap<string, AcceptanceCriterion>,
  issues: ContractIssue[],
): void {
  const phases = list(contract.phases);
  const phasesById = new Map<string, Phase>();
  const ordinals = new Set<number>();
  let previousOrdinal: number | undefined;
  for (const phase of phases) {
    if (phasesById.has(phase.id)) {
      issues.push(
        issue('phase_id_duplicated', `Phase id ${phase.id} is used by more than one phase.`),
      );
    }
    phasesById.set(phase.id, phase);

    if (typeof phase.title !== 'string' || phase.title.trim().length === 0) {
      issues.push(issue('phase_title_empty', `Phase ${phase.id} has no title.`));
    }
    if (!Number.isInteger(phase.ordinal) || phase.ordinal < 0) {
      issues.push(
        issue(
          'phase_ordinal_invalid',
          `Phase ${phase.id} has ordinal ${phase.ordinal}, which is not a whole number of at least zero.`,
        ),
      );
      continue;
    }
    if (ordinals.has(phase.ordinal)) {
      issues.push(
        issue(
          'phase_ordinal_duplicated',
          `Two phases claim ordinal ${phase.ordinal}, so the order between them is undefined.`,
        ),
      );
    }
    ordinals.add(phase.ordinal);
    if (previousOrdinal !== undefined && phase.ordinal < previousOrdinal) {
      issues.push(
        issue(
          'phase_ordinal_unordered',
          `Phase ${phase.id} has ordinal ${phase.ordinal} but follows ordinal ${previousOrdinal}.`,
        ),
      );
    }
    previousOrdinal = phase.ordinal;
  }

  const tasks = list(contract.tasks);
  const tasksById = new Map<string, Task>();
  for (const task of tasks) {
    if (tasksById.has(task.id)) {
      issues.push(
        issue('task_id_duplicated', `Task id ${task.id} is used by more than one task.`, {
          taskCode: task.code,
        }),
      );
    }
    tasksById.set(task.id, task);
  }

  // A task belongs to exactly one phase, and so does an acceptance criterion.
  const claimedTasks = new Set<string>();
  for (const phase of phases) {
    const seenTasks = new Set<string>();
    for (const taskId of list(phase.taskIds)) {
      if (seenTasks.has(taskId)) {
        issues.push(
          issue('phase_task_duplicated', `Phase ${phase.id} lists task ${taskId} twice.`),
        );
        continue;
      }
      seenTasks.add(taskId);
      const task = tasksById.get(taskId);
      if (!task) {
        issues.push(
          issue(
            'phase_task_unknown',
            `Phase ${phase.id} lists task ${taskId}, which is not in this Contract.`,
          ),
        );
        continue;
      }
      if (claimedTasks.has(taskId)) {
        issues.push(
          issue(
            'phase_task_duplicated',
            `Task ${taskId} is claimed by more than one phase, so it could run in both.`,
            { taskCode: task.code },
          ),
        );
        continue;
      }
      claimedTasks.add(taskId);
      if (task.phaseId !== phase.id) {
        issues.push(
          issue(
            'phase_task_mismatch',
            `Task ${task.code} is listed by phase ${phase.id} but declares phase ${task.phaseId}.`,
            { taskCode: task.code },
          ),
        );
      }
    }
  }

  const criterionPhases = new Map<string, string>();
  for (const phase of phases) {
    const seenCriteria = new Set<string>();
    for (const criterionId of list(phase.acceptanceIds)) {
      if (seenCriteria.has(criterionId)) {
        issues.push(
          issue(
            'phase_criterion_duplicated',
            `Phase ${phase.id} lists acceptance criterion ${criterionId} twice.`,
          ),
        );
        continue;
      }
      seenCriteria.add(criterionId);
      if (!criteriaById.has(criterionId)) {
        issues.push(
          issue(
            'phase_criterion_unknown',
            `Phase ${phase.id} lists acceptance criterion ${criterionId}, which this Contract does not define.`,
          ),
        );
        continue;
      }
      if (criterionPhases.has(criterionId)) {
        issues.push(
          issue(
            'phase_criterion_duplicated',
            `Acceptance criterion ${criterionId} is claimed by more than one phase.`,
            { criterionId },
          ),
        );
        continue;
      }
      criterionPhases.set(criterionId, phase.id);
    }
  }

  for (const task of tasks) {
    if (!claimedTasks.has(task.id)) {
      issues.push(
        issue('task_phase_unlisted', `Task ${task.code} is not listed by any phase.`, {
          taskCode: task.code,
        }),
      );
    }
  }
  for (const criterionId of criteriaById.keys()) {
    if (!criterionPhases.has(criterionId)) {
      issues.push(
        issue(
          'criterion_phase_unlisted',
          `Acceptance criterion ${criterionId} belongs to no phase, so nothing would ever verify it.`,
          { criterionId },
        ),
      );
    }
  }

  for (const task of tasks) {
    if (task.contractId !== contract.id) {
      issues.push(
        issue(
          'task_contract_mismatch',
          `Task ${task.code} belongs to contract ${task.contractId}, not to this Contract.`,
          { taskCode: task.code },
        ),
      );
    }
    if (!phasesById.has(task.phaseId)) {
      issues.push(
        issue(
          'task_phase_unknown',
          `Task ${task.code} is in phase ${task.phaseId}, which this Contract does not define.`,
          { taskCode: task.code },
        ),
      );
    }

    const served = list(task.requirementIds);
    if (served.length === 0) {
      issues.push(
        issue('task_requirement_empty', `Task ${task.code} serves no requirement.`, {
          taskCode: task.code,
        }),
      );
    }
    const seenRequirements = new Set<string>();
    for (const requirementId of served) {
      if (seenRequirements.has(requirementId)) {
        issues.push(
          issue(
            'task_requirement_duplicated',
            `Task ${task.code} lists requirement ${requirementId} twice.`,
            { taskCode: task.code, requirementId },
          ),
        );
        continue;
      }
      seenRequirements.add(requirementId);
      if (!requirementIds.has(requirementId)) {
        issues.push(
          issue(
            'task_requirement_unknown',
            `Task ${task.code} serves requirement ${requirementId}, which this Contract does not define.`,
            { taskCode: task.code, requirementId },
          ),
        );
      }
    }

    const seenCriteria = new Set<string>();
    for (const criterionId of list(task.acceptance)) {
      if (seenCriteria.has(criterionId)) {
        issues.push(
          issue(
            'task_criterion_duplicated',
            `Task ${task.code} lists acceptance criterion ${criterionId} twice.`,
            { taskCode: task.code, criterionId },
          ),
        );
        continue;
      }
      seenCriteria.add(criterionId);
      if (!criteriaById.has(criterionId)) {
        issues.push(
          issue(
            'task_criterion_unknown',
            `Task ${task.code} verifies acceptance criterion ${criterionId}, which this Contract does not define.`,
            { taskCode: task.code, criterionId },
          ),
        );
        continue;
      }
      const owner = criterionPhases.get(criterionId);
      if (owner !== undefined && owner !== task.phaseId) {
        issues.push(
          issue(
            'task_criterion_phase_mismatch',
            `Task ${task.code} verifies criterion ${criterionId}, which belongs to another phase.`,
            { taskCode: task.code, criterionId },
          ),
        );
      }
    }
  }
}

// ── Workspace scopes ────────────────────────────────────────────────────

function validateTaskScopes(contract: Contract, issues: ContractIssue[]): void {
  for (const task of list(contract.tasks)) {
    validateScopes(task, task.writeScopes, 'write_scope', WRITE_OPERATIONS, issues);
    validateScopes(task, task.readScopes, 'read_scope', READ_OPERATIONS, issues);
  }
}

function validateScopes(
  task: Task,
  scopes: readonly (Task['writeScopes'][number] | Task['readScopes'][number])[],
  prefix: 'write_scope' | 'read_scope',
  operations: ReadonlySet<string>,
  issues: ContractIssue[],
): void {
  if (!Array.isArray(scopes)) {
    issues.push(
      issue(`${prefix}_scopes_invalid`, `Task ${task.code} declares a malformed scope list.`, {
        taskCode: task.code,
      }),
    );
    return;
  }
  const paths = new Set<string>();
  for (const scope of scopes) {
    const path = typeof scope.path === 'string' ? scope.path : '';
    const problem = classifyWorkspacePath(path);
    if (problem) {
      issues.push(
        issue(
          `${prefix}_path_${problem}`,
          `Task ${task.code} declares scope "${path}", which ${PATH_PROBLEM_DETAIL[problem]}.`,
          { taskCode: task.code },
        ),
      );
    } else if (paths.has(path)) {
      issues.push(
        issue(`${prefix}_duplicated`, `Task ${task.code} declares scope ${path} more than once.`, {
          taskCode: task.code,
        }),
      );
    } else {
      paths.add(path);
    }

    if (!SCOPE_KINDS.has(scope.kind)) {
      issues.push(
        issue(
          `${prefix}_kind_invalid`,
          `Task ${task.code} declares scope "${path}" with kind ${String(scope.kind)}, which is neither file nor directory.`,
          { taskCode: task.code },
        ),
      );
    }

    const declared = list<string>(scope.operations);
    if (declared.length === 0) {
      issues.push(
        issue(
          `${prefix}_operations_empty`,
          `Task ${task.code} declares scope "${path}" with no operation.`,
          { taskCode: task.code },
        ),
      );
    }
    const seen = new Set<string>();
    for (const operation of declared) {
      if (!operations.has(operation)) {
        issues.push(
          issue(
            `${prefix}_operation_invalid`,
            `Task ${task.code} declares scope "${path}" with operation ${String(operation)}, which does not belong to it.`,
            { taskCode: task.code },
          ),
        );
        continue;
      }
      if (seen.has(operation)) {
        issues.push(
          issue(
            `${prefix}_operation_duplicated`,
            `Task ${task.code} declares operation ${operation} twice on scope "${path}".`,
            { taskCode: task.code },
          ),
        );
        continue;
      }
      seen.add(operation);
    }
  }
}

/**
 * Check a proposed Contract against the prompt it answers and the verification
 * profiles the company has configured, then merge the graph rules from
 * `companyWorkflow` so one shape describes every reason a Contract is refused.
 * Nothing is mutated, so a caller may keep validating the same records as often
 * as it likes.
 */
export function validateContractDraft(
  contract: Contract,
  prompt: CompanyPrompt,
  verificationProfiles: Readonly<Record<string, VerificationProfile>> = {},
): ContractValidation {
  const issues: ContractIssue[] = [];
  const requirementIds = new Set(list(contract.requirements).map((requirement) => requirement.id));

  validatePromptLink(contract, prompt, issues);
  validateRequirements(contract, prompt, issues);
  const criteriaById = validateCriteria(contract, requirementIds, issues);
  validateVerification(contract, criteriaById, verificationProfiles, issues);
  validatePhasesAndTasks(contract, requirementIds, criteriaById, issues);
  validateTaskScopes(contract, issues);
  issues.push(...validateContract(contract).issues);

  return { ok: issues.length === 0, issues };
}

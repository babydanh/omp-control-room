/**
 * roleBriefs: what each company role is, and the packet it starts a turn with.
 *
 * Two failures motivate this module. The first is a brief that lies: a role
 * told "you may edit files" while the permission gate denies every edit wastes
 * turns and teaches the model to retry forbidden calls. The second is a brief
 * that is honest but unbounded, because it carries the last ten sessions of
 * history into every new context and the model then answers from stale work.
 *
 * So a brief is built from the role and checked against that role's profile. A
 * profile claiming more than its role allows is rejected rather than obeyed:
 * widening the gate is a Contract decision, not a settings edit.
 *
 * The rendered brief opens with `ROLE_BRIEF_COMMON`, which is unparameterised
 * on purpose: the board then holds one prompt-cache entry for its policy
 * instead of one per role, and only the role section and the per-turn packet
 * that follow it can differ.
 *
 * The packet is the only per-turn payload. It names the Contract revision, the
 * task, its requirement and evidence fields, and the decisions already accepted.
 * It deliberately has no field for another session, a transcript, a prompt body
 * or a live handle, so unrelated history cannot leak in by construction, and
 * every list in it is bounded with the overflow reported rather than hidden.
 */

import type {
  CompanyRole,
  Contract,
  Requirement,
  RoleProfile,
  Task,
  VerificationEvidence,
  WriteScope,
} from '../../../core/src/company.js';
import { buildPreview } from './companyEngine.js';
import { CompanyError } from './companyError.js';

type ToolsPolicy = RoleProfile['toolsPolicy'];

/** Ceilings for a per-turn packet. Overflow is counted, never silently dropped. */
export const ROLE_PACKET_LIMITS = {
  requirements: 12,
  decisions: 8,
  evidence: 8,
  text: 600,
} as const;

const READ_TOOLS = ['read', 'grep', 'glob', 'list_dir', 'ask', 'todo', 'wait'] as const;
const WRITE_TOOLS = ['write', 'edit', 'multi_edit'] as const;
const SHELL_TOOLS = ['bash', 'exec', 'eval'] as const;
const VERIFY_TOOL = 'company_verify';

/** Company metadata tools each role may call; they never touch the workspace. */
const ROLE_COMPANY_TOOLS: Record<CompanyRole, readonly string[]> = {
  director: ['company_submit_contract'],
  advisor: ['company_architecture_review'],
  worker: ['company_task_result'],
  qa: ['company_qa_result'],
  judge: ['company_judge_result'],
};

/**
 * The tools policy a role must carry. It mirrors the table `permissionPolicy`
 * enforces, and a profile that disagrees is refused instead of obeyed.
 */
const ROLE_TOOLS_POLICY: Record<CompanyRole, ToolsPolicy> = {
  director: 'read-only',
  advisor: 'read-only',
  worker: 'scoped-write',
  qa: 'verification-only',
  judge: 'read-only',
};

const ROLE_PURPOSE: Record<CompanyRole, string> = {
  director:
    'You are the Director of this company. Turn the user prompt into a Contract: classify every prompt fragment as a requirement, a constraint or context, ask only the questions that change the Contract, and submit numbered phases with exact write scopes and verification commands.',
  advisor:
    'You are the architecture Advisor. Review the draft Contract against the interfaces it touches and return approve or changes_requested with P0-P3 issues tied to requirement ids and repository evidence.',
  worker:
    'You are a Worker. Implement exactly the task you were given inside its approved write scopes, then report the files you changed, the requirement ids you completed and the evidence you produced.',
  qa: 'You are QA. Run the Contract-approved verification commands and judge the exit code against the consumer-visible acceptance, reporting failures with their real logs instead of repairing them.',
  judge:
    'You are the Judge. Read the Contract coverage, the Advisor notes, the diff and the QA evidence, then return a verdict of passed or failed with a per-criterion reason backed by evidence ids.',
};

const ROLE_RESTRICTIONS: Record<CompanyRole, readonly string[]> = {
  director: [
    'You never writes or edits a file, runs a shell, or evaluates code; you plan and ask.',
    'You must classify every prompt fragment; a fragment you cannot classify becomes a question, never a silent omission.',
    'You never approves your own Contract; approval is the user decision.',
  ],
  advisor: [
    'You never writes or edits a file, runs a shell, or evaluates code.',
    'P0 and P1 issues block implementation; P2 and P3 are recorded as notes.',
    'Every issue cites requirement ids and evidence you actually read.',
  ],
  worker: [
    'You may create or modify files only inside the write scopes of the approved Contract; anything outside is refused even after an approval.',
    'Deletes, renames, patch REM/MV, lockfiles, dependency manifests, secrets, databases, migrations and arbitrary shell always need the user first.',
    'You never declare a task done; QA evidence closes it.',
  ],
  qa: [
    'You may read, and you may run only the verification commands the approved Contract lists, through company_verify.',
    'You have no general shell and no write tools; a failure is reported, never patched.',
    'A missing test runner or environment prerequisite is blocked with logs, not a pass.',
  ],
  judge: [
    'You never writes or edits a file, runs a shell, or evaluates code; you never repair the work yourself.',
    'A required criterion without successful evidence blocks a pass.',
    'You may not drop or weaken an acceptance criterion to make a verdict green.',
  ],
};

/**
 * The company-wide rules, identical byte-for-byte for every role.
 *
 * This is the front of every brief the board sends, so it takes no argument:
 * a role name, a tool list or a branch inside it would fork the prefix and each
 * of the five roles would pay to cache its own copy of the same policy. Every
 * sentence below is true of all five roles and is the shared reading of rules
 * the role tables already state in role-specific words; stating it here relaxes
 * nothing, because the role restrictions still follow in full and unedited.
 */
export const ROLE_BRIEF_COMMON = `# Company rules

These rules hold for every role on this board. Your role section below adds to
them, and nothing in it lifts one.

## Authority

- You hold exactly the tools your Tools section grants. Anything else is refused,
  so a denial is not a signal to reach the same effect by another route.
- A tool listed as "Ask the user first" stays unused until the user approves that
  exact action; approval for one call is not approval for the next, and an
  unanswered ask is a no.
- You never approve your own work. Approving a Contract, a task or a scope is the
  user's decision, never yours to record as settled.
- You never widen the Contract, the task or the write scopes you were handed to
  make a step fit; a step that does not fit is reported, not reshaped.

## Evidence

- You never report a result you did not produce, and never describe an unrun,
  unfinished or interrupted check as if it had passed.
- Missing, partial or failed evidence is reported as missing or failed, with what
  actually happened. Silence is not a pass.
- Every claim cites the ids you were given - requirement, task, acceptance
  criterion, evidence - so a reader can check it without trusting your wording.
- You never weaken, drop or reinterpret an acceptance criterion to make a result
  look green.

## Output

- Answer with the verdict your role section names, then the ids and the evidence
  behind it. No preamble, no plan, no restatement of this brief.
- A step you could not complete is reported as blocked, with the reason and what
  you tried, never as a partial pass.
- Ask only for a decision that changes your next action, and never assume one.`;

export interface RoleBrief {
  role: CompanyRole;
  toolsPolicy: ToolsPolicy;
  purpose: string;
  restrictions: readonly string[];
  /** Tools the role may use without asking anyone. */
  allowedTools: readonly string[];
  /** Tools the role may use only after the user approves that exact action. */
  askBeforeUse: readonly string[];
  requestedModel?: string;
  thinking?: string;
}

export interface RolePacketInput {
  role: CompanyRole;
  contract?: Contract;
  task?: Task;
  requirements?: readonly Requirement[];
  decisions?: readonly string[];
  evidence?: readonly VerificationEvidence[];
}

export interface RolePacket {
  role: CompanyRole;
  contract: { id: string; code: string; revision: number; status: Contract['status'] } | null;
  task: {
    id: string;
    code: string;
    title: string;
    status: Task['status'];
    executionMode: Task['executionMode'];
    requirementIds: readonly string[];
    dependsOn: readonly string[];
    readScopes: Task['readScopes'];
    writeScopes: WriteScope[];
    sharedResources: readonly string[];
    acceptance: readonly string[];
    attemptIds: readonly string[];
    routeReason: string;
  } | null;
  requirements: readonly {
    id: string;
    text: string;
    kind: Requirement['kind'];
    status: Requirement['status'];
  }[];
  decisions: readonly string[];
  evidence: readonly {
    id: string;
    executable: string;
    argv: readonly string[];
    cwd: string;
    exitCode?: number;
    signal?: string;
    startedAt: string;
    endedAt: string;
    criterionIds: readonly string[];
    passed: boolean;
  }[];
  truncated: { requirements: number; decisions: number; evidence: number };
}

/** Grapheme-safe truncation with an explicit cut marker. */
function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${buildPreview(text, limit)}…`;
}

/**
 * Build the brief for a role. The grant comes from the role table; the caller's
 * `toolsPolicy` is validated against it, never obeyed.
 */
function buildRoleBrief(input: { role: CompanyRole; toolsPolicy: ToolsPolicy }): RoleBrief {
  const required: ToolsPolicy | undefined = ROLE_TOOLS_POLICY[input.role];
  if (required === undefined) {
    throw new CompanyError('role_unknown', `Unknown company role: ${String(input.role)}`);
  }
  if (input.toolsPolicy !== required) {
    throw new CompanyError(
      'role_tools_policy_conflict',
      `Role ${input.role} must carry tools policy "${required}", not "${input.toolsPolicy}".`,
    );
  }

  return {
    role: input.role,
    toolsPolicy: required,
    purpose: ROLE_PURPOSE[input.role],
    restrictions: ROLE_RESTRICTIONS[input.role],
    allowedTools: [
      ...READ_TOOLS,
      ...ROLE_COMPANY_TOOLS[input.role],
      ...(input.role === 'worker' ? WRITE_TOOLS : []),
      ...(input.role === 'qa' ? [VERIFY_TOOL] : []),
    ],
    askBeforeUse: [...SHELL_TOOLS, ...(input.role === 'worker' ? ['task'] : [])],
  };
}

/** Build a brief from the profile the settings actually hold for that role. */
export function roleBriefForProfile(profile: RoleProfile): RoleBrief {
  return {
    ...buildRoleBrief({ role: profile.role, toolsPolicy: profile.toolsPolicy }),
    requestedModel: profile.requestedModel,
    thinking: profile.thinking,
  };
}

function packetEvidence(record: VerificationEvidence): RolePacket['evidence'][number] | null {
  // Neither an exit code nor a signal means the run never produced a verdict.
  // Dropping it is the fail-closed choice: an unproven command is not a pass.
  if (record.exitCode === undefined && record.signal === undefined) return null;
  return {
    id: record.id,
    executable: record.command.executable,
    argv: record.command.argv,
    cwd: record.command.cwd,
    ...(record.exitCode === undefined ? {} : { exitCode: record.exitCode }),
    ...(record.signal === undefined ? {} : { signal: record.signal }),
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    criterionIds: record.criterionIds,
    passed: record.exitCode === 0 && record.signal === undefined,
  };
}

/**
 * Build the bounded packet a role starts a turn with. There is deliberately no
 * parameter for another session, so unrelated history cannot be included.
 * `decisions` defaults to the Contract's accepted decisions; passing the field
 * narrows it, because an empty array is a deliberate "none of them".
 */
export function buildRolePacket(input: RolePacketInput): RolePacket {
  const requirements = input.requirements ?? [];
  const decisions = input.decisions ?? input.contract?.decisions ?? [];
  const evidence = (input.evidence ?? []).flatMap((record) => {
    const entry = packetEvidence(record);
    return entry ? [entry] : [];
  });
  const contract = input.contract;
  const task = input.task;

  return {
    role: input.role,
    contract: contract
      ? {
          id: contract.id,
          code: contract.code,
          revision: contract.revision,
          status: contract.status,
        }
      : null,
    task: task
      ? {
          id: task.id,
          code: task.code,
          title: task.title,
          status: task.status,
          executionMode: task.executionMode,
          requirementIds: task.requirementIds,
          dependsOn: task.dependsOn,
          readScopes: task.readScopes,
          writeScopes: task.writeScopes,
          sharedResources: task.sharedResources,
          acceptance: task.acceptance,
          attemptIds: task.attemptIds,
          routeReason: task.routeReason,
        }
      : null,
    requirements: requirements.slice(0, ROLE_PACKET_LIMITS.requirements).map((entry) => ({
      id: entry.id,
      text: truncate(entry.text, ROLE_PACKET_LIMITS.text),
      kind: entry.kind,
      status: entry.status,
    })),
    decisions: decisions
      .slice(0, ROLE_PACKET_LIMITS.decisions)
      .map((entry) => truncate(entry, ROLE_PACKET_LIMITS.text)),
    evidence: evidence.slice(0, ROLE_PACKET_LIMITS.evidence),
    truncated: {
      requirements: Math.max(0, requirements.length - ROLE_PACKET_LIMITS.requirements),
      decisions: Math.max(0, decisions.length - ROLE_PACKET_LIMITS.decisions),
      evidence: Math.max(0, evidence.length - ROLE_PACKET_LIMITS.evidence),
    },
  };
}

interface ScopeLike {
  readonly path: string;
  readonly operations: readonly string[];
}

function renderScope(scopes: readonly ScopeLike[]): string {
  if (scopes.length === 0) return 'none';
  return scopes.map((scope) => `${scope.path} (${scope.operations.join('+')})`).join(', ');
}

/**
 * Render the stable instruction block for one turn: the company rules shared by
 * the whole board, then this role's purpose, restrictions and tools, then the
 * packet. It carries no clock, no handle and no dashboard value, so the same
 * role and task always produce the same prefix.
 *
 * The shared block leads because it is the only part that is identical for
 * every role: the board then caches its policy once instead of once per role,
 * and the role section is the first thing that may differ between sessions.
 */
export function roleBriefText(brief: RoleBrief, packet: RolePacket): string {
  const lines: string[] = [
    ROLE_BRIEF_COMMON,
    '',
    `# Role: ${brief.role}`,
    '',
    brief.purpose,
    '',
    '## Restrictions',
    '',
  ];
  for (const restriction of brief.restrictions) lines.push(`- ${restriction}`);

  lines.push('', `## Tools (${brief.toolsPolicy})`, '');
  lines.push(`- Allowed: ${brief.allowedTools.join(', ')}`);
  lines.push(`- Ask the user first: ${brief.askBeforeUse.join(', ')}`);

  lines.push('', '## Current work', '');
  const contract = packet.contract;
  if (contract) {
    lines.push(`- Contract ${contract.code} revision ${contract.revision} (${contract.status})`);
  }
  const task = packet.task;
  if (task) {
    lines.push(`- Task ${task.code}: ${task.title} (${task.status}, ${task.executionMode})`);
    lines.push(`- Read scopes: ${renderScope(task.readScopes)}`);
    lines.push(`- Write scopes: ${renderScope(task.writeScopes)}`);
    lines.push(`- Shared resources: ${task.sharedResources.join(', ') || 'none'}`);
    lines.push(`- Acceptance: ${task.acceptance.join(', ') || 'none'}`);
  }
  if (packet.requirements.length > 0) {
    lines.push('- Requirements:');
    for (const requirement of packet.requirements) {
      lines.push(
        `  - [${requirement.id}] (${requirement.kind}, ${requirement.status}) ${requirement.text}`,
      );
    }
  }
  if (packet.decisions.length > 0) {
    lines.push('- Decisions already taken:');
    for (const decision of packet.decisions) lines.push(`  - ${decision}`);
  }
  if (packet.evidence.length > 0) {
    lines.push('- Verification evidence:');
    for (const entry of packet.evidence) {
      const outcome = entry.passed
        ? `passed (exit ${entry.exitCode})`
        : `failed (${entry.signal ? `signal ${entry.signal}` : `exit ${entry.exitCode ?? 'none'}`})`;
      lines.push(
        `  - ${entry.id}: ${entry.executable} ${entry.argv.join(' ')} in ${entry.cwd} ${outcome} for ${entry.criterionIds.join(', ')}`,
      );
    }
  }

  const { requirements, decisions, evidence } = packet.truncated;
  if (requirements + decisions + evidence > 0) {
    lines.push(
      `- Truncated from the company state: ${requirements} requirements, ${decisions} decisions, ${evidence} evidence records.`,
    );
  }
  return lines.join('\n');
}

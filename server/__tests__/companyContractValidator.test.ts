import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type {
  AcceptanceCriterion,
  CompanyPrompt,
  Contract,
  Phase,
  ReadScope,
  Requirement,
  Task,
  VerificationCommand,
  VerificationProfile,
  WriteScope,
} from '../../core/src/company.js';
import type { ContractIssue, ContractValidation } from '../src/company/contractValidator.js';
import { validateContractDraft } from '../src/company/contractValidator.js';

function storedPrompt(fragmentCount = 2): CompanyPrompt {
  return {
    id: randomUUID(),
    rawTextArtifactId: randomUUID(),
    preview: 'add a standings board',
    createdAt: '2026-01-01T00:00:00.000Z',
    fragments: Array.from({ length: fragmentCount }, (_unused, ordinal) => ({
      id: randomUUID(),
      start: ordinal * 12,
      end: ordinal * 12 + 11,
      ordinal,
    })),
  };
}

interface Draft {
  contract: Contract;
  prompt: CompanyPrompt;
  /** Keyed by acceptance criterion id, as CompanySettings stores it. */
  verificationProfiles: Record<string, VerificationProfile>;
  /** The criterion the draft's command profile is keyed by. */
  commandCriterionId: string;
}

/** A draft the validator must accept; every test mutates a copy of it. */
function draft(): Draft {
  const prompt = storedPrompt();
  const requirements: Requirement[] = prompt.fragments.map((fragment, index) => ({
    id: randomUUID(),
    promptId: prompt.id,
    fragmentIds: [fragment.id],
    text: index === 0 ? 'render the standings' : 'rank the teams by points',
    kind: 'goal',
    status: 'planned',
  }));
  const command: AcceptanceCriterion = {
    id: randomUUID(),
    requirementIds: [requirements[0].id],
    description: 'the unit suite passes',
    kind: 'command',
    required: true,
  };
  const review: AcceptanceCriterion = {
    id: randomUUID(),
    requirementIds: [requirements[1].id],
    description: 'a reviewer reads the report',
    kind: 'review',
    required: false,
  };
  const phase: Phase = {
    id: randomUUID(),
    title: 'Standings',
    ordinal: 0,
    taskIds: [],
    acceptanceIds: [command.id, review.id],
  };
  const contract: Contract = {
    id: randomUUID(),
    code: 'PA-C0001',
    revision: 1,
    promptIds: [prompt.id],
    requirements,
    phases: [phase],
    tasks: [],
    assumptions: [],
    decisions: [],
    acceptance: [command, review],
    status: 'awaiting_approval',
  };
  const task: Task = {
    id: randomUUID(),
    code: 'PA-T0001',
    contractId: contract.id,
    phaseId: phase.id,
    title: 'build the standings view',
    requirementIds: requirements.map((requirement) => requirement.id),
    dependsOn: [],
    workstreamId: 'frontend',
    readScopes: [{ path: 'src', kind: 'directory', operations: ['read', 'list', 'search'] }],
    writeScopes: [{ path: 'src/standings.tsx', kind: 'file', operations: ['create', 'modify'] }],
    sharedResources: [],
    acceptance: [command.id, review.id],
    executionMode: 'session',
    status: 'planned',
    attemptIds: [],
    routeReason: 'independent slice',
  };
  phase.taskIds = [task.id];
  contract.tasks = [task];

  const profile: VerificationProfile = {
    id: 'frontend',
    criterionIds: [command.id],
    commands: [
      { id: 'unit', executable: 'npm', argv: ['run', 'test'], cwd: 'web', timeoutSeconds: 600 },
    ],
    prerequisites: ['dependencies installed'],
    outputScopes: [],
  };
  return {
    contract,
    prompt,
    verificationProfiles: { [command.id]: profile },
    commandCriterionId: command.id,
  };
}

function validate(source: Draft): ContractValidation {
  return validateContractDraft(source.contract, source.prompt, source.verificationProfiles);
}

function codes(result: ContractValidation): string[] {
  return result.issues.map((entry: ContractIssue) => entry.code);
}

describe('contract draft validation', () => {
  it('accepts a draft whose contract, prompt and verification profile agree', () => {
    const result = validate(draft());

    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('leaves the contract, prompt and profiles untouched', () => {
    const source = draft();
    source.contract.tasks[0].writeScopes[0].operations = [
      'nonsense',
    ] as unknown as WriteScope['operations'];
    const before = JSON.stringify(source);

    validate(source);

    expect(JSON.stringify(source)).toBe(before);
  });

  it('reports the base graph rules it does not restate', () => {
    const source = draft();
    const first = source.contract.tasks[0];
    const second: Task = {
      ...first,
      id: randomUUID(),
      code: 'PA-T0002',
      dependsOn: [first.id],
      requirementIds: [],
      acceptance: [],
    };
    first.dependsOn = [second.id];
    source.contract.tasks.push(second);
    source.contract.phases[0].taskIds.push(second.id);

    expect(codes(validate(source))).toContain('contract_dependency_cycle');
  });
});

describe('prompt coverage', () => {
  it('rejects a fragment no requirement classifies', () => {
    const source = draft();
    source.contract.requirements[1].fragmentIds = [];

    expect(codes(validate(source))).toContain('prompt_fragment_uncovered');
  });

  it('rejects a requirement that classifies nothing', () => {
    const source = draft();
    source.contract.requirements[1].fragmentIds = [];

    expect(codes(validate(source))).toContain('requirement_fragment_empty');
  });

  it('rejects a fragment two requirements claim', () => {
    const source = draft();
    source.contract.requirements[1].fragmentIds = [source.prompt.fragments[0].id];

    expect(codes(validate(source))).toContain('prompt_fragment_covered_twice');
  });

  it('rejects a requirement that repeats one fragment', () => {
    const source = draft();
    const fragment = source.prompt.fragments[0].id;
    source.contract.requirements[0].fragmentIds = [fragment, fragment];

    expect(codes(validate(source))).toContain('requirement_fragment_duplicated');
  });

  it('rejects a requirement pointing at a fragment of another prompt', () => {
    const source = draft();
    const stranger = storedPrompt(1);
    source.contract.requirements[0].fragmentIds = [stranger.fragments[0].id];

    expect(codes(validate(source))).toContain('requirement_fragment_unknown');
  });

  it('rejects a requirement that belongs to another prompt', () => {
    const source = draft();
    source.contract.requirements[0].promptId = randomUUID();

    expect(codes(validate(source))).toContain('requirement_prompt_unknown');
  });

  it('rejects a contract that does not link the prompt it answers', () => {
    const source = draft();
    source.contract.promptIds = [];

    expect(codes(validate(source))).toContain('contract_prompt_missing');
  });

  it('rejects a contract that lists the same prompt twice', () => {
    const source = draft();
    source.contract.promptIds = [source.prompt.id, source.prompt.id];

    expect(codes(validate(source))).toContain('contract_prompt_duplicated');
  });

  it('rejects a prompt that was split into no fragments', () => {
    const source = draft();
    source.prompt.fragments = [];

    expect(codes(validate(source))).toContain('prompt_without_fragments');
  });
});

describe('requirement links', () => {
  it('rejects a duplicated requirement id', () => {
    const source = draft();
    source.contract.requirements[1].id = source.contract.requirements[0].id;

    expect(codes(validate(source))).toContain('requirement_id_duplicated');
  });

  it('rejects a requirement with no text', () => {
    const source = draft();
    source.contract.requirements[0].text = '   ';

    expect(codes(validate(source))).toContain('requirement_text_empty');
  });

  it('rejects a task that serves an unknown requirement', () => {
    const source = draft();
    source.contract.tasks[0].requirementIds = [randomUUID()];

    expect(codes(validate(source))).toContain('task_requirement_unknown');
  });

  it('rejects a task that serves no requirement at all', () => {
    const source = draft();
    source.contract.tasks[0].requirementIds = [];

    expect(codes(validate(source))).toContain('task_requirement_empty');
  });

  it('rejects an acceptance criterion that serves an unknown requirement', () => {
    const source = draft();
    source.contract.acceptance[1].requirementIds = [randomUUID()];

    expect(codes(validate(source))).toContain('criterion_requirement_unknown');
  });

  it('rejects an acceptance criterion with no description', () => {
    const source = draft();
    source.contract.acceptance[0].description = '';

    expect(codes(validate(source))).toContain('criterion_description_empty');
  });
});

describe('task, phase and contract cross-links', () => {
  it('rejects a task that belongs to another contract', () => {
    const source = draft();
    source.contract.tasks[0].contractId = randomUUID();

    expect(codes(validate(source))).toContain('task_contract_mismatch');
  });

  it('rejects a task in an unknown phase', () => {
    const source = draft();
    source.contract.tasks[0].phaseId = randomUUID();

    expect(codes(validate(source))).toContain('task_phase_unknown');
  });

  it('rejects a phase listing a task that is not in the contract', () => {
    const source = draft();
    source.contract.phases[0].taskIds = [randomUUID()];

    expect(codes(validate(source))).toContain('phase_task_unknown');
  });

  it('rejects a task no phase lists', () => {
    const source = draft();
    source.contract.phases[0].taskIds = [];

    expect(codes(validate(source))).toContain('task_phase_unlisted');
  });

  it('rejects a task two phases claim', () => {
    const source = draft();
    source.contract.phases.push({
      id: randomUUID(),
      title: 'Polish',
      ordinal: 1,
      taskIds: [source.contract.tasks[0].id],
      acceptanceIds: [],
    });

    expect(codes(validate(source))).toContain('phase_task_duplicated');
  });

  it('rejects a phase listing a task that declares another phase', () => {
    const source = draft();
    const task = source.contract.tasks[0];
    const phase = source.contract.phases[0];
    phase.taskIds = [randomUUID(), task.id];
    task.phaseId = randomUUID();

    expect(codes(validate(source))).toContain('phase_task_mismatch');
  });

  it('rejects a duplicated task id', () => {
    const source = draft();
    source.contract.tasks[1] = { ...source.contract.tasks[0], code: 'PA-T0002' };

    expect(codes(validate(source))).toContain('task_id_duplicated');
  });

  it('rejects duplicate phase ordinals', () => {
    const source = draft();
    source.contract.phases.push({
      id: randomUUID(),
      title: 'Polish',
      ordinal: 0,
      taskIds: [],
      acceptanceIds: [],
    });

    expect(codes(validate(source))).toContain('phase_ordinal_duplicated');
  });

  it('rejects a phase ordinal that is not a whole number', () => {
    const source = draft();
    source.contract.phases[0].ordinal = 1.5;

    expect(codes(validate(source))).toContain('phase_ordinal_invalid');
  });

  it('rejects phases listed out of order', () => {
    const source = draft();
    const first = source.contract.phases[0];
    first.ordinal = 1;
    source.contract.phases.push({
      id: randomUUID(),
      title: 'Polish',
      ordinal: 0,
      taskIds: [],
      acceptanceIds: [],
    });

    expect(codes(validate(source))).toContain('phase_ordinal_unordered');
  });

  it('rejects a duplicated phase id', () => {
    const source = draft();
    source.contract.phases.push({ ...source.contract.phases[0] });

    expect(codes(validate(source))).toContain('phase_id_duplicated');
  });

  it('rejects an acceptance criterion no phase lists', () => {
    const source = draft();
    source.contract.phases[0].acceptanceIds = [];

    expect(codes(validate(source))).toContain('criterion_phase_unlisted');
  });

  it('rejects a phase listing the same acceptance criterion twice', () => {
    const source = draft();
    const [first] = source.contract.phases[0].acceptanceIds;
    source.contract.phases[0].acceptanceIds = [first, first];

    expect(codes(validate(source))).toContain('phase_criterion_duplicated');
  });

  it('rejects a phase listing an acceptance criterion the contract does not define', () => {
    const source = draft();
    source.contract.phases[0].acceptanceIds = [randomUUID()];

    expect(codes(validate(source))).toContain('phase_criterion_unknown');
  });

  it('rejects a task verifying an unknown acceptance criterion', () => {
    const source = draft();
    source.contract.tasks[0].acceptance = [randomUUID()];

    expect(codes(validate(source))).toContain('task_criterion_unknown');
  });

  it('rejects a task that verifies a criterion owned by another phase', () => {
    const source = draft();
    const moved = source.contract.acceptance[1];
    source.contract.phases[0].acceptanceIds = [source.contract.acceptance[0].id];
    source.contract.phases.push({
      id: randomUUID(),
      title: 'Polish',
      ordinal: 1,
      taskIds: [],
      acceptanceIds: [moved.id],
    });
    source.contract.tasks[0].acceptance = [moved.id];

    expect(codes(validate(source))).toContain('task_criterion_phase_mismatch');
  });
});

describe('verification commands', () => {
  it('rejects a required command criterion with no configured profile', () => {
    const source = draft();
    source.verificationProfiles = {};

    expect(codes(validate(source))).toContain('criterion_verification_profile_missing');
  });

  it('requires a profile when required is not explicitly false', () => {
    const source = draft();
    source.verificationProfiles = {};
    source.contract.acceptance[0].required = undefined as unknown as boolean;

    expect(codes(validate(source))).toContain('criterion_verification_profile_missing');
  });

  it('rejects a required command criterion whose kind is not one it knows', () => {
    const source = draft();
    source.contract.acceptance[0].kind = 'vibes' as AcceptanceCriterion['kind'];

    expect(codes(validate(source))).toContain('criterion_kind_invalid');
  });

  it('accepts a required review criterion with no command profile', () => {
    const source = draft();
    source.verificationProfiles = {};
    source.contract.acceptance[0] = {
      ...source.contract.acceptance[0],
      kind: 'review',
      required: true,
    };

    expect(validate(source).ok).toBe(true);
  });

  it('accepts a required surface criterion with no command profile', () => {
    const source = draft();
    source.verificationProfiles = {};
    source.contract.acceptance[0] = {
      ...source.contract.acceptance[0],
      kind: 'surface',
      required: true,
    };

    expect(validate(source).ok).toBe(true);
  });

  it('accepts an optional command criterion with no command profile', () => {
    const source = draft();
    source.verificationProfiles = {};
    source.contract.acceptance[0].required = false;

    expect(validate(source).ok).toBe(true);
  });

  it('rejects a profile that runs no command', () => {
    const source = draft();
    source.verificationProfiles[source.commandCriterionId].commands = [];

    expect(codes(validate(source))).toContain('verification_profile_without_commands');
  });

  it('rejects a profile keyed by a criterion it does not claim', () => {
    const source = draft();
    const profile = source.verificationProfiles[source.commandCriterionId];
    source.verificationProfiles = {
      [source.contract.acceptance[1].id]: profile,
    };

    expect(codes(validate(source))).toContain('verification_profile_key_unmatched');
  });

  it('rejects two profiles claiming the same required criterion', () => {
    const source = draft();
    const first = source.commandCriterionId;
    const second = source.contract.acceptance[1].id;
    const profile = source.verificationProfiles[first];
    source.verificationProfiles = {
      [first]: { ...profile, criterionIds: [first, second] },
      [second]: { ...profile, id: 'backend', criterionIds: [second, first] },
    };

    expect(codes(validate(source))).toContain('criterion_verification_profile_ambiguous');
  });

  it('accepts one profile keyed to several criteria', () => {
    const source = draft();
    const first = source.commandCriterionId;
    const second = source.contract.acceptance[1].id;
    const shared: VerificationProfile = {
      ...source.verificationProfiles[first],
      criterionIds: [first, second],
    };
    source.verificationProfiles = { [first]: shared, [second]: shared };

    expect(validate(source).ok).toBe(true);
  });

  it('rejects a profile claiming a criterion the company never keyed', () => {
    const source = draft();
    const key = source.commandCriterionId;
    source.verificationProfiles[key] = {
      ...source.verificationProfiles[key],
      criterionIds: [key, randomUUID()],
    };

    expect(codes(validate(source))).toContain('verification_profile_criterion_unknown');
  });

  it('accepts a profile shared with criteria another contract keyed', () => {
    const source = draft();
    const key = source.commandCriterionId;
    const elsewhere = randomUUID();
    const shared: VerificationProfile = {
      ...source.verificationProfiles[key],
      criterionIds: [key, elsewhere],
    };
    source.verificationProfiles = { [key]: shared, [elsewhere]: shared };

    expect(validate(source).ok).toBe(true);
  });

  it('ignores verification profiles that belong to another contract', () => {
    const source = draft();
    const elsewhere = randomUUID();
    source.verificationProfiles[elsewhere] = {
      id: 'legacy',
      criterionIds: [elsewhere],
      commands: [],
      prerequisites: [],
      outputScopes: [],
    };

    expect(validate(source).ok).toBe(true);
  });

  it('accepts the workspace root as a command working directory', () => {
    const source = draft();
    source.verificationProfiles[source.commandCriterionId].commands[0].cwd = '.';

    expect(validate(source).ok).toBe(true);
  });

  const COMMAND_CASES: ReadonlyArray<readonly [string, Partial<VerificationCommand>, string]> = [
    ['an empty executable', { executable: '' }, 'verification_command_executable_empty'],
    ['an empty argument', { argv: ['run', ''] }, 'verification_command_argv_invalid'],
    [
      'arguments that are not a list',
      { argv: 'run test' as unknown as string[] },
      'verification_command_argv_invalid',
    ],
    ['an absolute working directory', { cwd: '/srv/app' }, 'verification_command_cwd_absolute'],
    [
      'a drive-prefixed working directory',
      { cwd: 'C:/srv/app' },
      'verification_command_cwd_drive_prefix',
    ],
    [
      'a working directory outside the workspace',
      { cwd: '../elsewhere' },
      'verification_command_cwd_traversal',
    ],
    [
      'a working directory with an empty segment',
      { cwd: 'web//app' },
      'verification_command_cwd_segment_empty',
    ],
    [
      'a backslash working directory',
      { cwd: 'web\\app' },
      'verification_command_cwd_not_normalized',
    ],
    ['no working directory', { cwd: '' }, 'verification_command_cwd_empty'],
    ['a zero timeout', { timeoutSeconds: 0 }, 'verification_command_timeout_invalid'],
    ['a negative timeout', { timeoutSeconds: -30 }, 'verification_command_timeout_invalid'],
    ['a fractional timeout', { timeoutSeconds: 1.5 }, 'verification_command_timeout_invalid'],
    [
      'an unbounded timeout',
      { timeoutSeconds: Number.POSITIVE_INFINITY },
      'verification_command_timeout_invalid',
    ],
    ['a missing command id', { id: '' }, 'verification_command_id_empty'],
  ];

  for (const [label, patch, code] of COMMAND_CASES) {
    it(`rejects a verification command with ${label}`, () => {
      const source = draft();
      Object.assign(source.verificationProfiles[source.commandCriterionId].commands[0], patch);

      expect(codes(validate(source))).toContain(code);
    });
  }

  it('rejects two commands of one profile sharing an id', () => {
    const source = draft();
    const commands = source.verificationProfiles[source.commandCriterionId].commands;
    commands.push({ ...commands[0], argv: ['run', 'build'] });

    expect(codes(validate(source))).toContain('verification_command_id_duplicated');
  });
});

describe('scope paths and operations', () => {
  const WRITE_PATH_CASES: ReadonlyArray<readonly [string, string, string]> = [
    ['an absolute path', '/etc/passwd', 'write_scope_path_absolute'],
    ['a drive-prefixed path', 'C:/Windows/system32', 'write_scope_path_drive_prefix'],
    ['a parent traversal', '../secrets', 'write_scope_path_traversal'],
    ['a current-directory segment', './src', 'write_scope_path_traversal'],
    ['an empty segment', 'src//standings.tsx', 'write_scope_path_segment_empty'],
    ['a backslash separator', 'src\\standings.tsx', 'write_scope_path_not_normalized'],
    ['an empty path', '', 'write_scope_path_empty'],
    ['surrounding whitespace', ' src/standings.tsx ', 'write_scope_path_not_normalized'],
  ];

  for (const [label, path, code] of WRITE_PATH_CASES) {
    it(`rejects a write scope with ${label}`, () => {
      const source = draft();
      source.contract.tasks[0].writeScopes = [{ path, kind: 'file', operations: ['create'] }];

      expect(codes(validate(source))).toContain(code);
    });
  }

  const READ_PATH_CASES: ReadonlyArray<readonly [string, string, string]> = [
    ['an absolute path', '/etc/shadow', 'read_scope_path_absolute'],
    ['a parent traversal', '../secrets', 'read_scope_path_traversal'],
    ['an empty segment', 'src//lib', 'read_scope_path_segment_empty'],
  ];

  for (const [label, path, code] of READ_PATH_CASES) {
    it(`rejects a read scope with ${label}`, () => {
      const source = draft();
      source.contract.tasks[0].readScopes = [{ path, kind: 'directory', operations: ['read'] }];

      expect(codes(validate(source))).toContain(code);
    });
  }

  it('rejects a scope that declares no operations', () => {
    const source = draft();
    source.contract.tasks[0].writeScopes = [
      { path: 'src/standings.tsx', kind: 'file', operations: [] },
    ];

    expect(codes(validate(source))).toContain('write_scope_operations_empty');
  });

  it('rejects a write scope that declares a read operation', () => {
    const source = draft();
    source.contract.tasks[0].writeScopes = [
      {
        path: 'src/standings.tsx',
        kind: 'file',
        operations: ['create', 'read'] as WriteScope['operations'],
      },
    ];

    expect(codes(validate(source))).toContain('write_scope_operation_invalid');
  });

  it('rejects a read scope that declares a write operation', () => {
    const source = draft();
    source.contract.tasks[0].readScopes = [
      {
        path: 'src',
        kind: 'directory',
        operations: ['read', 'modify'] as ReadScope['operations'],
      },
    ];

    expect(codes(validate(source))).toContain('read_scope_operation_invalid');
  });

  it('rejects a scope that repeats one operation', () => {
    const source = draft();
    source.contract.tasks[0].writeScopes = [
      { path: 'src/standings.tsx', kind: 'file', operations: ['create', 'create'] },
    ];

    expect(codes(validate(source))).toContain('write_scope_operation_duplicated');
  });

  it('rejects an unknown scope kind', () => {
    const source = draft();
    source.contract.tasks[0].writeScopes = [
      { path: 'src/standings.tsx', kind: 'folder' as 'file', operations: ['create'] },
    ];

    expect(codes(validate(source))).toContain('write_scope_kind_invalid');
  });

  it('rejects the same scope declared twice on one task', () => {
    const source = draft();
    source.contract.tasks[0].writeScopes = [
      { path: 'src/standings.tsx', kind: 'file', operations: ['create'] },
      { path: 'src/standings.tsx', kind: 'directory', operations: ['modify'] },
    ];

    expect(codes(validate(source))).toContain('write_scope_duplicated');
  });
});

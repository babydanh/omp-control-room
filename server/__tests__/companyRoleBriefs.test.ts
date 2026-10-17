import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type {
  CompanyRole,
  Contract,
  Requirement,
  RoleProfile,
  Task,
  VerificationEvidence,
} from '../../core/src/company.js';
import { createRoleProfiles } from '../src/company/companyState.js';
import {
  buildRolePacket,
  ROLE_PACKET_LIMITS,
  roleBriefForProfile,
  roleBriefText,
} from '../src/company/roleBriefs.js';

const ROLES: CompanyRole[] = ['director', 'advisor', 'worker', 'qa', 'judge'];
const PROFILES = createRoleProfiles();
const WRITE_TOOLS = ['write', 'edit', 'multi_edit'];
const SHELL_TOOLS = ['bash', 'exec', 'eval'];

function requirement(overrides: Partial<Requirement> & { id: string }): Requirement {
  return {
    promptId: randomUUID(),
    fragmentIds: [],
    text: `requirement ${overrides.id}`,
    kind: 'goal',
    status: 'planned',
    ...overrides,
  } as Requirement;
}

function contract(overrides: Partial<Contract> = {}): Contract {
  return {
    id: randomUUID(),
    code: 'PA-C0001',
    revision: 3,
    promptIds: [],
    requirements: [],
    phases: [],
    tasks: [],
    assumptions: [],
    decisions: [],
    acceptance: [],
    status: 'running',
    ...overrides,
  } as Contract;
}

function task(overrides: Partial<Task> & { code: string }): Task {
  return {
    id: randomUUID(),
    contractId: randomUUID(),
    phaseId: randomUUID(),
    title: 'Standings service',
    requirementIds: [],
    dependsOn: [],
    workstreamId: 'ws-standings',
    readScopes: [],
    writeScopes: [
      { path: 'apps/backend/src/standings', kind: 'directory', operations: ['create', 'modify'] },
    ],
    sharedResources: ['pnpm-lock.yaml'],
    acceptance: ['ac-1'],
    executionMode: 'session',
    status: 'running',
    attemptIds: [],
    routeReason: 'independent workstream',
    ...overrides,
  } as Task;
}

function evidence(overrides: Partial<VerificationEvidence> & { id: string }): VerificationEvidence {
  return {
    command: {
      id: 'cmd-1',
      executable: 'npm',
      argv: ['run', 'test', '--', '--runInBand'],
      cwd: 'apps/backend',
      timeoutSeconds: 600,
    },
    startedAt: '2026-10-02T00:00:00.000Z',
    endedAt: '2026-10-02T00:01:00.000Z',
    exitCode: 1,
    criterionIds: ['ac-1'],
    ...overrides,
  } as VerificationEvidence;
}

describe('role briefs', () => {
  it('refuses a profile that widens a read-only role into writing', () => {
    const widened: RoleProfile = { ...PROFILES['director'], toolsPolicy: 'scoped-write' };

    expect(() => roleBriefForProfile(widened)).toThrowError(/tools policy/i);
  });

  it('refuses a QA profile that would let it write', () => {
    const widened: RoleProfile = { ...PROFILES['qa'], toolsPolicy: 'scoped-write' };

    expect(() => roleBriefForProfile(widened)).toThrowError(/tools policy/i);
  });

  it('refuses an unknown role', () => {
    const unknown = { ...PROFILES['worker'], role: 'architect' as CompanyRole };

    expect(() => roleBriefForProfile(unknown)).toThrowError(/architect/);
  });

  it('gives write tools to the Worker alone', () => {
    for (const role of ROLES) {
      const brief = roleBriefForProfile(PROFILES[role]);
      const granted = WRITE_TOOLS.filter((tool) => brief.allowedTools.includes(tool));
      expect(granted).toEqual(role === 'worker' ? WRITE_TOOLS : []);
    }
  });

  it('gives verification commands to QA alone', () => {
    for (const role of ROLES) {
      const brief = roleBriefForProfile(PROFILES[role]);
      expect(brief.allowedTools.includes('company_verify')).toBe(role === 'qa');
    }
  });

  it.each(ROLES)('never lets %s run an arbitrary shell on its own', (role) => {
    const brief = roleBriefForProfile(PROFILES[role]);

    for (const tool of SHELL_TOOLS) {
      expect(brief.allowedTools.includes(tool)).toBe(false);
      expect(brief.askBeforeUse.includes(tool)).toBe(true);
    }
  });

  it('tells the Worker its write scope is a hard boundary', () => {
    const worker = roleBriefForProfile(PROFILES['worker']);

    expect(worker.toolsPolicy).toBe('scoped-write');
    expect(worker.restrictions.join(' ')).toMatch(/write scope/i);
    expect(worker.restrictions.join(' ')).toMatch(/outside/i);
  });

  it.each(['director', 'advisor', 'judge'] as const)(
    'tells the read-only %s that it never writes',
    (role) => {
      const brief = roleBriefForProfile(PROFILES[role]);

      expect(brief.toolsPolicy).toBe('read-only');
      expect(brief.restrictions.join(' ')).toMatch(/never writes/i);
    },
  );
});

describe('role packet', () => {
  it('carries the contract, task, requirement and evidence fields a role needs', () => {
    const goal = requirement({ id: 'req-1', text: 'Paginate the standings endpoint' });
    const contractRecord = contract({ requirements: [goal], decisions: ['Use cursor pagination'] });
    const work = task({ code: 'PA-T0001', requirementIds: [goal.id] });
    work.contractId = contractRecord.id;

    const packet = buildRolePacket({
      role: 'worker',
      contract: contractRecord,
      task: work,
      requirements: [goal],
      evidence: [evidence({ id: 'ev-1' })],
    });

    expect(packet.role).toBe('worker');
    expect(packet.contract).toEqual({
      id: contractRecord.id,
      code: 'PA-C0001',
      revision: 3,
      status: 'running',
    });
    expect(packet.task).toEqual({
      id: work.id,
      code: 'PA-T0001',
      title: 'Standings service',
      status: 'running',
      executionMode: 'session',
      requirementIds: [goal.id],
      dependsOn: [],
      readScopes: [],
      writeScopes: work.writeScopes,
      sharedResources: ['pnpm-lock.yaml'],
      acceptance: ['ac-1'],
      attemptIds: [],
      routeReason: 'independent workstream',
    });
    expect(packet.requirements).toEqual([
      { id: 'req-1', text: 'Paginate the standings endpoint', kind: 'goal', status: 'planned' },
    ]);
    expect(packet.decisions).toEqual(['Use cursor pagination']);
    expect(packet.evidence).toEqual([
      {
        id: 'ev-1',
        executable: 'npm',
        argv: ['run', 'test', '--', '--runInBand'],
        cwd: 'apps/backend',
        exitCode: 1,
        signal: undefined,
        startedAt: '2026-10-02T00:00:00.000Z',
        endedAt: '2026-10-02T00:01:00.000Z',
        criterionIds: ['ac-1'],
        passed: false,
      },
    ]);
    expect(packet.truncated).toEqual({ requirements: 0, decisions: 0, evidence: 0 });
  });

  it('marks evidence that exited zero as passed and a signalled run as not passed', () => {
    const packet = buildRolePacket({
      role: 'qa',
      evidence: [
        evidence({ id: 'ev-ok', exitCode: 0 }),
        evidence({ id: 'ev-signal', exitCode: undefined, signal: 'SIGKILL' }),
      ],
    });

    expect(packet.evidence.map((entry) => entry.passed)).toEqual([true, false]);
  });

  it('keeps unrelated sessions and their history out of the packet', () => {
    const packet = buildRolePacket({
      role: 'worker',
      contract: contract({ code: 'PA-C0001' }),
      task: task({ code: 'PA-T0001' }),
      requirements: [requirement({ id: 'req-1' })],
    });

    const serialized = JSON.stringify(packet);
    expect(serialized).not.toMatch(/PA-S00/);
    expect(serialized).not.toMatch(/native/i);
    expect(serialized).not.toMatch(/prompt/i);
    expect(Object.keys(packet).sort()).toEqual([
      'contract',
      'decisions',
      'evidence',
      'requirements',
      'role',
      'task',
      'truncated',
    ]);
  });

  it('bounds long requirement, decision and evidence lists and reports the overflow', () => {
    const requirements = Array.from({ length: ROLE_PACKET_LIMITS.requirements + 4 }, (_, index) =>
      requirement({ id: `req-${index}` }),
    );
    const decisions = Array.from(
      { length: ROLE_PACKET_LIMITS.decisions + 2 },
      (_, index) => `decision ${index}`,
    );
    const records = Array.from({ length: ROLE_PACKET_LIMITS.evidence + 3 }, (_, index) =>
      evidence({ id: `ev-${index}` }),
    );

    const packet = buildRolePacket({ role: 'worker', requirements, decisions, evidence: records });

    expect(packet.requirements).toHaveLength(ROLE_PACKET_LIMITS.requirements);
    expect(packet.decisions).toHaveLength(ROLE_PACKET_LIMITS.decisions);
    expect(packet.evidence).toHaveLength(ROLE_PACKET_LIMITS.evidence);
    expect(packet.truncated).toEqual({ requirements: 4, decisions: 2, evidence: 3 });
  });

  it('drops evidence that carries no exit status instead of reporting a pass', () => {
    const packet = buildRolePacket({
      role: 'judge',
      evidence: [
        evidence({ id: 'ev-both', exitCode: 0, signal: 'SIGTERM' }),
        evidence({ id: 'ev-neither', exitCode: undefined, signal: undefined }),
      ],
    });
    expect(packet.evidence.map((entry) => entry.id)).toEqual(['ev-both']);
    expect(packet.evidence[0].passed).toBe(false);
  });

  it('truncates long text without splitting a grapheme', () => {
    const long = `${'a'.repeat(ROLE_PACKET_LIMITS.text - 1)}👩🏽‍💻 tail`;

    const packet = buildRolePacket({
      role: 'advisor',
      requirements: [requirement({ id: 'req-long', text: long })],
    });

    const text = packet.requirements[0].text;
    expect(text.length).toBeLessThan(long.length);
    expect(text.endsWith('…')).toBe(true);
    expect(text.includes('\uFFFD')).toBe(false);
    expect(text).not.toMatch(/[\uD800-\uDFFF]/u);
  });
});

describe('role brief text', () => {
  it('renders the brief and packet as one stable instruction block', () => {
    const goal = requirement({ id: 'req-1', text: 'Paginate the standings endpoint' });
    const contractRecord = contract({ requirements: [goal] });
    const work = task({ code: 'PA-T0001', requirementIds: [goal.id] });
    work.contractId = contractRecord.id;

    const brief = roleBriefForProfile(PROFILES['worker']);
    const packet = buildRolePacket({
      role: 'worker',
      contract: contractRecord,
      task: work,
      requirements: [goal],
    });

    const text = roleBriefText(brief, packet);

    expect(text).toContain(brief.purpose);
    expect(text).toContain('PA-C0001');
    expect(text).toContain('PA-T0001');
    expect(text).toContain('Paginate the standings endpoint');
    expect(text).toContain('apps/backend/src/standings');
    expect(roleBriefText(brief, packet)).toBe(text);
  });

  it('never mentions a live handle or a monitoring switch', () => {
    const brief = roleBriefForProfile(PROFILES['worker']);
    const packet = buildRolePacket({
      role: 'worker',
      contract: contract(),
      task: task({ code: 'PA-T0001' }),
    });

    const text = roleBriefText(brief, packet);

    expect(text).not.toMatch(/\bpid\b/i);
    expect(text).not.toMatch(/watch\s+all\s+sessions/i);
    expect(text).not.toMatch(/\b20\d\d-\d\d-\d\dT/);
  });
});

describe('role profile policy', () => {
  it('declares the tools policy each role actually gets, not the one it wishes for', () => {
    expect(Object.fromEntries(ROLES.map((role) => [role, PROFILES[role].toolsPolicy]))).toEqual({
      director: 'read-only',
      advisor: 'read-only',
      worker: 'scoped-write',
      // QA runs declared verification commands; that is its whole authority, so
      // its policy is named for that rather than being described as read-only.
      qa: 'verification-only',
      judge: 'read-only',
    });
    // Only the Worker is granted write tools, and every role's brief matches the
    // policy it was built from.
    for (const role of ROLES) {
      const brief = roleBriefForProfile(PROFILES[role]);
      expect(brief.toolsPolicy).toBe(PROFILES[role].toolsPolicy);
      expect(brief.allowedTools.filter((tool) => WRITE_TOOLS.includes(tool)).length > 0).toBe(
        role === 'worker',
      );
      // Exactly one role may file architecture findings, and it is the Advisor
      // — the Director drafts, it does not review its own Contract.
      expect(brief.allowedTools.includes('company_architecture_review')).toBe(role === 'advisor');
      // A read-only role is never handed a shell, whatever else it may do.
      if (PROFILES[role].toolsPolicy !== 'scoped-write') {
        expect(brief.allowedTools.filter((tool) => SHELL_TOOLS.includes(tool))).toEqual([]);
      }
    }
  });

  it('keeps the settings defaults honest about what each role may run', () => {
    for (const role of ROLES) {
      const profile = PROFILES[role];
      expect(profile.role).toBe(role);
      expect(profile.requestedModel.trim()).not.toBe('');
      expect(profile.thinking.trim()).not.toBe('');
      // Empty by design: a fingerprint only exists once a workspace binds its
      // own workflow, so the default must not invent one.
      expect(profile.workflowFingerprint).toBe('');
    }
    // A fresh set every call: one owner's settings edit can never leak into the
    // next workspace that reads the defaults.
    const first = createRoleProfiles();
    first.worker.toolsPolicy = 'read-only';
    expect(createRoleProfiles().worker.toolsPolicy).toBe('scoped-write');
  });
});

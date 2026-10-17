import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { CompanySession, Contract, Task } from '../../core/src/company.js';
import { routePrompt } from '../src/company/contextRouter.js';
import { PROMPT_DELIVERY_LABELS, SESSION_STATUS_LABELS } from '../src/company/labels.js';

function task(overrides: Partial<Task> & { code: string; workstreamId: string }): Task {
  return {
    id: randomUUID(),
    contractId: randomUUID(),
    phaseId: randomUUID(),
    title: overrides.code,
    requirementIds: [],
    dependsOn: [],
    readScopes: [],
    writeScopes: [],
    sharedResources: [],
    acceptance: [],
    executionMode: 'session',
    status: 'planned',
    attemptIds: [],
    routeReason: 'test',
    ...overrides,
  } as Task;
}

function contract(tasks: Task[], overrides: Partial<Contract> = {}): Contract {
  return {
    id: randomUUID(),
    code: 'PA-C0001',
    revision: 1,
    promptIds: [],
    requirements: [],
    phases: [],
    tasks,
    assumptions: [],
    decisions: [],
    acceptance: [],
    status: 'running',
    ...overrides,
  } as Contract;
}

function session(overrides: Partial<CompanySession> & { code: string }): CompanySession {
  return {
    id: randomUUID(),
    name: overrides.code,
    role: 'worker',
    workstreamId: randomUUID(),
    workspaceKey: 'workspace-key',
    requestedModel: 'openai-codex/gpt-6-luna:xhigh',
    runEpoch: 1,
    status: 'idle',
    lastUsedAt: '2026-10-02T00:00:00.000Z',
    ...overrides,
  } as CompanySession;
}

describe('explicit session targets', () => {
  it('routes to an explicitly named worker session on an approved contract', () => {
    const work = task({ code: 'PA-T0001', workstreamId: 'ws-standings' });
    const approved = contract([work], { code: 'PA-C0001', status: 'approved' });
    work.contractId = approved.id;
    const worker = session({ code: 'PA-S0001', workstreamId: 'ws-standings' });

    const decision = routePrompt({
      delivery: 'prompt',
      targetSessionId: worker.id,
      contracts: [approved],
      sessions: [worker],
    });

    expect(decision.strategy).toBe('explicit_session');
    expect(decision.targetSessionId).toBe(worker.id);
    expect(decision.targetContractId).toBe(approved.id);
    expect(decision.workstreamId).toBe('ws-standings');
    expect(decision.role).toBe('worker');
    expect(decision.newWorkstream).toBe(false);
    expect(decision.rejected).toEqual([]);
    expect(decision.reason).toContain('PA-S0001');
    expect(decision.reason).toContain('PA-C0001');
  });

  it('refuses a worker session whose contract is not approved yet', () => {
    const work = task({ code: 'PA-T0001', workstreamId: 'ws-standings' });
    const draft = contract([work], { code: 'PA-C0002', status: 'awaiting_approval' });
    work.contractId = draft.id;
    const worker = session({ code: 'PA-S0002', workstreamId: 'ws-standings' });

    const decision = routePrompt({
      delivery: 'prompt',
      targetSessionId: worker.id,
      contracts: [draft],
      sessions: [worker],
    });

    expect(decision.strategy).toBe('new_workstream');
    expect(decision.targetSessionId).toBeUndefined();
    expect(decision.role).toBe('director');
    expect(decision.newWorkstream).toBe(true);
    expect(decision.rejected.map((entry) => entry.code)).toEqual([
      'target_session_contract_not_active',
    ]);
    expect(decision.reason).toContain('đang chờ duyệt');
  });

  it('refuses a worker session that no approved contract covers', () => {
    const orphan = session({ code: 'PA-S0003', workstreamId: 'ws-orphan' });

    const decision = routePrompt({
      delivery: 'prompt',
      targetSessionId: orphan.id,
      contracts: [],
      sessions: [orphan],
    });

    expect(decision.strategy).toBe('new_workstream');
    expect(decision.role).toBe('director');
    expect(decision.rejected.map((entry) => entry.code)).toEqual([
      'target_session_contract_not_active',
    ]);
  });

  it('reports an unknown explicit session instead of guessing a replacement', () => {
    const decision = routePrompt({
      delivery: 'prompt',
      targetSessionId: '11111111-1111-4111-8111-111111111111',
      contracts: [],
      sessions: [],
    });

    expect(decision.strategy).toBe('new_workstream');
    expect(decision.targetSessionId).toBeUndefined();
    expect(decision.rejected.map((entry) => entry.code)).toEqual(['target_session_unknown']);
    expect(decision.reason).toContain('11111111-1111-4111-8111-111111111111');
  });

  it.each(['pausing', 'paused', 'stopping', 'stopped', 'crashed', 'archived'] as const)(
    'refuses a %s session instead of dispatching into a run that is not live',
    (status) => {
      const work = task({ code: 'PA-T0001', workstreamId: 'ws-standings' });
      const approved = contract([work], { status: 'approved' });
      work.contractId = approved.id;
      const parked = session({ code: 'PA-S0004', workstreamId: 'ws-standings', status });

      const decision = routePrompt({
        delivery: 'prompt',
        targetSessionId: parked.id,
        contracts: [approved],
        sessions: [parked],
      });

      expect(decision.strategy).toBe('new_workstream');
      expect(decision.rejected.map((entry) => entry.code)).toEqual(['target_session_not_routable']);
      expect(decision.reason).toContain(SESSION_STATUS_LABELS[status]);
    },
  );

  it('routes to a director session that is still planning a draft contract', () => {
    const draft = contract([], { code: 'PA-C0003', status: 'clarifying' });
    const director = session({ code: 'PA-S0005', role: 'director', workstreamId: 'ws-draft' });

    const decision = routePrompt({
      delivery: 'prompt',
      targetSessionId: director.id,
      contracts: [draft],
      sessions: [director],
    });

    expect(decision.strategy).toBe('explicit_session');
    expect(decision.role).toBe('director');
    expect(decision.targetSessionId).toBe(director.id);
    expect(decision.targetContractId).toBeUndefined();
    expect(decision.reason).toContain('PA-S0005');
  });

  it('prefers an explicit session over an explicit contract', () => {
    const work = task({ code: 'PA-T0001', workstreamId: 'ws-standings' });
    const approved = contract([work], { status: 'approved' });
    work.contractId = approved.id;
    const worker = session({ code: 'PA-S0006', workstreamId: 'ws-standings' });

    const decision = routePrompt({
      delivery: 'prompt',
      targetSessionId: worker.id,
      targetContractId: approved.id,
      contracts: [approved],
      sessions: [worker],
    });

    expect(decision.strategy).toBe('explicit_session');
    expect(decision.targetContractId).toBe(approved.id);
    expect(decision.rejected).toEqual([]);
  });
});

describe('explicit contract targets', () => {
  it('attaches to an approved contract and the workstream that owns the prompt', () => {
    const work = task({ code: 'PA-T0001', workstreamId: 'ws-standings' });
    const approved = contract([work], { code: 'PA-C0001', status: 'approved' });
    work.contractId = approved.id;
    const director = session({
      code: 'PA-S0001',
      role: 'director',
      workstreamId: 'ws-standings',
      lastUsedAt: '2026-10-02T00:00:00.000Z',
    });

    const decision = routePrompt({
      delivery: 'prompt',
      targetContractId: approved.id,
      contracts: [approved],
      sessions: [director],
    });

    expect(decision.strategy).toBe('explicit_contract');
    expect(decision.targetContractId).toBe(approved.id);
    expect(decision.workstreamId).toBe('ws-standings');
    expect(decision.targetSessionId).toBe(director.id);
    expect(decision.role).toBe('director');
    expect(decision.newWorkstream).toBe(false);
  });

  it('leaves the workstream open when the contract spans several and none was named', () => {
    const first = task({ code: 'PA-T0001', workstreamId: 'ws-a' });
    const second = task({ code: 'PA-T0002', workstreamId: 'ws-b' });
    const approved = contract([first, second], { status: 'approved' });

    const decision = routePrompt({
      delivery: 'prompt',
      targetContractId: approved.id,
      contracts: [approved],
      sessions: [],
    });

    expect(decision.strategy).toBe('explicit_contract');
    expect(decision.targetContractId).toBe(approved.id);
    expect(decision.workstreamId).toBeUndefined();
    expect(decision.targetSessionId).toBeUndefined();
    expect(decision.reason).toContain('PA-C0001');
  });

  it('refuses a contract that does not exist', () => {
    const decision = routePrompt({
      delivery: 'prompt',
      targetContractId: '22222222-2222-4222-8222-222222222222',
      contracts: [],
      sessions: [],
    });

    expect(decision.strategy).toBe('new_workstream');
    expect(decision.targetContractId).toBeUndefined();
    expect(decision.rejected.map((entry) => entry.code)).toEqual(['target_contract_unknown']);
  });

  it('refuses a cancelled contract', () => {
    const cancelled = contract([], { code: 'PA-C0009', status: 'cancelled' });

    const decision = routePrompt({
      delivery: 'prompt',
      targetContractId: cancelled.id,
      contracts: [cancelled],
      sessions: [],
    });

    expect(decision.strategy).toBe('new_workstream');
    expect(decision.rejected.map((entry) => entry.code)).toEqual(['target_contract_not_active']);
    expect(decision.reason).toContain('đã bị hủy');
  });

  it('routes a draft contract to the Director for planning rather than dropping it', () => {
    const draft = contract([task({ code: 'PA-T0001', workstreamId: 'ws-a' })], {
      code: 'PA-C0004',
      status: 'draft',
    });

    const decision = routePrompt({
      delivery: 'prompt',
      targetContractId: draft.id,
      contracts: [draft],
      sessions: [],
    });

    expect(decision.strategy).toBe('explicit_contract');
    expect(decision.role).toBe('director');
    expect(decision.newWorkstream).toBe(false);
    expect(decision.rejected).toEqual([]);
  });
});

describe('accepted contract/workstream relations', () => {
  it('joins the workstream of a validator-accepted relation and reuses its director', () => {
    const work = task({ code: 'PA-T0001', workstreamId: 'ws-standings' });
    const approved = contract([work], { code: 'PA-C0001', status: 'approved' });
    work.contractId = approved.id;
    const director = session({ code: 'PA-S0001', role: 'director', workstreamId: 'ws-standings' });
    const stranger = session({ code: 'PA-S0002', role: 'director', workstreamId: 'ws-other' });

    const decision = routePrompt({
      delivery: 'prompt',
      contracts: [approved],
      sessions: [director, stranger],
      acceptedRelation: { contractId: approved.id, workstreamId: 'ws-standings' },
    });

    expect(decision.strategy).toBe('approved_workstream');
    expect(decision.targetContractId).toBe(approved.id);
    expect(decision.workstreamId).toBe('ws-standings');
    expect(decision.targetSessionId).toBe(director.id);
    expect(decision.newWorkstream).toBe(false);
    expect(decision.reason).toContain('ws-standings');
  });

  it('refuses a relation whose workstream the contract does not own', () => {
    const approved = contract([task({ code: 'PA-T0001', workstreamId: 'ws-a' })], {
      status: 'approved',
    });

    const decision = routePrompt({
      delivery: 'prompt',
      contracts: [approved],
      sessions: [],
      acceptedRelation: { contractId: approved.id, workstreamId: 'ws-invented' },
    });

    expect(decision.strategy).toBe('new_workstream');
    expect(decision.rejected.map((entry) => entry.code)).toEqual(['relation_workstream_unknown']);
    expect(decision.reason).toContain('ws-invented');
  });

  it('refuses a relation to a contract that is not approved yet', () => {
    const waiting = contract([task({ code: 'PA-T0001', workstreamId: 'ws-a' })], {
      code: 'PA-C0005',
      status: 'awaiting_approval',
    });

    const decision = routePrompt({
      delivery: 'prompt',
      contracts: [waiting],
      sessions: [],
      acceptedRelation: { contractId: waiting.id, workstreamId: 'ws-a' },
    });

    expect(decision.strategy).toBe('new_workstream');
    expect(decision.rejected.map((entry) => entry.code)).toEqual(['relation_contract_not_active']);
  });

  it('refuses a relation naming a contract that does not exist', () => {
    const decision = routePrompt({
      delivery: 'prompt',
      contracts: [],
      sessions: [],
      acceptedRelation: {
        contractId: '33333333-3333-4333-8333-333333333333',
        workstreamId: 'ws-a',
      },
    });

    expect(decision.strategy).toBe('new_workstream');
    expect(decision.rejected.map((entry) => entry.code)).toEqual(['relation_contract_unknown']);
  });
});

describe('no similarity guessing', () => {
  it('never reuses a similarly named contract or session from the same workspace', () => {
    const lookalike = task({ code: 'PA-T0001', workstreamId: 'ws-standings-2' });
    const other = contract([lookalike], {
      code: 'PA-C0001',
      title: 'Standings API v2',
      status: 'approved',
    });
    const lookalikeSession = session({
      code: 'PA-S0001',
      name: 'Worker - standings API',
      workstreamId: 'ws-standings-2',
    });

    const decision = routePrompt({
      delivery: 'prompt',
      contracts: [other],
      sessions: [lookalikeSession],
    });

    expect(decision.strategy).toBe('new_workstream');
    expect(decision.newWorkstream).toBe(true);
    expect(decision.targetSessionId).toBeUndefined();
    expect(decision.targetContractId).toBeUndefined();
    expect(decision.workstreamId).toBeUndefined();
    expect(decision.role).toBe('director');
  });
});

describe('new workstream intake', () => {
  it('starts a new workstream at the Director when nothing matches', () => {
    const decision = routePrompt({ delivery: 'prompt', contracts: [], sessions: [] });

    expect(decision.strategy).toBe('new_workstream');
    expect(decision.newWorkstream).toBe(true);
    expect(decision.role).toBe('director');
    expect(decision.targetSessionId).toBeUndefined();
    expect(decision.targetContractId).toBeUndefined();
    expect(decision.rejected).toEqual([]);
    expect(decision.reason).toMatch(/workstream mới/);
  });

  it('reports every refused target in the reason so the user can retarget', () => {
    const decision = routePrompt({
      delivery: 'prompt',
      targetSessionId: '44444444-4444-4444-8444-444444444444',
      targetContractId: '55555555-5555-4555-8555-555555555555',
      contracts: [],
      sessions: [],
    });

    expect(decision.rejected.map((entry) => entry.code)).toEqual([
      'target_session_unknown',
      'target_contract_unknown',
    ]);
    expect(decision.reason).toContain('44444444-4444-4444-8444-444444444444');
    expect(decision.reason).toContain('55555555-5555-4555-8555-555555555555');
    expect(decision.reason).toMatch(/Director/);
  });
});

describe('delivery modes', () => {
  it('steers the explicitly named session', () => {
    const work = task({ code: 'PA-T0001', workstreamId: 'ws-standings' });
    const approved = contract([work], { status: 'approved' });
    work.contractId = approved.id;
    const worker = session({ code: 'PA-S0001', workstreamId: 'ws-standings', status: 'busy' });

    const decision = routePrompt({
      delivery: 'steer',
      targetSessionId: worker.id,
      contracts: [approved],
      sessions: [worker],
    });

    expect(decision.strategy).toBe('explicit_session');
    expect(decision.targetSessionId).toBe(worker.id);
  });

  it.each(['steer', 'follow_up'] as const)(
    'refuses to %s anything when no session resolved',
    (delivery) => {
      const decision = routePrompt({ delivery, contracts: [], sessions: [] });

      expect(decision.strategy).toBe('undeliverable');
      expect(decision.newWorkstream).toBe(false);
      expect(decision.targetSessionId).toBeUndefined();
      expect(decision.reason).toContain(PROMPT_DELIVERY_LABELS[delivery]);
    },
  );

  it('refuses a follow-up whose only target was a contract', () => {
    const approved = contract([task({ code: 'PA-T0001', workstreamId: 'ws-a' })], {
      status: 'approved',
    });

    const decision = routePrompt({
      delivery: 'follow_up',
      targetContractId: approved.id,
      contracts: [approved],
      sessions: [],
    });

    expect(decision.strategy).toBe('undeliverable');
    expect(decision.newWorkstream).toBe(false);
  });
});

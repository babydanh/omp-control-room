import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { CompanySession, Contract, Task } from '../../core/src/company.js';
import {
  createInitialCompanyState,
  createRoleProfiles,
  withMissingRoleProfiles,
} from '../src/company/companyState.js';
import { routePrompt } from '../src/company/contextRouter.js';
import { buildOmpRunnerArgs } from '../src/company/ompRunner.js';
import { decideToolCall } from '../src/company/permissionPolicy.js';

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
    role: 'chat',
    workstreamId: `chat-${randomUUID()}`,
    workspaceKey: 'workspace-key',
    requestedModel: 'openai-codex/gpt-6-luna',
    runEpoch: 1,
    status: 'idle',
    lastUsedAt: '2026-10-02T00:00:00.000Z',
    ...overrides,
  } as CompanySession;
}

/** The profile for one role; a missing role is a test bug, so it fails loudly. */
function profileOf(role: string) {
  const profile = createRoleProfiles()[role];
  if (profile === undefined) throw new Error(`no profile for ${role}`);
  return profile;
}

describe('chat prompts routing', () => {
  it('opens one new plain chat session when nothing is selected', () => {
    const decision = routePrompt({ mode: 'chat', delivery: 'prompt', contracts: [], sessions: [] });

    expect(decision.strategy).toBe('new_chat');
    expect(decision.role).toBe('chat');
    expect(decision.newWorkstream).toBe(false);
    expect(decision.targetSessionId).toBeUndefined();
    expect(decision.rejected).toEqual([]);
  });

  it('sends the next prompt to the chat session it names, whatever its status', () => {
    for (const status of ['idle', 'busy', 'parked'] as const) {
      const chat = session({ code: 'PA-S0002', status, workstreamId: 'chat-1' });

      const decision = routePrompt({
        mode: 'chat',
        delivery: 'prompt',
        targetSessionId: chat.id,
        contracts: [],
        sessions: [chat],
      });

      expect(decision.strategy).toBe('explicit_session');
      expect(decision.targetSessionId).toBe(chat.id);
      expect(decision.workstreamId).toBe('chat-1');
      expect(decision.role).toBe('chat');
      expect(decision.rejected).toEqual([]);
    }
  });

  it('refuses a named session that does not exist instead of opening a new one', () => {
    const decision = routePrompt({
      mode: 'chat',
      delivery: 'prompt',
      targetSessionId: '11111111-1111-4111-8111-111111111111',
      contracts: [],
      sessions: [],
    });

    expect(decision.strategy).toBe('undeliverable');
    expect(decision.targetSessionId).toBeUndefined();
    expect(decision.rejected.map((entry) => entry.code)).toEqual(['target_session_unknown']);
  });

  it('refuses steer and follow-up when no session is named', () => {
    for (const delivery of ['steer', 'follow_up'] as const) {
      const decision = routePrompt({ mode: 'chat', delivery, contracts: [], sessions: [] });

      expect(decision.strategy).toBe('undeliverable');
      expect(decision.reason).toContain('cần một phiên đang hoạt động');
    }
  });

  it('never attaches a chat prompt to a Contract', () => {
    const work = task({ code: 'PA-T0001', workstreamId: 'ws-standings' });
    const approved = contract([work], { status: 'approved' });
    work.contractId = approved.id;

    const decision = routePrompt({
      mode: 'chat',
      delivery: 'prompt',
      targetContractId: approved.id,
      contracts: [approved],
      sessions: [],
    });

    expect(decision.strategy).toBe('new_chat');
    expect(decision.targetContractId).toBeUndefined();
  });

  it('refuses a named worker whose Contract was cancelled, with no replacement session', () => {
    const work = task({ code: 'PA-T0002', workstreamId: 'ws-standings' });
    const cancelled = contract([work], { status: 'cancelled' });
    work.contractId = cancelled.id;
    const worker = session({ code: 'PA-S0003', role: 'worker', workstreamId: 'ws-standings' });

    const decision = routePrompt({
      mode: 'chat',
      delivery: 'prompt',
      targetSessionId: worker.id,
      contracts: [cancelled],
      sessions: [worker],
    });

    expect(decision.strategy).toBe('undeliverable');
    expect(decision.rejected.map((entry) => entry.code)).toEqual([
      'target_session_contract_not_active',
    ]);
  });

  it('keeps the company ladder when mode is absent or company', () => {
    const absent = routePrompt({ delivery: 'prompt', contracts: [], sessions: [] });
    const company = routePrompt({
      mode: 'company',
      delivery: 'prompt',
      contracts: [],
      sessions: [],
    });

    for (const decision of [absent, company]) {
      expect(decision.strategy).toBe('new_workstream');
      expect(decision.role).toBe('director');
      expect(decision.newWorkstream).toBe(true);
    }
  });
});

describe('stored boards without a chat profile', () => {
  it('adds the chat profile and leaves every stored profile as it was', () => {
    const state = createInitialCompanyState('D:/workspace');
    const withoutChat = { ...state.settings.roleProfiles };
    delete withoutChat['chat'];
    const legacy = { ...state, settings: { ...state.settings, roleProfiles: withoutChat } };

    const migrated = withMissingRoleProfiles(legacy);

    expect(migrated.settings.roleProfiles['chat']).toEqual(profileOf('chat'));
    expect(migrated.settings.roleProfiles['chat']?.toolsPolicy).toBe('omp');
    expect(migrated.settings.roleProfiles['worker']).toBe(legacy.settings.roleProfiles['worker']);
  });

  it('returns the same state when every role already has a profile', () => {
    const state = createInitialCompanyState('D:/workspace');

    expect(withMissingRoleProfiles(state)).toBe(state);
  });
});

describe('omp launch for chat sessions', () => {
  const extensionPath = 'C:/bridge/company-omp-bridge.mjs';

  it('leaves approvals and the session directory to the user’s own omp', () => {
    const args = buildOmpRunnerArgs({
      commandArgs: ['omp'],
      extensionPath,
      roleProfile: profileOf('chat'),
    });

    expect(args).toContain('--extension');
    expect(args).not.toContain('--approval-mode');
    expect(args).not.toContain('--session-dir');
    expect(args).not.toContain('--resume');
  });

  it('resumes an omp session file exactly', () => {
    const args = buildOmpRunnerArgs({
      commandArgs: ['omp'],
      extensionPath,
      roleProfile: profileOf('chat'),
      resumeFile: 'C:/Users/GIGABYTE/.omp/agent/sessions/a.jsonl',
    });

    expect(args.slice(args.indexOf('--resume'))).toEqual([
      '--resume',
      'C:/Users/GIGABYTE/.omp/agent/sessions/a.jsonl',
    ]);
  });

  it('keeps the company launch for a worker: write approval and its own session directory', () => {
    const args = buildOmpRunnerArgs({
      commandArgs: ['omp'],
      extensionPath,
      roleProfile: profileOf('worker'),
      sessionDirectory: 'D:/namespace/sessions/s1',
    });

    expect(args[args.indexOf('--approval-mode') + 1]).toBe('write');
    expect(args[args.indexOf('--session-dir') + 1]).toBe('D:/namespace/sessions/s1');
  });
});

describe('chat tool calls', () => {
  it('are not gated by company policy', () => {
    const decision = decideToolCall({
      role: 'chat',
      tool: 'bash',
      args: { command: 'rm -rf build' },
      workspaceRoot: 'D:/workspace',
      writeScopes: [],
    });

    expect(decision.allowed).toBe(true);
  });

  it('still gate a worker shell', () => {
    const decision = decideToolCall({
      role: 'worker',
      tool: 'bash',
      args: { command: 'ls' },
      workspaceRoot: 'D:/workspace',
      writeScopes: [],
    });

    expect(decision.allowed).toBe(false);
  });
});

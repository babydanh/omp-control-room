import { describe, expect, it } from 'vitest';

import {
  COMPANY_DEFAULT_MODELS,
  COMPANY_FALLBACK_ROLE_THINKING,
} from '../src/company/constants.js';
import {
  type HostRoleSelector,
  readCompanyModelRoles,
  resolveCompanyModelRoles,
} from '../src/company/hostModelRoles.js';

const HOST: Record<string, HostRoleSelector> = {
  plan: { model: 'anthropic/claude-opus-5-5', thinking: 'high' },
  advisor: { model: 'openai-codex/gpt-6-luna', thinking: 'max' },
  task: { model: 'anthropic/claude-haiku-5-5', thinking: null },
  default: { model: 'anthropic/claude-haiku-5-5', thinking: 'medium' },
  judge: { model: 'openai/gpt-classifier', thinking: null },
  slow: { model: 'anthropic/claude-opus-4-6', thinking: null },
};

describe('resolveCompanyModelRoles', () => {
  it('runs each role on the host role that matches its job', () => {
    const resolution = resolveCompanyModelRoles(HOST);

    expect(resolution.source).toBe('host');
    expect(resolution.diagnostic).toBeNull();
    expect(resolution.assignments.director).toMatchObject({
      model: 'anthropic/claude-opus-5-5',
      thinking: 'high',
      hostRole: 'plan',
    });
    expect(resolution.assignments.advisor).toMatchObject({
      model: 'openai-codex/gpt-6-luna',
      thinking: 'max',
      hostRole: 'advisor',
    });
    expect(resolution.assignments.qa).toMatchObject({
      model: 'anthropic/claude-haiku-5-5',
      thinking: 'medium',
      hostRole: 'default',
    });
  });

  it('keeps the fallback effort when the host selector names none', () => {
    const worker = resolveCompanyModelRoles(HOST).assignments.worker;

    expect(worker).toMatchObject({
      model: 'anthropic/claude-haiku-5-5',
      thinking: COMPANY_FALLBACK_ROLE_THINKING.worker,
      hostRole: 'task',
      thinkingFromHost: false,
    });
  });

  it('never runs the Judge on the host judge classifier', () => {
    const judge = resolveCompanyModelRoles(HOST).assignments.judge;

    expect(judge.hostRole).toBe('default');
    expect(judge.model).toBe('anthropic/claude-haiku-5-5');
    expect(resolveCompanyModelRoles(HOST).ignoredHostRoles).toEqual(['judge', 'slow']);
  });

  it('borrows default for a role the host has not set', () => {
    const { advisor: _advisor, task: _task, ...withoutAdvisorAndTask } = HOST;
    const resolution = resolveCompanyModelRoles(withoutAdvisorAndTask);

    expect(resolution.source).toBe('host');
    expect(resolution.assignments.advisor).toMatchObject({
      model: 'anthropic/claude-haiku-5-5',
      thinking: 'medium',
      hostRole: 'default',
    });
    expect(resolution.assignments.worker.hostRole).toBe('default');
  });

  it('is mixed when only some roles resolve and there is no default to borrow', () => {
    const resolution = resolveCompanyModelRoles({ plan: HOST.plan, judge: HOST.judge });

    expect(resolution.source).toBe('mixed');
    expect(resolution.assignments.director.hostRole).toBe('plan');
    expect(resolution.assignments.judge).toMatchObject({
      model: COMPANY_DEFAULT_MODELS.judge,
      hostRole: null,
    });
    expect(resolution.diagnostic).not.toBeNull();
  });

  it('falls back for every role when the host reports nothing', () => {
    const resolution = resolveCompanyModelRoles(null);

    expect(resolution.source).toBe('fallback');
    expect(resolution.assignments.advisor).toMatchObject({
      model: COMPANY_DEFAULT_MODELS.advisor,
      thinking: COMPANY_FALLBACK_ROLE_THINKING.advisor,
      hostRole: null,
    });
  });
});

describe('readCompanyModelRoles', () => {
  it('resolves every role from one omp config read', async () => {
    const value = {
      plan: 'anthropic/claude-opus-5-5:high',
      advisor: 'openai-codex/gpt-6-luna:max',
      task: 'anthropic/claude-haiku-5-5',
      default: 'anthropic/claude-haiku-5-5:medium',
    };
    const resolution = await readCompanyModelRoles({
      command: { file: 'omp', args: [] },
      cwd: '.',
      runner: async () => ({
        stdout: JSON.stringify({ key: 'modelRoles', value, type: 'record' }),
        stderr: '',
        exitCode: 0,
        timedOut: false,
      }),
    });

    expect(resolution.source).toBe('host');
    expect(resolution.assignments.advisor.model).toBe('openai-codex/gpt-6-luna');
    expect(resolution.assignments.worker.model).toBe('anthropic/claude-haiku-5-5');
    expect(resolution.assignments.director.thinking).toBe('high');
  });
});

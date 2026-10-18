import { describe, expect, it } from 'vitest';

import type { CompanySessionInsight, CompanySessionTodo } from '../../core/src/messages.js';
import {
  liveSessionInsight,
  planModeLabel,
  sessionProgressLabel,
  subagentSummary,
  todoProgress,
} from '../src/company/sessionInsightView.js';

const TODO: CompanySessionTodo = {
  phases: [
    {
      name: 'Build',
      tasks: [
        { content: 'Compile', status: 'completed' },
        { content: 'Test', status: 'in_progress' },
        { content: 'Drop', status: 'abandoned' },
      ],
    },
    {
      name: 'Ship',
      tasks: [{ content: 'Release', status: 'blocked', blocker: 'waiting on review' }],
    },
  ],
};

function insight(overrides: Partial<CompanySessionInsight>): CompanySessionInsight {
  return { observedAt: '2026-05-01T10:00:00.000Z', planMode: 'none', subagents: [], ...overrides };
}

describe('todoProgress', () => {
  it('counts completed over every task except abandoned ones, and names the active task', () => {
    expect(todoProgress(TODO)).toEqual({ done: 1, total: 3, active: 'Test' });
  });

  it('omits the active task when nothing is in progress', () => {
    const pending: CompanySessionTodo = {
      phases: [{ name: 'A', tasks: [{ content: 'x', status: 'pending' }] }],
    };
    expect(todoProgress(pending)).toEqual({ done: 0, total: 1 });
  });
});

describe('subagentSummary', () => {
  it('counts running subagents against all rows', () => {
    const rows = [
      { id: 'a', agent: 'reviewer', status: 'running' as const, tokens: 1, durationMs: 1 },
      { id: 'b', agent: 'reviewer', status: 'completed' as const, tokens: 1, durationMs: 1 },
    ];
    expect(subagentSummary(rows)).toEqual({ running: 1, total: 2 });
  });
});

describe('planModeLabel', () => {
  it('names plan mode and falls back to the raw mode for anything else', () => {
    expect(planModeLabel('plan')).toBe('Đang lập kế hoạch');
    expect(planModeLabel('review')).toBe('Chế độ review');
  });
});

describe('liveSessionInsight', () => {
  it('returns the insight while the OMP process runs', () => {
    const current = insight({});
    expect(liveSessionInsight({ status: 'busy', insight: current })).toBe(current);
    expect(liveSessionInsight({ status: 'idle', insight: current })).toBe(current);
  });

  it('hides the insight once the session has stopped, parked or crashed', () => {
    const current = insight({});
    expect(liveSessionInsight({ status: 'parked', insight: current })).toBeUndefined();
    expect(liveSessionInsight({ status: 'stopped', insight: current })).toBeUndefined();
    expect(liveSessionInsight({ status: 'crashed', insight: current })).toBeUndefined();
  });

  it('returns undefined when no insight has been reported', () => {
    expect(liveSessionInsight({ status: 'busy', insight: undefined })).toBeUndefined();
  });
});

describe('sessionProgressLabel', () => {
  it('joins todo progress and running subagents into one line', () => {
    const running = [
      { id: 'a', agent: 'reviewer', status: 'running' as const, tokens: 1, durationMs: 1 },
    ];
    expect(sessionProgressLabel(insight({ todo: TODO, subagents: running }))).toBe(
      'Việc 1/3 · 1 subagent đang chạy',
    );
  });

  it('returns undefined when there is neither todo work nor a running subagent', () => {
    expect(sessionProgressLabel(insight({}))).toBeUndefined();
  });
});

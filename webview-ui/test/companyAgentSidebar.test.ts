import { describe, expect, it } from 'vitest';

import type { HerdrAgent } from '../../core/src/company.js';
import {
  buildAgentGroups,
  herdrGroup,
  pendingQuestionSessionIds,
} from '../src/company/agentSidebarView.js';
import {
  type CompanyViewState,
  emptyHerdrView,
  type HerdrView,
} from '../src/company/companyState.js';
import { COMPANY_ROLES } from '../src/company/roleProfiles.js';
import { question, session, stateFrom, task } from './companyFixtures.js';

function workerGroup(state: CompanyViewState) {
  return buildAgentGroups(state).find((group) => group.role === 'worker');
}

function herdrAgent(overrides: Partial<HerdrAgent>): HerdrAgent {
  return {
    paneId: 'pane-1',
    kind: 'claude',
    status: 'idle',
    workspaceId: 'ws-1',
    ...overrides,
  };
}

function herdrView(overrides: Partial<HerdrView>): HerdrView {
  return { ...emptyHerdrView(), loaded: true, available: true, ...overrides };
}

describe('buildAgentGroups', () => {
  it('lists every role in the company order, including roles with no agents', () => {
    const groups = buildAgentGroups(stateFrom());
    expect(groups.map((group) => group.role)).toEqual([...COMPANY_ROLES]);
    expect(groups.every((group) => group.active.length === 0 && group.parked.length === 0)).toBe(
      true,
    );
  });

  it('puts rows that need the user first, then the rest by session code', () => {
    const quiet = session({ code: 'PA-S0002', status: 'idle' });
    const busy = session({ code: 'PA-S0010', status: 'busy' });
    const waiting = session({ code: 'PA-S0003', status: 'waiting_input' });

    const group = workerGroup(stateFrom({ sessions: [busy, quiet, waiting] }));

    expect(group?.active.map((row) => row.code)).toEqual(['PA-S0003', 'PA-S0002', 'PA-S0010']);
  });

  it('counts a session with a pending question as waiting on the user, even when it looks busy', () => {
    const busy = session({ code: 'PA-S0001', status: 'busy' });
    const asking = question({ sessionId: busy.id, status: 'pending' });

    const group = workerGroup(stateFrom({ sessions: [busy], questions: [asking] }));

    expect(group?.active[0]).toMatchObject({ tone: 'needs', needsYou: true, label: 'chờ bạn' });
  });

  it('keeps paused and archived sessions out of the live rows, under parked', () => {
    const paused = session({ status: 'paused' });
    const archived = session({ status: 'archived' });

    const group = workerGroup(stateFrom({ sessions: [paused, archived] }));

    expect(group?.active).toEqual([]);
    expect(group?.parked.map((row) => row.sessionId).sort()).toEqual(
      [paused.id, archived.id].sort(),
    );
  });

  it('labels each row with its status word and the task it holds', () => {
    const work = task({ code: 'PA-T0001', title: 'Wire the sidebar' });
    const idle = session({ code: 'PA-S0001', status: 'idle', activeTaskId: work.id });
    const crashed = session({ code: 'PA-S0002', status: 'crashed' });

    const rows = workerGroup(stateFrom({ tasks: [work], sessions: [idle, crashed] }))?.active ?? [];
    const rowOf = (code: string) => rows.find((row) => row.code === code);

    expect(rowOf('PA-S0001')).toMatchObject({
      label: 'rảnh',
      taskLine: 'PA-T0001 · Wire the sidebar',
    });
    expect(rowOf('PA-S0002')).toMatchObject({ tone: 'error', label: 'lỗi', taskLine: null });
  });
});

describe('pendingQuestionSessionIds', () => {
  it('names only the sessions with a question still waiting on an answer', () => {
    const waiting = session();
    const answered = session();
    const state = stateFrom({
      sessions: [waiting, answered],
      questions: [
        question({ sessionId: waiting.id, status: 'pending' }),
        question({ sessionId: answered.id, status: 'answered' }),
      ],
    });

    expect([...pendingQuestionSessionIds(state)]).toEqual([waiting.id]);
  });
});

describe('herdrGroup', () => {
  it('stays hidden until the server has answered the herdr question', () => {
    expect(herdrGroup(emptyHerdrView())).toEqual({ kind: 'hidden' });
  });

  it('explains an unavailable herdr, with the reason when the server gave one', () => {
    expect(herdrGroup(herdrView({ available: false, reason: 'socket missing' }))).toEqual({
      kind: 'unavailable',
      message: 'herdr không khả dụng: socket missing',
    });
    expect(herdrGroup(herdrView({ available: false }))).toEqual({
      kind: 'unavailable',
      message: 'herdr không khả dụng.',
    });
  });

  it('sorts agents that need the user first, then working, idle, done and unknown', () => {
    const group = herdrGroup(
      herdrView({
        agents: [
          herdrAgent({ paneId: 'a', name: 'zeta', status: 'idle' }),
          herdrAgent({ paneId: 'b', name: 'beta', status: 'blocked' }),
          herdrAgent({ paneId: 'c', name: 'alpha', status: 'working' }),
          herdrAgent({ paneId: 'd', name: 'alpha2', status: 'working' }),
          herdrAgent({ paneId: 'e', name: 'omega', status: 'done' }),
          herdrAgent({ paneId: 'f', name: 'mu', status: 'unknown' }),
        ],
      }),
    );

    expect(group.kind).toBe('ready');
    if (group.kind !== 'ready') return;
    expect(group.rows.map((row) => row.paneId)).toEqual(['b', 'c', 'd', 'a', 'e', 'f']);
  });

  it('labels a blocked agent as waiting on the user and falls back to the working directory', () => {
    const group = herdrGroup(
      herdrView({
        agents: [herdrAgent({ paneId: 'p', name: 'claude', status: 'blocked', cwd: 'C:/repo' })],
      }),
    );

    expect(group.kind).toBe('ready');
    if (group.kind !== 'ready') return;
    expect(group.rows[0]).toMatchObject({
      paneId: 'p',
      tone: 'needs',
      label: 'chờ bạn',
      detail: 'C:/repo',
    });
  });
});

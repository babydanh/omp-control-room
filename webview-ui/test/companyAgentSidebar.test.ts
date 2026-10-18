import { describe, expect, it } from 'vitest';

import type { HerdrAgent } from '../../core/src/company.js';
import {
  buildAgentGroups,
  type HerdrGroup,
  herdrGroup,
  type HerdrRepoGroup,
  isFolded,
  pendingQuestionSessionIds,
  workspaceSessionRow,
} from '../src/company/agentSidebarView.js';
import {
  type CompanyViewState,
  emptyHerdrView,
  type HerdrView,
} from '../src/company/companyState.js';
import { COMPANY_ROLES, companyRoleLabel } from '../src/company/roleProfiles.js';
import { question, session, stateFrom, task } from './companyFixtures.js';

/** A fixed clock for the relative times: the view never reads the real one. */
const NOW = Date.parse('2026-05-01T10:30:00.000Z');

function workerGroup(state: CompanyViewState) {
  return buildAgentGroups(state, NOW).find((group) => group.role === 'worker');
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

/** The repo groups of a ready herdr group; any other kind fails the test. */
function readyRepos(group: HerdrGroup): HerdrRepoGroup[] {
  if (group.kind !== 'ready') throw new Error(`expected a ready herdr group, got ${group.kind}`);
  return group.repos;
}

/** Every herdr pane of a ready group, repo by repo, in display order. */
function herdrPaneIds(group: HerdrGroup): string[] {
  return readyRepos(group).flatMap((repo) => repo.rows.map((row) => row.paneId));
}

describe('buildAgentGroups', () => {
  it('lists every role in the company order, including roles with no agents', () => {
    const groups = buildAgentGroups(stateFrom(), NOW);
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
    const crashed = session({ code: 'PA-S0002', status: 'crashed', activeTaskId: work.id });

    const rows = workerGroup(stateFrom({ tasks: [work], sessions: [idle, crashed] }))?.active ?? [];
    const rowOf = (code: string) => rows.find((row) => row.code === code);

    expect(rowOf('PA-S0001')).toMatchObject({
      label: 'rảnh',
      taskLine: 'PA-T0001 · Wire the sidebar',
    });
    expect(rowOf('PA-S0002')).toMatchObject({ tone: 'error', label: 'lỗi' });
  });

  it('folds a crash that holds no task, which every board restart leaves behind', () => {
    const leftover = session({ code: 'PA-S0003', status: 'crashed' });

    const group = workerGroup(stateFrom({ sessions: [leftover] }));

    expect(group?.active).toEqual([]);
    expect(group?.parked.map((row) => row.code)).toEqual(['PA-S0003']);
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

    expect(herdrPaneIds(group)).toEqual(['b', 'c', 'd', 'a', 'e', 'f']);
  });

  it('labels a blocked agent as waiting on the user and falls back to the working directory', () => {
    const group = herdrGroup(
      herdrView({
        agents: [herdrAgent({ paneId: 'p', name: 'claude', status: 'blocked', cwd: 'C:/repo' })],
      }),
    );

    expect(readyRepos(group)[0]?.rows[0]).toMatchObject({
      paneId: 'p',
      tone: 'needs',
      label: 'chờ bạn',
      summary: { glyph: '', text: 'C:/repo', age: null },
    });
  });
});

describe('herdrGroup repo placement', () => {
  it('groups agents by repository across workspaces, each group where its most urgent agent sorts', () => {
    const repos = readyRepos(
      herdrGroup(
        herdrView({
          agents: [
            herdrAgent({
              paneId: 'a',
              name: 'a',
              status: 'idle',
              repo: 'pixel-agents',
              workspaceLabel: 'ws-1',
            }),
            herdrAgent({
              paneId: 'b',
              name: 'b',
              status: 'idle',
              repo: 'omp',
              workspaceLabel: 'ws-2',
            }),
            herdrAgent({
              paneId: 'c',
              name: 'c',
              status: 'blocked',
              repo: 'pixel-agents',
              workspaceLabel: 'ws-2',
            }),
          ],
        }),
      ),
    );

    expect(repos.map((repo) => [repo.label, repo.source])).toEqual([
      ['pixel-agents', 'repo'],
      ['omp', 'repo'],
    ]);
    expect(repos[0]?.rows.map((row) => row.paneId)).toEqual(['c', 'a']);
  });

  it('keeps a repository and a workspace of the same name in separate groups', () => {
    const repos = readyRepos(
      herdrGroup(
        herdrView({
          agents: [
            herdrAgent({ paneId: 'r', repo: 'shared' }),
            herdrAgent({ paneId: 'w', workspaceLabel: 'shared' }),
          ],
        }),
      ),
    );

    expect(repos.map((repo) => repo.key)).toEqual(['repo:shared', 'workspace:shared']);
  });

  it('places an agent with no repository under its workspace, then its folder, then khác', () => {
    const repos = readyRepos(
      herdrGroup(
        herdrView({
          agents: [
            herdrAgent({ paneId: 'w', workspaceLabel: 'Scratch', cwd: 'C:/tmp/x' }),
            herdrAgent({ paneId: 'f', cwd: 'C:\\Users\\me\\notes\\' }),
            herdrAgent({ paneId: 'o' }),
          ],
        }),
      ),
    );

    expect(repos.map((repo) => [repo.source, repo.label])).toEqual([
      ['workspace', 'Scratch'],
      ['folder', 'notes'],
      ['other', 'khác'],
    ]);
  });

  it('carries the branch and worktree root of an agent that works in a git worktree', () => {
    const repos = readyRepos(
      herdrGroup(
        herdrView({
          agents: [
            herdrAgent({
              paneId: 'p',
              status: 'working',
              repo: 'pixel-agents',
              branch: 'feat/rail',
              worktreeRoot: 'C:/wt/rail',
            }),
          ],
        }),
      ),
    );

    expect(repos[0]?.rows[0]).toMatchObject({
      branch: 'feat/rail',
      worktreeRoot: 'C:/wt/rail',
      repo: { key: 'repo:pixel-agents', label: 'pixel-agents', source: 'repo' },
    });
  });

  it('reads a blank branch or worktree root as none', () => {
    const repos = readyRepos(
      herdrGroup(
        herdrView({ agents: [herdrAgent({ paneId: 'p', branch: '   ', worktreeRoot: '' })] }),
      ),
    );

    expect(repos[0]?.rows[0]).toMatchObject({ branch: null, worktreeRoot: null });
  });
});

describe('workspaceSessionRow', () => {
  it("shows a folder's session as its row, with its role on the second line", () => {
    const row = workspaceSessionRow({
      id: 's7',
      code: 'PA-S0007',
      name: 'Tên',
      role: 'qa',
      status: 'waiting_input',
    });

    expect(row).toMatchObject({
      sessionId: 's7',
      code: 'PA-S0007',
      role: 'qa',
      needsYou: true,
      taskLine: null,
      summary: { text: companyRoleLabel('qa'), age: null },
    });
  });

  it('folds a paused folder session with the parked ones, and keeps a busy one live', () => {
    const paused = workspaceSessionRow({
      id: 's1',
      code: 'PA-S0001',
      name: 'Tên',
      role: 'worker',
      status: 'paused',
    });
    const busy = workspaceSessionRow({
      id: 's2',
      code: 'PA-S0002',
      name: 'Tên',
      role: 'worker',
      status: 'busy',
    });

    expect(isFolded(paused)).toBe(true);
    expect(isFolded(busy)).toBe(false);
  });
});

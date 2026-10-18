import { describe, expect, it } from 'vitest';

import type { HerdrAgent } from '../../core/src/company.js';
import type { CompanyWorkspaceEntry } from '../../core/src/messages.js';
import {
  buildProjectTree,
  buildRailTree,
  COMPANY_PROJECT_NAME,
  PROJECT_TONE_COUNT,
  projectAgentTotal,
  projectCountsText,
  projectTone,
  type RailEntry,
  shortProjectName,
} from '../src/company/agentTree.js';
import {
  type CompanyViewState,
  emptyHerdrView,
  type HerdrView,
} from '../src/company/companyState.js';
import { session, stateFrom } from './companyFixtures.js';

const NOW = Date.parse('2026-05-01T10:30:00.000Z');
const ACTIVE_KEY = 'board:/tmp/workspace';

/** A folder entry as the host lists it. */
function workspace(
  path: string,
  active: boolean,
  working: number,
  waiting: number,
): CompanyWorkspaceEntry {
  return { path, active, open: active, working, waiting };
}

function herdrAgent(overrides: Partial<HerdrAgent>): HerdrAgent {
  return { paneId: 'pane-1', kind: 'claude', status: 'idle', workspaceId: 'ws-1', ...overrides };
}

function herdrLoaded(agents: HerdrAgent[]): HerdrView {
  return { ...emptyHerdrView(), loaded: true, available: true, agents };
}

/** A compact description of each rail entry, so an order can be read at a glance. */
function shape(entries: readonly RailEntry[]): string[] {
  return entries.map((entry) => {
    switch (entry.kind) {
      case 'project':
        return `project ${entry.project.name}`;
      case 'summary':
        return `summary ${entry.project.name}`;
      case 'session':
        return `session ${entry.row.code}`;
      case 'pane':
        return `pane ${entry.row.paneId}`;
      case 'parked':
        return `parked ${entry.count}`;
      case 'break':
        return 'break';
    }
  });
}

describe('buildProjectTree', () => {
  it('lists the active folder first, then each other folder as a project to switch to', () => {
    const state: CompanyViewState = {
      ...stateFrom(),
      workspaces: [workspace('/work/alpha', true, 0, 0), workspace('/work/beta', false, 2, 1)],
    };

    const tree = buildProjectTree(state, NOW, new Set());

    expect(tree.projects.map((project) => project.key)).toEqual([
      'board:/work/alpha',
      'board:/work/beta',
    ]);
    expect(tree.projects[0]).toMatchObject({ name: 'alpha', active: true, switchTo: null });
    expect(tree.projects[1]).toMatchObject({
      name: 'beta',
      active: false,
      switchTo: '/work/beta',
      counts: { working: 2, needs: 1, idle: 0, error: 0 },
    });
  });

  it("groups the active folder's sessions by role, with live counts and one parked count", () => {
    const state = stateFrom({
      sessions: [
        session({ code: 'PA-S0001', role: 'worker', status: 'busy' }),
        session({ code: 'PA-S0002', role: 'worker', status: 'waiting_input' }),
        session({ code: 'PA-S0003', role: 'qa', status: 'idle' }),
        session({ code: 'PA-S0004', role: 'worker', status: 'paused' }),
      ],
    });

    const active = buildProjectTree(state, NOW, new Set()).projects[0];

    expect(active?.groups.filter((group) => group.active.length > 0).map((g) => g.role)).toEqual([
      'worker',
      'qa',
    ]);
    expect(active?.counts).toEqual({ working: 1, needs: 1, idle: 1, error: 0 });
    expect(active?.parkedCount).toBe(1);
    expect(active ? projectAgentTotal(active.counts) : -1).toBe(3);
  });

  it('folds exactly the projects whose keys it is given', () => {
    const state: CompanyViewState = {
      ...stateFrom(),
      workspaces: [workspace('/work/alpha', true, 0, 0), workspace('/work/beta', false, 0, 0)],
    };

    const tree = buildProjectTree(state, NOW, new Set(['board:/work/beta']));

    expect(tree.projects.map((project) => project.collapsed)).toEqual([false, true]);
  });

  it('names the folder by its last path segment, and a board with no folder as the company', () => {
    const named = buildProjectTree(stateFrom(), NOW, new Set()).projects[0];
    expect(named).toMatchObject({ name: 'workspace', key: ACTIVE_KEY, path: '/tmp/workspace' });

    const unnamed = buildProjectTree(
      { ...stateFrom(), settings: null, workspaces: null },
      NOW,
      new Set(),
    ).projects[0];
    expect(unnamed).toMatchObject({ name: COMPANY_PROJECT_NAME, path: null, key: 'board:' });
  });

  it('lists each herdr repo as a project of its own, with its panes and counts', () => {
    const state: CompanyViewState = {
      ...stateFrom(),
      herdr: herdrLoaded([
        herdrAgent({ paneId: 'p1', repo: 'pixel-agents', status: 'idle' }),
        herdrAgent({ paneId: 'p2', repo: 'pixel-agents', status: 'blocked' }),
      ]),
    };

    const repo = buildProjectTree(state, NOW, new Set()).projects.find(
      (project) => project.kind === 'herdr',
    );

    expect(repo).toMatchObject({
      name: 'pixel-agents',
      active: false,
      switchTo: null,
      counts: { working: 0, needs: 1, idle: 1, error: 0 },
    });
    expect(repo?.panes.map((row) => row.paneId)).toEqual(['p2', 'p1']);
  });

  it('lists no herdr project while herdr has not loaded', () => {
    const tree = buildProjectTree(stateFrom(), NOW, new Set());

    expect(tree.projects.some((project) => project.kind === 'herdr')).toBe(false);
  });

  it('keeps a herdr repo folded under its own key', () => {
    const state: CompanyViewState = {
      ...stateFrom(),
      herdr: herdrLoaded([herdrAgent({ paneId: 'p1', repo: 'pixel-agents' })]),
    };
    const repoKey =
      buildProjectTree(state, NOW, new Set()).projects.find((p) => p.kind === 'herdr')?.key ?? '';

    const folded = buildProjectTree(state, NOW, new Set([repoKey])).projects.find(
      (p) => p.kind === 'herdr',
    );
    expect(folded?.collapsed).toBe(true);
  });
});

describe('buildRailTree', () => {
  it('opens each project with its marker, and breaks between projects', () => {
    const state: CompanyViewState = {
      ...stateFrom({ sessions: [session({ code: 'PA-S0001', role: 'worker' })] }),
      herdr: herdrLoaded([herdrAgent({ paneId: 'p1', repo: 'pixel-agents' })]),
    };

    expect(shape(buildRailTree(buildProjectTree(state, NOW, new Set()).projects))).toEqual([
      'project workspace',
      'session PA-S0001',
      'break',
      'project pixel-agents',
      'pane p1',
    ]);
  });

  it('lists the sessions that need the user first, then the rest, then one parked badge', () => {
    const state = stateFrom({
      sessions: [
        session({ code: 'PA-S0001', role: 'worker', status: 'busy' }),
        session({ code: 'PA-S0002', role: 'worker', status: 'waiting_input' }),
        session({ code: 'PA-S0003', role: 'qa', status: 'idle' }),
        session({ code: 'PA-S0004', role: 'worker', status: 'paused' }),
      ],
    });

    expect(shape(buildRailTree(buildProjectTree(state, NOW, new Set()).projects))).toEqual([
      'project workspace',
      'session PA-S0002',
      'session PA-S0001',
      'session PA-S0003',
      'parked 1',
    ]);
  });

  it('shows a folded project as its marker and one summary badge, with no rows', () => {
    const state = stateFrom({ sessions: [session({ code: 'PA-S0001', role: 'worker' })] });
    const projects = buildProjectTree(state, NOW, new Set([ACTIVE_KEY])).projects;

    expect(shape(buildRailTree(projects))).toEqual(['project workspace', 'summary workspace']);
  });

  it('lists the active folder even with no agents, so the rail always has a marker', () => {
    const projects = buildProjectTree(stateFrom(), NOW, new Set()).projects;

    expect(shape(buildRailTree(projects))).toEqual(['project workspace']);
  });

  it('keeps every session in view: each is a badge or counted in the parked badge', () => {
    const state = stateFrom({
      sessions: [
        session({ code: 'PA-S0001', role: 'worker', status: 'busy' }),
        session({ code: 'PA-S0002', role: 'director', status: 'archived' }),
        session({ code: 'PA-S0003', role: 'judge', status: 'crashed' }),
        session({ code: 'PA-S0004', role: 'advisor', status: 'stopped' }),
      ],
    });

    const rail = buildRailTree(buildProjectTree(state, NOW, new Set()).projects);
    const badges = rail.filter((entry) => entry.kind === 'session').length;
    const parked = rail.reduce(
      (sum, entry) => (entry.kind === 'parked' ? sum + entry.count : sum),
      0,
    );

    expect(badges + parked).toBe(Object.keys(state.sessions).length);
  });

  it('tags each session badge with its project key, so a badge can name its project', () => {
    const state = stateFrom({ sessions: [session({ code: 'PA-S0001', role: 'worker' })] });
    const rail = buildRailTree(buildProjectTree(state, NOW, new Set()).projects);

    expect(rail.find((entry) => entry.kind === 'session')).toMatchObject({
      projectKey: ACTIVE_KEY,
    });
  });
});

describe('projectTone', () => {
  it.each(['board:/a', 'board:/b', 'herdr:pixel-agents', 'board:'])(
    'gives %j a stable colour slot inside the palette',
    (key) => {
      const tone = projectTone(key);

      expect(tone).toBeGreaterThanOrEqual(0);
      expect(tone).toBeLessThan(PROJECT_TONE_COUNT);
      expect(projectTone(key)).toBe(tone);
    },
  );
});

describe('projectCountsText', () => {
  it('prints the live counts in order, joined by a dot', () => {
    expect(projectCountsText({ working: 2, needs: 1, idle: 0, error: 0 })).toBe(
      'đang làm 2 · chờ bạn 1',
    );
  });

  it('prints an error count, and an idle count only when nothing else is live', () => {
    expect(projectCountsText({ working: 0, needs: 0, idle: 3, error: 1 })).toBe('lỗi 1');
    expect(projectCountsText({ working: 0, needs: 0, idle: 3, error: 0 })).toBe('rảnh 3');
  });

  it('says so when a project has no agents', () => {
    expect(projectCountsText({ working: 0, needs: 0, idle: 0, error: 0 })).toBe('chưa có agent');
  });
});

describe('shortProjectName', () => {
  it('keeps a name of up to nine characters whole', () => {
    expect(shortProjectName('abcdefghi')).toBe('abcdefghi');
  });

  it('cuts a longer name to eight characters and an ellipsis', () => {
    expect(shortProjectName('abcdefghij')).toBe('abcdefgh…');
  });
});

import { describe, expect, it } from 'vitest';

import type { HerdrAgent } from '../../core/src/company.js';
import type { HerdrSleepingSession } from '../../core/src/messages.js';
import { sleepingMenuItems } from '../src/company/agentMenu.js';
import {
  activityCounts,
  type HerdrGroup,
  herdrGroup,
  type HerdrRepoGroup,
  herdrRowCount,
  sleepingName,
  sleepingRowFor,
  sleepingRows,
  sleepingTooltip,
  sleptLabelOf,
} from '../src/company/agentSidebarView.js';
import { buildProjectTree, buildRailTree } from '../src/company/agentTree.js';
import { herdrWake } from '../src/company/companyMessages.js';
import {
  applyCompanyMessage,
  type CompanyViewState,
  emptyCompanyState,
  emptyHerdrView,
  type HerdrView,
} from '../src/company/companyState.js';
import { isLaneCollapsed } from '../src/company/laneLayout.js';
import { drawerSubjectKey } from '../src/company/selection.js';
import { previewTargetOfSubject } from '../src/company/terminalPreview.js';
import { stateFrom } from './companyFixtures.js';

/** A fixed clock: the view never reads the real one. */
const NOW = Date.parse('2026-05-01T10:30:00.000Z');
/** Five minutes before NOW, so the label reads "ngủ từ 5 phút trước". */
const SLEPT_AT = '2026-05-01T10:25:00.000Z';

function herdrAgent(overrides: Partial<HerdrAgent>): HerdrAgent {
  return {
    paneId: 'pane-1',
    kind: 'claude',
    status: 'idle',
    workspaceId: 'ws-1',
    ...overrides,
  };
}

function sleeping(
  overrides: Pick<HerdrSleepingSession, 'paneId'> & Partial<HerdrSleepingSession>,
): HerdrSleepingSession {
  return {
    title: '',
    sessionFile: `/sessions/${overrides.paneId}.jsonl`,
    sleptAt: SLEPT_AT,
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

describe('sleeping sessions in the herdr group', () => {
  it('files a sleeping session under its live repo, after the live agents', () => {
    const group = herdrGroup(
      herdrView({
        agents: [herdrAgent({ paneId: 'a', repo: 'pixel-agents', status: 'working' })],
        sleeping: [sleeping({ paneId: 's1', repo: 'pixel-agents' })],
      }),
      NOW,
    );

    const [repo] = readyRepos(group);
    expect(repo?.key).toBe('repo:pixel-agents');
    expect(repo?.rows.map((row) => row.paneId)).toEqual(['a']);
    expect(repo?.sleeping.map((row) => row.paneId)).toEqual(['s1']);
  });

  it('gives a sleeping-only repository its own group, after the live ones', () => {
    const group = herdrGroup(
      herdrView({
        agents: [herdrAgent({ paneId: 'a', repo: 'pixel-agents' })],
        sleeping: [
          sleeping({ paneId: 's1', repo: 'omp' }),
          sleeping({ paneId: 's2', repo: 'pixel-agents' }),
        ],
      }),
      NOW,
    );

    const repos = readyRepos(group);
    expect(repos.map((repo) => repo.key)).toEqual(['repo:pixel-agents', 'repo:omp']);
    expect(repos[1]?.rows).toEqual([]);
    expect(repos[1]?.sleeping.map((row) => row.paneId)).toEqual(['s1']);
  });

  it('lists sleeping rows most recently slept first, across every repo', () => {
    const group = herdrGroup(
      herdrView({
        sleeping: [
          sleeping({ paneId: 's1', repo: 'omp', sleptAt: '2026-05-01T10:00:00.000Z' }),
          sleeping({ paneId: 's2', repo: 'omp', sleptAt: '2026-05-01T10:20:00.000Z' }),
          sleeping({ paneId: 's3', sleptAt: '2026-05-01T10:10:00.000Z' }),
        ],
      }),
      NOW,
    );

    expect(sleepingRows(group).map((row) => row.paneId)).toEqual(['s2', 's3', 's1']);
  });

  it('keeps sleeping sessions out of the live counts', () => {
    const group = herdrGroup(
      herdrView({
        agents: [herdrAgent({ paneId: 'a', repo: 'pixel-agents', status: 'working' })],
        sleeping: [sleeping({ paneId: 's1', repo: 'pixel-agents' })],
      }),
      NOW,
    );

    expect(herdrRowCount(group)).toBe(1);
    expect(activityCounts([], group)).toEqual({ working: 1, needs: 0, idle: 0, error: 0 });
  });

  it('has no sleeping rows until herdr has answered, or when herdr is unavailable', () => {
    expect(sleepingRows(herdrGroup(emptyHerdrView(), NOW))).toEqual([]);
    expect(sleepingRows(herdrGroup(herdrView({ available: false }), NOW))).toEqual([]);
  });
});

describe('sleeping row text', () => {
  it('reads the time since a session slept, or that it just did', () => {
    expect(sleptLabelOf(SLEPT_AT, NOW)).toBe('ngủ từ 5 phút trước');
    expect(sleptLabelOf(new Date(NOW - 10_000).toISOString(), NOW)).toBe('ngủ vừa xong');
    expect(sleptLabelOf('not a time', NOW)).toBeNull();
  });

  it('names a session by its title, else by its pane', () => {
    expect(sleepingName(sleeping({ paneId: 'p9', title: 'Fix login' }))).toBe('Fix login');
    expect(sleepingName(sleeping({ paneId: 'p9', title: '' }))).toBe('p9');
  });

  it('builds a row with its name, repo, and the tooltip that names its session file', () => {
    const row = sleepingRowFor(
      sleeping({ paneId: 's1', title: 'Refactor', repo: 'omp', branch: 'feat/x' }),
      NOW,
    );

    expect(row).toMatchObject({
      paneId: 's1',
      name: 'Refactor',
      sleptLabel: 'ngủ từ 5 phút trước',
      branch: 'feat/x',
      repo: { key: 'repo:omp', label: 'omp', source: 'repo' },
    });
    expect(sleepingTooltip(row)).toContain('Refactor');
    expect(sleepingTooltip(row)).toContain('/sessions/s1.jsonl');
  });
});

describe('sleeping sessions in the sidebar tree and rail', () => {
  it('lists a repo’s sleeping sessions after its panes, in the tree and the rail', () => {
    const state: CompanyViewState = {
      ...stateFrom(),
      herdr: herdrView({
        agents: [herdrAgent({ paneId: 'a', repo: 'pixel-agents' })],
        sleeping: [sleeping({ paneId: 's1', repo: 'pixel-agents' })],
      }),
    };

    const tree = buildProjectTree(state, NOW, new Set());
    const repos = tree.projects.flatMap((project) => (project.kind === 'herdr' ? [project] : []));
    expect(repos[0]?.panes.map((row) => row.paneId)).toEqual(['a']);
    expect(repos[0]?.sleeping.map((row) => row.paneId)).toEqual(['s1']);

    const railEntries = buildRailTree(tree.projects).flatMap((entry) => {
      if (entry.kind !== 'pane' && entry.kind !== 'sleeping') return [];
      return [`${entry.kind}:${entry.row.paneId}`];
    });
    expect(railEntries).toEqual(['pane:a', 'sleeping:s1']);
  });
});

describe('herdrAgents reducer and sleeping sessions', () => {
  it('starts with no sleeping sessions', () => {
    expect(emptyHerdrView().sleeping).toEqual([]);
  });

  it('stores the sessions the server sends, and replaces them on the next answer', () => {
    const first = applyCompanyMessage(emptyCompanyState(), {
      type: 'herdrAgents',
      available: true,
      agents: [],
      sleeping: [sleeping({ paneId: 's1' })],
    }).state;
    expect(first.herdr.sleeping.map((session) => session.paneId)).toEqual(['s1']);

    const next = applyCompanyMessage(first, {
      type: 'herdrAgents',
      available: true,
      agents: [],
      sleeping: [],
    }).state;
    expect(next.herdr.sleeping).toEqual([]);
  });
});

describe('sleeping subjects', () => {
  it('keys a sleeping drawer apart from a live herdr pane with the same id', () => {
    expect(drawerSubjectKey({ kind: 'sleeping', paneId: 'p1' })).toBe('sleeping:p1');
    expect(drawerSubjectKey({ kind: 'herdr', paneId: 'p1' })).toBe('herdr:p1');
  });

  it('previews a sleeping pane through the herdr preview target', () => {
    expect(previewTargetOfSubject({ kind: 'sleeping', paneId: 'p1' })).toStrictEqual({
      kind: 'herdr',
      paneId: 'p1',
    });
  });

  it('offers waking first, and nothing that acts on a live pane', () => {
    const ids = sleepingMenuItems(null).map((entry) => entry.id);
    expect(ids[0]).toBe('wake');
    expect(ids).not.toContain('rename');
    expect(ids).not.toContain('info');
  });
});

describe('herdrWake', () => {
  it('sends the prompt only when the user typed something, trimmed', () => {
    expect(herdrWake('r1', 'p1')).toStrictEqual({
      type: 'herdrWake',
      requestId: 'r1',
      paneId: 'p1',
    });
    expect(herdrWake('r1', 'p1', '   ')).toStrictEqual({
      type: 'herdrWake',
      requestId: 'r1',
      paneId: 'p1',
    });
    expect(herdrWake('r1', 'p1', '  dọn dẹp  ')).toStrictEqual({
      type: 'herdrWake',
      requestId: 'r1',
      paneId: 'p1',
      prompt: 'dọn dẹp',
    });
  });
});

describe('the sleeping lane', () => {
  it('folds to a strip while it holds nothing and is not open, like any empty lane', () => {
    expect(isLaneCollapsed(0, false)).toBe(true);
    expect(isLaneCollapsed(1, false)).toBe(false);
  });
});

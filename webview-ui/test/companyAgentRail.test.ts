import { describe, expect, it } from 'vitest';

import type { HerdrAgent } from '../../core/src/company.js';
import {
  buildAgentGroups,
  buildRail,
  type HerdrGroup,
  herdrGroup,
  paneShortCode,
  type RailEntry,
  repoTag,
  sessionShortCode,
} from '../src/company/agentSidebarView.js';
import { emptyHerdrView, type HerdrView } from '../src/company/companyState.js';
import { session, stateFrom } from './companyFixtures.js';

const NOW = Date.parse('2026-05-01T10:30:00.000Z');
const NO_HERDR: HerdrGroup = { kind: 'hidden' };

/** A compact description of each rail entry, so an order can be read at a glance. */
function shape(entries: readonly RailEntry[]): string[] {
  return entries.map((entry) => {
    switch (entry.kind) {
      case 'session':
        return `session ${entry.row.code}`;
      case 'pane':
        return `pane ${entry.row.paneId}`;
      case 'repo':
        return `repo ${entry.tag}`;
      case 'parked':
        return `parked ${entry.count}`;
      case 'break':
        return 'break';
    }
  });
}

function herdrAgent(overrides: Partial<HerdrAgent>): HerdrAgent {
  return { paneId: 'pane-1', kind: 'claude', status: 'idle', workspaceId: 'ws-1', ...overrides };
}

function herdrReady(agents: HerdrAgent[]): HerdrGroup {
  return herdrGroup({
    ...emptyHerdrView(),
    loaded: true,
    available: true,
    agents,
  } satisfies HerdrView);
}

describe('buildRail', () => {
  it('shows nothing for an empty company and a hidden herdr', () => {
    expect(buildRail(buildAgentGroups(stateFrom(), NOW), NO_HERDR)).toEqual([]);
  });

  it('lists sessions that need the user first, then each role, with breaks between blocks and one parked badge', () => {
    const state = stateFrom({
      sessions: [
        session({ code: 'PA-S0001', role: 'worker', status: 'busy' }),
        session({ code: 'PA-S0002', role: 'worker', status: 'waiting_input' }),
        session({ code: 'PA-S0003', role: 'qa', status: 'idle' }),
        session({ code: 'PA-S0004', role: 'worker', status: 'paused' }),
      ],
    });

    const rail = buildRail(buildAgentGroups(state, NOW), NO_HERDR);

    expect(shape(rail)).toEqual([
      'session PA-S0002',
      'break',
      'session PA-S0001',
      'break',
      'session PA-S0003',
      'break',
      'parked 1',
    ]);
  });

  it('keeps every session in view: each is a rail badge or counted in the parked badge', () => {
    const state = stateFrom({
      sessions: [
        session({ code: 'PA-S0001', role: 'worker', status: 'busy' }),
        session({ code: 'PA-S0002', role: 'director', status: 'archived' }),
        session({ code: 'PA-S0003', role: 'judge', status: 'crashed' }),
        session({ code: 'PA-S0004', role: 'advisor', status: 'stopped' }),
      ],
    });

    const rail = buildRail(buildAgentGroups(state, NOW), NO_HERDR);
    const badges = rail.filter((entry) => entry.kind === 'session').length;
    const parked = rail.reduce(
      (sum, entry) => (entry.kind === 'parked' ? sum + entry.count : sum),
      0,
    );

    expect(badges + parked).toBe(Object.keys(state.sessions).length);
  });

  it('opens each herdr repo with its tag, its panes under it, and a break before the block', () => {
    const herdr = herdrReady([
      herdrAgent({ paneId: 'p1', repo: 'pixel-agents', status: 'idle' }),
      herdrAgent({ paneId: 'p2', repo: 'pixel-agents', status: 'blocked' }),
    ]);

    expect(shape(buildRail([], herdr))).toEqual(['repo PA', 'pane p2', 'pane p1']);

    const state = stateFrom({ sessions: [session({ code: 'PA-S0001', role: 'worker' })] });
    expect(shape(buildRail(buildAgentGroups(state, NOW), herdr))).toEqual([
      'session PA-S0001',
      'break',
      'repo PA',
      'pane p2',
      'pane p1',
    ]);
  });
});

describe('sessionShortCode', () => {
  it('reads a session code as its letter and its number, without padding', () => {
    expect(sessionShortCode('PA-S0002')).toBe('S2');
    expect(sessionShortCode('PA-S0010')).toBe('S10');
    expect(sessionShortCode('PA-S0000')).toBe('S0');
  });

  it('falls back to the first characters of a code with no number', () => {
    expect(sessionShortCode('ALPHABET')).toBe('ALPH');
  });
});

describe('paneShortCode', () => {
  it('reads a pane as its number', () => {
    expect(paneShortCode('pane-3')).toBe('3');
    expect(paneShortCode('w1-p012')).toBe('12');
  });

  it('falls back to the first characters of a pane id with no number', () => {
    expect(paneShortCode('abcdef')).toBe('abcd');
  });
});

describe('repoTag', () => {
  it('takes the initials of a name split on dashes or underscores', () => {
    expect(repoTag('pixel-agents')).toBe('PA');
    expect(repoTag('Project_QuanLyGiaiDau')).toBe('PQ');
    expect(repoTag('a - b')).toBe('AB');
  });

  it('takes the first two letters of a one-word name, and a dot for an empty one', () => {
    expect(repoTag('omp')).toBe('OM');
    expect(repoTag('')).toBe('·');
  });
});

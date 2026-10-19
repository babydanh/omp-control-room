import { describe, expect, it } from 'vitest';

import type {
  CompanySessionSummary,
  HerdrAgent,
  HerdrSleepingSession,
} from '../../core/src/messages.js';
import {
  assigneeKeyOf,
  assigneeOptionsFor,
  NEW_SESSION_LABEL,
  sessionAcceptsWork,
} from '../src/company/assigneeOptions.js';
import { applyCompanyMessage, type CompanyViewState } from '../src/company/companyState.js';
import { session, snapshot, stateFrom } from './companyFixtures.js';

const ACTIVE = '/work/app';
const OTHER = '/work/site';

function herdrAgent(overrides: Pick<HerdrAgent, 'paneId'> & Partial<HerdrAgent>): HerdrAgent {
  return { kind: 'claude', status: 'idle', workspaceId: 'ws-1', ...overrides };
}

function sleeping(paneId: string, workspacePath: string): HerdrSleepingSession {
  return {
    paneId,
    title: '',
    sessionFile: `/sessions/${paneId}.jsonl`,
    sleptAt: '2026-05-01T10:25:00.000Z',
    workspacePath,
  };
}

/** The state with the server's herdr roster replaced by `agents` and `sleepingSessions`. */
function withRoster(
  state: CompanyViewState,
  agents: HerdrAgent[],
  sleepingSessions: HerdrSleepingSession[] = [],
): CompanyViewState {
  return applyCompanyMessage(state, {
    type: 'herdrAgents',
    available: true,
    agents,
    sleeping: sleepingSessions,
  }).state;
}

/** A board: `ACTIVE` holds `activeSessions` and `OTHER` holds `otherSessions`. */
function boardWith(
  activeSessions: CompanySessionSummary[],
  otherSessions: CompanySessionSummary[] = [],
): CompanyViewState {
  const active = stateFrom({ sessions: activeSessions }, ACTIVE);
  return applyCompanyMessage(active, {
    type: 'companySnapshot',
    requestId: 'snap-other',
    snapshot: snapshot({ sessions: otherSessions }),
    workspacePath: OTHER,
  }).state;
}

describe('assigneeOptionsFor: herdr agents', () => {
  it('lists only the herdr agents the server tags with the folder', () => {
    const state = withRoster(stateFrom({}, ACTIVE), [
      herdrAgent({ paneId: 'in', workspacePath: ACTIVE }),
      herdrAgent({ paneId: 'out', workspacePath: OTHER }),
      herdrAgent({ paneId: 'loose' }),
    ]);

    expect(assigneeOptionsFor(state, ACTIVE).map((option) => option.key)).toEqual([
      'herdr:in',
      'new-session',
    ]);
  });

  it('labels a herdr agent by its name, then its title, then its pane id', () => {
    const state = withRoster(stateFrom({}, ACTIVE), [
      herdrAgent({ paneId: 'p1', name: 'Dev', workspacePath: ACTIVE }),
      herdrAgent({ paneId: 'p2', title: 'Build', workspacePath: ACTIVE }),
      herdrAgent({ paneId: 'p3', workspacePath: ACTIVE }),
    ]);

    expect(assigneeOptionsFor(state, ACTIVE).map((option) => option.label)).toEqual([
      'Dev',
      'Build',
      'p3',
      NEW_SESSION_LABEL,
    ]);
  });

  it('details a herdr agent with its repo and branch, else its repo, else its folder', () => {
    const state = withRoster(stateFrom({}, ACTIVE), [
      herdrAgent({ paneId: 'p1', repo: 'app', branch: 'main', workspacePath: ACTIVE }),
      herdrAgent({ paneId: 'p2', repo: 'app', workspacePath: ACTIVE }),
      herdrAgent({ paneId: 'p3', cwd: ACTIVE, workspacePath: ACTIVE }),
    ]);

    expect(assigneeOptionsFor(state, ACTIVE).map((option) => option.detail)).toEqual([
      'app · main',
      'app',
      ACTIVE,
      undefined,
    ]);
  });

  it('offers no herdr agent that is only sleeping', () => {
    const state = withRoster(stateFrom({}, ACTIVE), [], [sleeping('z', ACTIVE)]);

    expect(assigneeOptionsFor(state, ACTIVE).map((option) => option.key)).toEqual(['new-session']);
  });
});

describe('assigneeOptionsFor: omp sessions', () => {
  it('lists the sessions of the folder that take work by code, after the herdr agents', () => {
    const state = withRoster(
      stateFrom(
        {
          sessions: [
            session({ id: 's2', code: 'PA-S0002', name: 'Beta', status: 'idle' }),
            session({ id: 's1', code: 'PA-S0001', name: '', status: 'parked' }),
          ],
        },
        ACTIVE,
      ),
      [herdrAgent({ paneId: 'p1', workspacePath: ACTIVE })],
    );

    const options = assigneeOptionsFor(state, ACTIVE);

    expect(options.map((option) => option.key)).toEqual([
      'herdr:p1',
      'session:s1',
      'session:s2',
      'new-session',
    ]);
    expect(options.map((option) => option.label)).toEqual([
      'p1',
      'PA-S0001',
      'Beta',
      NEW_SESSION_LABEL,
    ]);
    expect(options.map((option) => option.detail)).toEqual([
      undefined,
      'PA-S0001',
      'PA-S0002',
      undefined,
    ]);
    expect(options.map((option) => option.group)).toEqual(['herdr', 'session', 'session', 'new']);
  });

  it.each(['archived', 'stopped', 'crashed'])('omits a %s session', (status) => {
    const state = stateFrom({ sessions: [session({ id: 's1', status })] }, ACTIVE);

    expect(assigneeOptionsFor(state, ACTIVE).map((option) => option.key)).toEqual(['new-session']);
  });

  it('lists only the sessions of the folder asked about', () => {
    const state = boardWith(
      [session({ id: 'mine', code: 'PA-S0001' })],
      [session({ id: 'theirs', code: 'PA-S0002' })],
    );

    expect(assigneeOptionsFor(state, ACTIVE).map((option) => option.key)).toEqual([
      'session:mine',
      'new-session',
    ]);
    expect(assigneeOptionsFor(state, OTHER).map((option) => option.key)).toEqual([
      'session:theirs',
      'new-session',
    ]);
  });
});

describe('assigneeOptionsFor: the new-session option', () => {
  it('is the only option in a folder with no herdr agents or sessions', () => {
    expect(assigneeOptionsFor(stateFrom({}, ACTIVE), ACTIVE)).toEqual([
      {
        key: 'new-session',
        assignee: { kind: 'new-session' },
        label: NEW_SESSION_LABEL,
        group: 'new',
      },
    ]);
  });
});

describe('assignee keys and session acceptance', () => {
  it('keys each assignee by its kind and id', () => {
    expect(assigneeKeyOf({ kind: 'herdr', paneId: 'wD:p5' })).toBe('herdr:wD:p5');
    expect(assigneeKeyOf({ kind: 'session', sessionId: 'abc' })).toBe('session:abc');
    expect(assigneeKeyOf({ kind: 'new-session' })).toBe('new-session');
  });

  it.each(['busy', 'idle', 'parked', 'paused'])('accepts work in a %s session', (status) => {
    expect(sessionAcceptsWork(status)).toBe(true);
  });

  it.each(['archived', 'stopped', 'crashed'])('refuses work in a %s session', (status) => {
    expect(sessionAcceptsWork(status)).toBe(false);
  });
});

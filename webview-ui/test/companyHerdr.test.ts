import { describe, expect, it } from 'vitest';

import type { HerdrAgent } from '../../core/src/company.js';
import type { ServerMessage } from '../../core/src/messages.js';
import {
  herdrFocus,
  herdrKeys,
  herdrPrompt,
  herdrRead,
  herdrWatch,
  sessionLogRequest,
} from '../src/company/companyMessages.js';
import { applyCompanyMessage, emptyCompanyState } from '../src/company/companyState.js';
import { HERDR_CHOICE_KEYS, HERDR_TONE_LABELS, herdrToneFor } from '../src/company/herdrView.js';

function herdrAgent(overrides: Partial<HerdrAgent> = {}): HerdrAgent {
  return {
    paneId: 'pane-1',
    kind: 'claude',
    status: 'working',
    workspaceId: 'ws-1',
    name: 'claude-1',
    ...overrides,
  };
}

describe('herdr reducer', () => {
  it('records the agents and whether herdr answered', () => {
    const agent = herdrAgent();
    const result = applyCompanyMessage(emptyCompanyState(), {
      type: 'herdrAgents',
      available: true,
      agents: [agent],
      sleeping: [],
    } satisfies ServerMessage);

    expect(result.state.herdr).toMatchObject({
      loaded: true,
      available: true,
      reason: null,
      agents: [agent],
    });
  });

  it('keeps the reason herdr gave for being unavailable', () => {
    const result = applyCompanyMessage(emptyCompanyState(), {
      type: 'herdrAgents',
      available: false,
      reason: 'socket missing',
      agents: [],
      sleeping: [],
    } satisfies ServerMessage);

    expect(result.state.herdr).toMatchObject({ available: false, reason: 'socket missing' });
  });

  it('keeps the newer screen for a pane and drops a late, older reply', () => {
    const fresh = applyCompanyMessage(emptyCompanyState(), {
      type: 'herdrScreen',
      paneId: 'pane-1',
      text: 'new',
      at: '2026-10-02T10:00:05.000Z',
    } satisfies ServerMessage).state;

    const late = applyCompanyMessage(fresh, {
      type: 'herdrScreen',
      paneId: 'pane-1',
      text: 'old',
      at: '2026-10-02T10:00:01.000Z',
    } satisfies ServerMessage).state;

    expect(late.herdr.screens['pane-1']?.text).toBe('new');

    const newer = applyCompanyMessage(late, {
      type: 'herdrScreen',
      paneId: 'pane-1',
      text: 'newer',
      at: '2026-10-02T10:00:09.000Z',
    } satisfies ServerMessage).state;
    expect(newer.herdr.screens['pane-1']?.text).toBe('newer');
  });

  it('holds one screen per pane', () => {
    const one = applyCompanyMessage(emptyCompanyState(), {
      type: 'herdrScreen',
      paneId: 'pane-1',
      text: 'first',
      at: '2026-10-02T10:00:05.000Z',
    } satisfies ServerMessage).state;
    const two = applyCompanyMessage(one, {
      type: 'herdrScreen',
      paneId: 'pane-2',
      text: 'second',
      at: '2026-10-02T10:00:05.000Z',
    } satisfies ServerMessage).state;

    expect(two.herdr.screens['pane-1']?.text).toBe('first');
    expect(two.herdr.screens['pane-2']?.text).toBe('second');
  });
});

describe('herdr tones and choice keys', () => {
  it('maps every herdr status to one board tone, with the blocked agent needing the user', () => {
    expect(herdrToneFor('working')).toBe('working');
    expect(herdrToneFor('blocked')).toBe('needs');
    expect(herdrToneFor('idle')).toBe('idle');
    expect(herdrToneFor('done')).toBe('done');
    expect(herdrToneFor('unknown')).toBe('unknown');
    expect(HERDR_TONE_LABELS.needs).toBe('chờ bạn');
  });

  it('offers the choice keys a waiting agent can take, in the order the drawer shows them', () => {
    expect(HERDR_CHOICE_KEYS.map((choice) => choice.key)).toEqual([
      'up',
      'down',
      'enter',
      'esc',
      'ctrl+c',
    ]);
  });
});

describe('outgoing herdr and session log messages', () => {
  it('builds the request shapes the server validates', () => {
    expect(herdrRead('r1', 'pane-1', 40)).toEqual({
      type: 'herdrRead',
      requestId: 'r1',
      paneId: 'pane-1',
      lines: 40,
    });
    expect(herdrPrompt('r2', 'pane-1', 'hello')).toEqual({
      type: 'herdrPrompt',
      requestId: 'r2',
      paneId: 'pane-1',
      text: 'hello',
    });
    expect(herdrKeys('r3', 'pane-1', ['up', 'enter'])).toEqual({
      type: 'herdrKeys',
      requestId: 'r3',
      paneId: 'pane-1',
      keys: ['up', 'enter'],
    });
    expect(herdrFocus('r4', 'pane-1')).toEqual({
      type: 'herdrFocus',
      requestId: 'r4',
      paneId: 'pane-1',
    });
    expect(herdrWatch('r6', 'pane-1', true)).toEqual({
      type: 'herdrWatch',
      requestId: 'r6',
      paneId: 'pane-1',
      watching: true,
    });
    expect(sessionLogRequest('r5', 'session-1')).toEqual({
      type: 'companySessionLogRequest',
      requestId: 'r5',
      sessionId: 'session-1',
    });
  });
});

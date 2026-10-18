import { describe, expect, it } from 'vitest';

import type { HerdrAgent } from '../../core/src/company.js';
import type { HerdrSleepingSession } from '../../core/src/messages.js';
import type { CommandResultView } from '../src/company/commandResults.js';
import type { CompanyCommandHandle } from '../src/company/companyClient.js';
import { chatRoute } from '../src/company/composerRouting.js';
import type { PromptRoute } from '../src/company/promptSubmission.js';
import {
  draftAfterSend,
  herdrAgentFor,
  previewInputOf,
  type PromptSender,
  type PromptView,
  SEND_FAILED_FALLBACK,
  sendPrompt,
  sendStatus,
  type SentLine,
  SLEEPING_REASON,
  UNPRIVILEGED_REASON,
} from '../src/company/promptTargets.js';

const AGENT: HerdrAgent = { paneId: 'pane-a', kind: 'omp', status: 'idle', workspaceId: 'ws-1' };
const BLOCKED_AGENT: HerdrAgent = { ...AGENT, paneId: 'pane-b', status: 'blocked' };
const SLEEPER: HerdrSleepingSession = {
  paneId: 'pane-s',
  title: 'Phiên ngủ',
  sessionFile: 'session.jsonl',
  sleptAt: '2025-01-01T00:00:00.000Z',
};
const BUSY_SESSION = { id: 'sess-b', role: 'worker', status: 'busy' } as const;
const STOPPED_SESSION = { id: 'sess-s', role: 'worker', status: 'stopped' } as const;

function viewOf(overrides: Partial<PromptView> = {}): PromptView {
  return {
    herdrAgents: [AGENT, BLOCKED_AGENT],
    herdrSleeping: [SLEEPER],
    sessions: {
      [BUSY_SESSION.id]: BUSY_SESSION,
      [STOPPED_SESSION.id]: STOPPED_SESSION,
    },
    privileged: true,
    ...overrides,
  };
}

type Recorded =
  | { kind: 'herdr'; paneId: string; text: string }
  | { kind: 'session'; route: PromptRoute; text: string };

/** A sender that records every send and accepts it. */
function recordingSender(): { client: PromptSender; calls: Recorded[] } {
  const calls: Recorded[] = [];
  return {
    client: {
      herdrPrompt: (paneId, text) => {
        calls.push({ kind: 'herdr', paneId, text });
        return { ok: true, requestId: `herdr-${calls.length}` };
      },
      sendSessionPrompt: (route, text) => {
        calls.push({ kind: 'session', route, text });
        return { ok: true, requestId: `session-${calls.length}` };
      },
    },
    calls,
  };
}

describe('herdrAgentFor', () => {
  it('finds the agent for a pane, and nothing when no pane is chosen or the agent is gone', () => {
    expect(herdrAgentFor('pane-a', [AGENT, BLOCKED_AGENT])).toBe(AGENT);
    expect(herdrAgentFor(null, [AGENT])).toBeNull();
    expect(herdrAgentFor('pane-gone', [AGENT])).toBeNull();
  });
});

describe('previewInputOf', () => {
  it('gives a live herdr agent a ready input, with the keys row only when it is blocked', () => {
    expect(previewInputOf({ kind: 'herdr', paneId: 'pane-a' }, viewOf())).toStrictEqual({
      kind: 'ready',
      target: { kind: 'herdr', paneId: 'pane-a' },
      choices: false,
    });
    expect(previewInputOf({ kind: 'herdr', paneId: 'pane-b' }, viewOf())).toStrictEqual({
      kind: 'ready',
      target: { kind: 'herdr', paneId: 'pane-b' },
      choices: true,
    });
  });

  it('offers a sleeping herdr pane only the wake, with the reason', () => {
    expect(previewInputOf({ kind: 'herdr', paneId: 'pane-s' }, viewOf())).toStrictEqual({
      kind: 'off',
      reason: SLEEPING_REASON,
      wakePane: 'pane-s',
    });
  });

  it('shows no input for a herdr pane that is neither live nor sleeping', () => {
    expect(previewInputOf({ kind: 'herdr', paneId: 'pane-gone' }, viewOf())).toStrictEqual({
      kind: 'none',
    });
  });

  it('gives a live session a ready input routed as chat', () => {
    expect(previewInputOf({ kind: 'session', sessionId: 'sess-b' }, viewOf())).toStrictEqual({
      kind: 'ready',
      target: { kind: 'session', route: chatRoute(BUSY_SESSION) },
      choices: false,
    });
  });

  it('shows no input for a session with no attachable terminal, or an unknown one', () => {
    expect(previewInputOf({ kind: 'session', sessionId: 'sess-s' }, viewOf())).toStrictEqual({
      kind: 'none',
    });
    expect(previewInputOf({ kind: 'session', sessionId: 'sess-x' }, viewOf())).toStrictEqual({
      kind: 'none',
    });
  });

  it('disables every input on an unprivileged connection, with the reason', () => {
    const unprivileged = viewOf({ privileged: false });
    const disabled = { kind: 'off', reason: UNPRIVILEGED_REASON, wakePane: null };
    expect(previewInputOf({ kind: 'herdr', paneId: 'pane-a' }, unprivileged)).toStrictEqual(
      disabled,
    );
    expect(previewInputOf({ kind: 'herdr', paneId: 'pane-s' }, unprivileged)).toStrictEqual(
      disabled,
    );
    expect(previewInputOf({ kind: 'session', sessionId: 'sess-b' }, unprivileged)).toStrictEqual(
      disabled,
    );
  });
});

describe('sendPrompt', () => {
  it('sends the trimmed line to a herdr pane through herdrPrompt', () => {
    const { client, calls } = recordingSender();
    const handle = sendPrompt(client, { kind: 'herdr', paneId: 'pane-a' }, '  chạy tests  ');
    expect(handle).toStrictEqual({ ok: true, requestId: 'herdr-1' });
    expect(calls).toStrictEqual([{ kind: 'herdr', paneId: 'pane-a', text: 'chạy tests' }]);
  });

  it('sends to a session through sendSessionPrompt, with the route it was given', () => {
    const { client, calls } = recordingSender();
    const route = chatRoute(BUSY_SESSION);
    sendPrompt(client, { kind: 'session', route }, 'tiếp tục');
    expect(calls).toStrictEqual([{ kind: 'session', route, text: 'tiếp tục' }]);
  });

  it('sends nothing for a blank line', () => {
    const { client, calls } = recordingSender();
    expect(sendPrompt(client, { kind: 'herdr', paneId: 'pane-a' }, '   ')).toBeNull();
    expect(calls).toStrictEqual([]);
  });
});

describe('sendStatus', () => {
  const line = (handle: CompanyCommandHandle): SentLine => ({ text: 'hi', handle });

  it('reports a refused send at once, with the server message', () => {
    const refused: CompanyCommandHandle = {
      ok: false,
      requestId: 'r-1',
      errorCode: 'forbidden',
      message: 'Không đủ quyền.',
    };
    expect(sendStatus(line(refused), {})).toStrictEqual({
      kind: 'failed',
      message: 'Không đủ quyền.',
    });
  });

  it('falls back to the error code, then to a generic line, when a refusal has no message', () => {
    expect(
      sendStatus(line({ ok: false, requestId: 'r-2', errorCode: 'forbidden' }), {}),
    ).toStrictEqual({ kind: 'failed', message: 'forbidden' });
    expect(sendStatus(line({ ok: false, requestId: 'r-3' }), {})).toStrictEqual({
      kind: 'failed',
      message: SEND_FAILED_FALLBACK,
    });
  });

  it('is sending until the server answers the request', () => {
    expect(sendStatus(line({ ok: true, requestId: 'r-4' }), {})).toStrictEqual({
      kind: 'sending',
    });
  });

  it('is sent once the verdict is ok', () => {
    const results: Record<string, CommandResultView> = {
      'r-4': { requestId: 'r-4', ok: true },
    };
    expect(sendStatus(line({ ok: true, requestId: 'r-4' }), results)).toStrictEqual({
      kind: 'sent',
    });
  });

  it('is failed with the verdict message when the server refuses', () => {
    const results: Record<string, CommandResultView> = {
      'r-5': { requestId: 'r-5', ok: false, message: 'Agent đang bận.' },
    };
    expect(sendStatus(line({ ok: true, requestId: 'r-5' }), results)).toStrictEqual({
      kind: 'failed',
      message: 'Agent đang bận.',
    });
  });
});

describe('draftAfterSend', () => {
  it('clears the draft while it still holds the sent text', () => {
    expect(draftAfterSend('chạy tests', 'chạy tests')).toBe('');
    expect(draftAfterSend('chạy tests ', 'chạy tests')).toBe('');
  });

  it('keeps text typed after the send', () => {
    expect(draftAfterSend('chạy tests và lint', 'chạy tests')).toBe('chạy tests và lint');
  });
});

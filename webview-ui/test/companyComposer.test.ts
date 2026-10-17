import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { TRANSPORT_DISCONNECTED_ERROR } from '../../core/src/messageDelivery.js';
import type { ClientMessage } from '../../core/src/messages.js';
import { CompanyClient } from '../src/company/companyClient.js';
import { isSubmitChord } from '../src/company/promptSubmission.js';
import type { MessageTransport } from '../src/transport/types.js';
import { session, settings, snapshot, task } from './companyFixtures.js';

interface FakeTransport {
  transport: MessageTransport;
  sent: ClientMessage[];
  setConnected(connected: boolean): void;
}

function fakeTransport(): FakeTransport {
  const sent: ClientMessage[] = [];
  let connected = true;
  return {
    sent,
    setConnected(value: boolean) {
      connected = value;
    },
    transport: {
      send(message: ClientMessage) {
        if (!connected) throw new Error(TRANSPORT_DISCONNECTED_ERROR);
        sent.push(message);
      },
      onMessage: () => () => {},
      ready: Promise.resolve(),
      state: 'connected',
      onStateChange: () => () => {},
      dispose: () => {},
    } as MessageTransport,
  };
}

/** A client that has already applied a snapshot, as the app's does on connect. */
function connectedClient() {
  const fake = fakeTransport();
  const client = new CompanyClient(fake.transport);
  client.accept({
    type: 'companySnapshot',
    requestId: randomUUID(),
    snapshot: snapshot({
      revision: 1,
      settings: settings({
        roleProfiles: {
          worker: {
            role: 'worker',
            requestedModel: 'openai-codex/gpt-6-luna:xhigh',
            thinking: 'xhigh',
            workflowFingerprint: 'fp',
            toolsPolicy: 'scoped-write',
          },
        },
      }),
    }),
  });
  return { client, ...fake };
}

describe('the prompt draft survives a failure', () => {
  const draft = 'ship the board';

  it('keeps the text when the server refuses the prompt', () => {
    const { client } = connectedClient();
    client.setDraftText(draft);

    const outcome = client.submitPrompt();
    expect(outcome.ok).toBe(true);
    // The send succeeded; the server's verdict is what decides the draft.
    client.accept({
      type: 'companyCommandResult',
      requestId: client.getState().prompt.pendingSubmit!.requestId,
      ok: false,
      errorCode: 'prompt_too_large',
      message: 'Prompt exceeds 2097152 bytes.',
    });

    expect(client.getState().prompt.text).toBe(draft);
    expect(client.getState().prompt.error).toMatchObject({ errorCode: 'prompt_too_large' });
  });

  it('clears the draft only when the server accepted it', () => {
    const { client } = connectedClient();
    client.setDraftText(draft);
    client.submitPrompt();

    client.accept({
      type: 'companyCommandResult',
      requestId: client.getState().prompt.pendingSubmit!.requestId,
      ok: true,
      revision: 2,
    });

    expect(client.getState().prompt.text).toBe('');
    expect(client.getState().prompt.pendingSubmit).toBeNull();
  });

  it('keeps the text when the socket is down and nothing was sent', () => {
    const { client, sent, setConnected } = connectedClient();
    client.setDraftText(draft);
    sent.length = 0;
    setConnected(false);

    const outcome = client.submitPrompt();

    expect(outcome.ok).toBe(false);
    expect(outcome.errorCode).toBe(TRANSPORT_DISCONNECTED_ERROR);
    expect(sent).toHaveLength(0);
    expect(client.getState().prompt.text).toBe(draft);
    expect(client.getState().prompt.error?.message).toContain('giữ nguyên');
  });

  it('refuses to send an empty prompt without asking the server', () => {
    const { client, sent } = connectedClient();
    sent.length = 0;

    const outcome = client.submitPrompt();

    expect(outcome.ok).toBe(false);
    expect(sent.some((message) => message.type === 'companyPromptSubmit')).toBe(false);
  });
});

describe('the prompt goes where the board points', () => {
  it('targets the selected session, so a follow-up is not refused for lack of one', () => {
    const { client, sent } = connectedClient();
    const sessionId = randomUUID();
    client.select({ sessionId, taskId: null });
    client.setDraftText('also cover the empty state');
    client.setDraftDelivery('follow_up');

    client.submitPrompt();

    expect(sent.find((message) => message.type === 'companyPromptSubmit')).toMatchObject({
      prompt: { delivery: 'follow_up', targetSessionId: sessionId },
    });
  });

  it('sends new work to the Director when nothing is selected', () => {
    const { client, sent } = connectedClient();
    client.setDraftText('build the standings page');

    client.submitPrompt();

    const message = sent.find((entry) => entry.type === 'companyPromptSubmit');
    expect(message).toBeDefined();
    expect(JSON.stringify(message)).not.toContain('targetSessionId');
  });
});

describe('the submit chord', () => {
  it('is Ctrl+Enter (or Cmd+Enter), never a bare Enter', () => {
    expect(isSubmitChord({ key: 'Enter', ctrlKey: true, metaKey: false })).toBe(true);
    expect(isSubmitChord({ key: 'Enter', ctrlKey: false, metaKey: true })).toBe(true);
    expect(isSubmitChord({ key: 'Enter', ctrlKey: false, metaKey: false })).toBe(false);
    expect(isSubmitChord({ key: 'a', ctrlKey: true, metaKey: false })).toBe(false);
  });
});

describe('a snapshot request goes out from the connect handshake', () => {
  it('asks for the snapshot when the transport connects', () => {
    const fake = fakeTransport();
    const client = new CompanyClient(fake.transport);

    client.connect();

    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]).toMatchObject({ type: 'companySnapshotRequest' });
  });

  it('drops a selection whose task the server removed', () => {
    const fake = fakeTransport();
    const client = new CompanyClient(fake.transport);
    const placed = task({ code: 'PA-T0001' });
    client.accept({
      type: 'companySnapshot',
      requestId: randomUUID(),
      snapshot: snapshot({ revision: 1, tasks: [placed] }),
    });
    client.select({ taskId: placed.id });
    expect(client.getState().selection.taskId).toBe(placed.id);

    client.accept({
      type: 'companyStateChanged',
      revision: 2,
      changes: [{ entity: 'task', op: 'remove', id: placed.id }],
    });

    expect(client.getState().selection.taskId).toBeNull();
  });
});

describe('terminal controller leases', () => {
  it('refuses writes before attachment and sends input, resize, and detach with the granted lease', () => {
    const { client, sent } = connectedClient();
    const sessionId = randomUUID();
    const leaseId = randomUUID();
    client.accept({
      type: 'companySnapshot',
      requestId: randomUUID(),
      snapshot: snapshot({ revision: 2, sessions: [session({ id: sessionId, runEpoch: 3 })] }),
    });
    client.attachTerminal(sessionId);

    const beforeAttach = sent.length;
    expect(client.writeTerminal(sessionId, 3, 'must not be sent')).toMatchObject({
      ok: false,
      errorCode: 'terminal_not_attached',
    });
    expect(sent).toHaveLength(beforeAttach);

    client.accept({
      type: 'terminalAttached',
      requestId: randomUUID(),
      sessionId,
      runEpoch: 3,
      leaseId,
      cols: 120,
      rows: 32,
    });
    client.writeTerminal(sessionId, 3, 'echo lease');
    client.resizeTerminal(sessionId, 3, 100, 30);
    client.detachTerminal(sessionId);

    expect(sent.filter((message) => message.type.startsWith('terminal'))).toMatchObject([
      { type: 'terminalAttach', sessionId, runEpoch: 3 },
      { type: 'terminalInput', sessionId, runEpoch: 3, data: 'echo lease', leaseId },
      { type: 'terminalResize', sessionId, runEpoch: 3, cols: 100, rows: 30, leaseId },
      { type: 'terminalDetach', sessionId, runEpoch: 3, leaseId },
    ]);
  });

  it('invalidates the old lease and reattaches only after a fresh reconnect snapshot', () => {
    const { client, sent } = connectedClient();
    const sessionId = randomUUID();
    client.accept({
      type: 'companySnapshot',
      requestId: randomUUID(),
      snapshot: snapshot({ revision: 2, sessions: [session({ id: sessionId, runEpoch: 3 })] }),
    });
    client.select({ sessionId });
    client.accept({
      type: 'terminalAttached',
      requestId: randomUUID(),
      sessionId,
      runEpoch: 3,
      leaseId: randomUUID(),
      cols: 120,
      rows: 32,
    });

    const previousCount = sent.length;
    client.connect();

    expect(sent.slice(previousCount).map((message) => message.type)).toEqual([
      'companySnapshotRequest',
    ]);
    expect(client.getState().terminals[sessionId]).toMatchObject({
      attached: false,
      leaseId: null,
    });
    expect(client.writeTerminal(sessionId, 3, 'not yet')).toMatchObject({
      ok: false,
      errorCode: 'terminal_not_attached',
    });

    client.accept({
      type: 'companySnapshot',
      requestId: randomUUID(),
      snapshot: snapshot({ revision: 3, sessions: [session({ id: sessionId, runEpoch: 4 })] }),
    });

    expect(sent.at(-1)).toMatchObject({ type: 'terminalAttach', sessionId, runEpoch: 4 });
  });
});

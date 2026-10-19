import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { TRANSPORT_DISCONNECTED_ERROR } from '../../core/src/messageDelivery.js';
import type { ClientMessage } from '../../core/src/messages.js';
import { CompanyClient } from '../src/company/companyClient.js';
import { companyRoute, resumeListView, startNewChat } from '../src/company/composerRouting.js';
import { isCompanyChord, type PromptRoute } from '../src/company/promptSubmission.js';
import type { MessageTransport } from '../src/transport/types.js';
import { session, settings, snapshot, task } from './companyFixtures.js';

/** A chat prompt with no target: what the client sends when no session is named. */
const NEW_CHAT: PromptRoute = { mode: 'chat', delivery: 'prompt', targetSessionId: null };

/** The folder the test board is on: the one the server marks active. */
const FOLDER = 'D:\\cong-ty';

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

/** A client that has applied a snapshot and the folder list, as the app's does on connect. */
function connectedClient() {
  const fake = fakeTransport();
  const client = new CompanyClient(fake.transport);
  client.accept({
    type: 'companySnapshot',
    requestId: randomUUID(),
    workspacePath: FOLDER,
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
  client.accept({
    type: 'companyWorkspaces',
    workspaces: [{ path: FOLDER, active: true, open: true, working: 0, waiting: 0 }],
  });
  return { client, ...fake };
}

describe('the prompt draft survives a failure', () => {
  const draft = 'ship the board';

  it('keeps the text when the server refuses the prompt', () => {
    const { client } = connectedClient();
    client.setDraftText(draft);

    const outcome = client.submitPrompt(NEW_CHAT);
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
    client.submitPrompt(NEW_CHAT);

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

    const outcome = client.submitPrompt(NEW_CHAT);

    expect(outcome.ok).toBe(false);
    expect(outcome.errorCode).toBe(TRANSPORT_DISCONNECTED_ERROR);
    expect(sent).toHaveLength(0);
    expect(client.getState().prompt.text).toBe(draft);
    expect(client.getState().prompt.error?.message).toContain('giữ nguyên');
  });

  it('refuses to send an empty prompt without asking the server', () => {
    const { client, sent } = connectedClient();
    sent.length = 0;

    const outcome = client.submitPrompt(NEW_CHAT);

    expect(outcome.ok).toBe(false);
    expect(sent.some((message) => message.type === 'companyPromptSubmit')).toBe(false);
  });
});

describe('the prompt goes where the route says', () => {
  it('sends a follow-up to the selected session', () => {
    const { client, sent } = connectedClient();
    const sessionId = randomUUID();
    client.select({ sessionId, taskId: null });
    client.setDraftText('also cover the empty state');

    client.submitPrompt({ mode: 'chat', delivery: 'follow_up', targetSessionId: sessionId });

    expect(sent.find((message) => message.type === 'companyPromptSubmit')).toMatchObject({
      prompt: { mode: 'chat', delivery: 'follow_up', targetSessionId: sessionId },
    });
  });

  it('sends a chat prompt with no target when nothing is selected', () => {
    const { client, sent } = connectedClient();
    client.setDraftText('build the standings page');

    client.submitPrompt(NEW_CHAT);

    const message = sent.find((entry) => entry.type === 'companyPromptSubmit');
    expect(message).toMatchObject({ prompt: { mode: 'chat', delivery: 'prompt' } });
    expect(JSON.stringify(message)).not.toContain('targetSessionId');
  });

  it('sends a company prompt to a Company session', () => {
    const { client, sent } = connectedClient();
    const worker = session({ id: randomUUID(), role: 'worker' });
    client.setDraftText('build the standings page');

    client.submitPrompt(companyRoute(worker));

    expect(sent.find((entry) => entry.type === 'companyPromptSubmit')).toMatchObject({
      prompt: { mode: 'company', delivery: 'prompt', targetSessionId: worker.id },
    });
  });

  it('never targets a plain omp chat from company mode', () => {
    const { client, sent } = connectedClient();
    const chat = session({ id: randomUUID(), role: 'chat' });
    client.setDraftText('build the standings page');

    client.submitPrompt(companyRoute(chat));

    const message = sent.find((entry) => entry.type === 'companyPromptSubmit');
    expect(message).toMatchObject({ prompt: { mode: 'company', delivery: 'prompt' } });
    expect(JSON.stringify(message)).not.toContain('targetSessionId');
  });
});

describe('the composer chords', () => {
  // A keypress with no modifier held; each case names only the modifiers it changes.
  const base = { key: 'Enter', ctrlKey: false, metaKey: false, shiftKey: false };

  it('Ctrl/Cmd+Shift+Enter is the company chord', () => {
    expect(isCompanyChord({ ...base, ctrlKey: true, shiftKey: true })).toBe(true);
    expect(isCompanyChord({ ...base, metaKey: true, shiftKey: true })).toBe(true);
    expect(isCompanyChord({ ...base, ctrlKey: true })).toBe(false);
    expect(isCompanyChord({ ...base, shiftKey: true })).toBe(false);
    expect(isCompanyChord(base)).toBe(false);
  });
});

describe('/new opens a chat with no prompt', () => {
  const NEW_ID = randomUUID();

  it('asks the server for a new chat and leaves the draft alone', () => {
    const { client, sent } = connectedClient();
    client.setDraftText('draft kept');
    sent.length = 0;

    void startNewChat(client);

    expect(sent).toEqual([
      { type: 'companyChatNew', requestId: expect.any(String), workspacePath: FOLDER },
    ]);
    expect(client.getState().prompt.text).toBe('draft kept');
  });

  it('selects the session the server names in its verdict', async () => {
    const { client, sent } = connectedClient();
    sent.length = 0;

    const opened = startNewChat(client);
    const [request] = sent;
    if (request?.type !== 'companyChatNew') throw new Error('companyChatNew was not sent');
    client.accept({
      type: 'companyCommandResult',
      requestId: request.requestId,
      ok: true,
      sessionId: NEW_ID,
    });

    await expect(opened).resolves.toMatchObject({ ok: true, sessionId: NEW_ID });
    expect(client.getState().selection.sessionId).toBe(NEW_ID);
  });
});

describe('/resume asks for the saved omp sessions and lists the answer to its own request', () => {
  const saved = {
    file: 'D:/omp/sessions/bang-xep-hang.jsonl',
    title: 'Bảng xếp hạng',
    updatedAt: '2026-10-02T10:00:00.000Z',
    sizeBytes: 2048,
  };

  it('sends the request under the handle requestId', () => {
    const { client, sent } = connectedClient();
    sent.length = 0;

    const handle = client.requestOmpSessions();

    expect(handle.ok).toBe(true);
    expect(sent).toEqual([
      { type: 'companyOmpSessionsRequest', requestId: handle.requestId, workspacePath: FOLDER },
    ]);
  });

  it('a request the socket refuses is reported on its handle, so no list is awaited', () => {
    const { client, setConnected } = connectedClient();
    setConnected(false);

    const handle = client.requestOmpSessions();

    expect(handle.ok).toBe(false);
    expect(handle.errorCode).toBe(TRANSPORT_DISCONNECTED_ERROR);
  });

  it('is loading until the answer to its own request arrives', () => {
    const { client } = connectedClient();
    const { requestId } = client.requestOmpSessions();
    expect(resumeListView(requestId, client.getState().ompSessions, undefined)).toEqual({
      kind: 'loading',
    });

    client.accept({ type: 'companyOmpSessions', requestId, folder: 'D:/omp', sessions: [saved] });

    expect(resumeListView(requestId, client.getState().ompSessions, undefined)).toEqual({
      kind: 'ready',
      entries: [saved],
    });
  });

  it('ignores an answer to an earlier request', () => {
    const { client } = connectedClient();
    const earlier = client.requestOmpSessions();
    const current = client.requestOmpSessions();

    client.accept({
      type: 'companyOmpSessions',
      requestId: earlier.requestId,
      folder: 'D:/omp',
      sessions: [saved],
    });

    expect(resumeListView(current.requestId, client.getState().ompSessions, undefined)).toEqual({
      kind: 'loading',
    });
  });

  it('shows the refusal of its own request rather than loading forever', () => {
    const { client } = connectedClient();
    const { requestId } = client.requestOmpSessions();

    client.accept({
      type: 'companyCommandResult',
      requestId,
      ok: false,
      errorCode: 'workspace_missing',
      message: 'Thư mục không còn tồn tại.',
    });

    expect(
      resumeListView(
        requestId,
        client.getState().ompSessions,
        client.getState().commandResults[requestId],
      ),
    ).toEqual({ kind: 'failed', message: 'Thư mục không còn tồn tại.' });
  });
});

describe('a snapshot request goes out from the connect handshake', () => {
  it('asks for the snapshot when the transport connects', () => {
    const fake = fakeTransport();
    const client = new CompanyClient(fake.transport);

    client.connect();

    expect(fake.sent.map((message) => message.type)).toEqual([
      'companyViewMode',
      'companySnapshotRequest',
    ]);
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
      workspacePath: FOLDER,
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
      workspacePath: FOLDER,
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
      'companyViewMode',
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
      workspacePath: FOLDER,
      snapshot: snapshot({ revision: 3, sessions: [session({ id: sessionId, runEpoch: 4 })] }),
    });

    expect(sent.at(-1)).toMatchObject({ type: 'terminalAttach', sessionId, runEpoch: 4 });
  });
});

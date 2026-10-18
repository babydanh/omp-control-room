import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { CompanySessionSummary, Question } from '../../core/src/company.js';
import { TRANSPORT_DISCONNECTED_ERROR } from '../../core/src/messageDelivery.js';
import type { ClientMessage } from '../../core/src/messages.js';
import { buildAgentGroups } from '../src/company/agentSidebarView.js';
import { failureNotice } from '../src/company/commandResults.js';
import { CompanyClient } from '../src/company/companyClient.js';
import { REFUSED_NOTICE } from '../src/company/sessionActions.js';
import {
  deleteSession,
  deleteSessionsInOrder,
  removableErroredSessionIds,
  removalNotice,
} from '../src/company/sessionRemoval.js';
import type { MessageTransport } from '../src/transport/types.js';
import { question, session, snapshot, stateFrom } from './companyFixtures.js';

/** A fixed clock, so the sidebar's relative times do not depend on when the test runs. */
const NOW = Date.parse('2026-10-02T10:00:00.000Z');

type ControlRequest = Extract<ClientMessage, { type: 'companySessionControl' }>;

interface Outcome {
  ok: boolean;
  errorCode?: string;
  message?: string;
}

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

/** A client that has applied a snapshot holding the given sessions and questions. */
function seededClient(sessions: CompanySessionSummary[], questions: Question[] = []) {
  const fake = fakeTransport();
  const client = new CompanyClient(fake.transport);
  client.accept({
    type: 'companySnapshot',
    requestId: randomUUID(),
    snapshot: snapshot({ sessions, questions }),
  });
  return { client, ...fake };
}

function controlRequests(sent: readonly ClientMessage[]): ControlRequest[] {
  return sent.filter(
    (message): message is ControlRequest => message.type === 'companySessionControl',
  );
}

/** Delivers the server's verdict for one command, as the socket would. */
function answer(client: CompanyClient, requestId: string, outcome: Outcome): void {
  client.accept({ type: 'companyCommandResult', requestId, ...outcome });
}

/**
 * Lets the queued continuations run. The client and the runner only use promises, so
 * this drains them without any timer.
 */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
}

/** The cleanup's planned session ids for the worker role, on a board holding these sessions. */
function removableWorkers(sessions: CompanySessionSummary[], questions: Question[] = []): string[] {
  const state = stateFrom({ sessions, questions });
  const group = buildAgentGroups(state, NOW).find((entry) => entry.role === 'worker');
  if (group === undefined) throw new Error('the worker group is always built');
  return removableErroredSessionIds(state, group);
}

describe('removableErroredSessionIds', () => {
  it('offers a crashed session that holds no task and no work', () => {
    const crashed = session({ status: 'crashed' });

    expect(removableWorkers([crashed])).toEqual([crashed.id]);
  });

  it('keeps out a crashed session that still names a task', () => {
    const crashed = session({ status: 'crashed', activeTaskId: 'task-missing' });

    expect(removableWorkers([crashed])).toEqual([]);
  });

  it('keeps out a crashed session while a question waits on the user', () => {
    const crashed = session({ status: 'crashed' });
    const asked = question({ sessionId: crashed.id, status: 'pending' });

    expect(removableWorkers([crashed], [asked])).toEqual([]);
  });

  it('never offers a session that is parked, stopped, idle or still running', () => {
    const others = (['parked', 'stopped', 'idle', 'busy'] as const).map((status) =>
      session({ status }),
    );

    expect(removableWorkers(others)).toEqual([]);
  });

  it('offers only the crashed sessions of the role it is asked about', () => {
    const worker = session({ status: 'crashed' });
    const director = session({ role: 'director', status: 'crashed' });

    expect(removableWorkers([worker, director])).toEqual([worker.id]);
  });
});

describe('deleteSessionsInOrder', () => {
  it('sends the next delete only after the previous verdict is held', async () => {
    const alpha = session({ status: 'crashed' });
    const beta = session({ status: 'crashed' });
    const { client, sent } = seededClient([alpha, beta]);

    const run = deleteSessionsInOrder(client, [alpha.id, beta.id]);
    await settle();
    expect(controlRequests(sent).map((request) => request.sessionId)).toEqual([alpha.id]);

    answer(client, controlRequests(sent)[0].requestId, { ok: true });
    await settle();
    expect(controlRequests(sent).map((request) => request.sessionId)).toEqual([alpha.id, beta.id]);

    answer(client, controlRequests(sent)[1].requestId, { ok: true });
    expect(await run).toEqual({ deleted: 2, refused: 0, messages: [] });
  });

  it('counts a refusal with its reason and still sends the rest', async () => {
    const alpha = session({ status: 'crashed' });
    const beta = session({ status: 'crashed' });
    const { client, sent } = seededClient([alpha, beta]);
    const refusal: Outcome = {
      ok: false,
      errorCode: 'session_busy',
      message: 'Phiên đang giữ việc.',
    };

    const run = deleteSessionsInOrder(client, [alpha.id, beta.id]);
    await settle();
    answer(client, controlRequests(sent)[0].requestId, refusal);
    await settle();
    answer(client, controlRequests(sent)[1].requestId, refusal);

    expect(await run).toEqual({ deleted: 0, refused: 2, messages: ['Phiên đang giữ việc.'] });
  });

  it('counts every delete as refused while the socket is down, and sends none', async () => {
    const alpha = session({ status: 'crashed' });
    const beta = session({ status: 'crashed' });
    const { client, sent, setConnected } = seededClient([alpha, beta]);
    setConnected(false);

    const report = await deleteSessionsInOrder(client, [alpha.id, beta.id]);

    expect(controlRequests(sent)).toEqual([]);
    expect(report.deleted).toBe(0);
    expect(report.refused).toBe(2);
    expect(report.messages).toHaveLength(1);
  });

  it('reports a delete whose verdict a dropped socket lost, and still sends the rest', async () => {
    const alpha = session({ status: 'crashed' });
    const beta = session({ status: 'crashed' });
    const { client, sent } = seededClient([alpha, beta]);

    const run = deleteSessionsInOrder(client, [alpha.id, beta.id]);
    await settle();
    client.connect();
    await settle();
    expect(controlRequests(sent)).toHaveLength(2);

    answer(client, controlRequests(sent)[1].requestId, { ok: true });
    const report = await run;

    expect(report.deleted).toBe(1);
    expect(report.refused).toBe(1);
    expect(report.messages).toHaveLength(1);
  });
});

describe('deleteSession', () => {
  it('clears the selection when the selected session is deleted', async () => {
    const alpha = session({ status: 'crashed' });
    const { client, sent } = seededClient([alpha]);
    client.select({ sessionId: alpha.id });

    const pending = deleteSession(client, alpha.id);
    await settle();
    answer(client, controlRequests(sent)[0].requestId, { ok: true });

    expect((await pending).ok).toBe(true);
    expect(client.getState().selection.sessionId).toBeNull();
  });

  it('keeps the selection when a delete is refused or another session is removed', async () => {
    const alpha = session({ status: 'crashed' });
    const beta = session({ status: 'crashed' });
    const { client, sent } = seededClient([alpha, beta]);
    client.select({ sessionId: alpha.id });

    const refused = deleteSession(client, alpha.id);
    await settle();
    answer(client, controlRequests(sent)[0].requestId, {
      ok: false,
      errorCode: 'session_busy',
      message: 'Phiên đang giữ việc.',
    });
    await refused;

    const removed = deleteSession(client, beta.id);
    await settle();
    answer(client, controlRequests(sent)[1].requestId, { ok: true });
    await removed;

    expect(client.getState().selection.sessionId).toBe(alpha.id);
  });
});

describe('withdrawing a planned prompt', () => {
  it('sends the withdrawal for that prompt and reads a refusal as the server message', async () => {
    const { client, sent } = seededClient([]);

    const handle = client.cancelPrompt('prompt-1');
    expect(sent).toContainEqual({
      type: 'companyPromptCancel',
      requestId: handle.requestId,
      promptId: 'prompt-1',
    });

    const verdict = client.waitForCommand(handle);
    answer(client, handle.requestId, {
      ok: false,
      errorCode: 'prompt_held',
      message: 'Prompt đã có hợp đồng.',
    });

    expect(failureNotice(await verdict, REFUSED_NOTICE)).toBe('Prompt đã có hợp đồng.');
  });
});

describe('removalNotice', () => {
  it('says what went when nothing was refused', () => {
    expect(removalNotice({ deleted: 2, refused: 0, messages: [] })).toBe(
      'Đã xoá 2 phiên; 0 phiên bị từ chối.',
    );
  });

  it('names each distinct refusal after the count', () => {
    expect(removalNotice({ deleted: 1, refused: 2, messages: ['Phiên đang giữ việc.'] })).toBe(
      'Đã xoá 1 phiên; 2 phiên bị từ chối: Phiên đang giữ việc.',
    );
  });
});

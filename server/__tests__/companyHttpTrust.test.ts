import { randomUUID } from 'node:crypto';
import { once } from 'node:events';

import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';

import { AgentStateStore } from '../src/agentStateStore.js';
import type { CompanyCommandServices } from '../src/company/clientCommands.js';
import { createHttpServer } from '../src/httpServer.js';

const TOKEN = 'company-http-trust-test-token';
let app: FastifyInstance | undefined;
let store: AgentStateStore | undefined;
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await app?.close();
  app = undefined;
  store?.dispose();
  store = undefined;
});

async function connect(privileged: boolean, embedded = false) {
  const address = app?.server.address();
  if (!address || typeof address === 'string') throw new Error('HTTP server did not bind');
  const query = privileged && !embedded ? `?token=${TOKEN}` : '';
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws${query}`, {
    headers: privileged && embedded ? { Authorization: `Bearer ${TOKEN}` } : {},
  });
  sockets.push(socket);
  const messages: Record<string, unknown>[] = [];
  socket.on('message', (data) => messages.push(JSON.parse(data.toString())));
  await once(socket, 'open');
  return { socket, messages };
}

async function receive(messages: Record<string, unknown>[], type: string, requestId?: string) {
  await vi.waitFor(() =>
    expect(
      messages.some(
        (message) => message.type === type && (!requestId || message.requestId === requestId),
      ),
    ).toBe(true),
  );
  return messages.find(
    (message) => message.type === type && (!requestId || message.requestId === requestId),
  );
}

describe('Company HTTP execution trust and terminal privacy', () => {
  it.each([false, undefined])(
    'refuses authenticated embedded execution when trust is %s',
    async (trusted) => {
      const submitPrompt = vi.fn(async () => {
        throw new Error('Untrusted workspace executed a prompt.');
      });
      store = new AgentStateStore();
      app = (
        await createHttpServer({
          host: '127.0.0.1',
          port: 0,
          token: TOKEN,
          embedded: true,
          store,
          getCompany: () =>
            ({ coordinator: { submitPrompt } }) as unknown as CompanyCommandServices,
          ...(trusted === undefined ? {} : { isCompanyExecutionAllowed: () => trusted }),
        })
      ).app;
      const client = await connect(true, true);
      const requestId = randomUUID();
      client.socket.send(
        JSON.stringify({
          type: 'companyPromptSubmit',
          requestId,
          prompt: { requestId, text: 'Do not execute.', delivery: 'prompt', attachments: [] },
        }),
      );
      expect(await receive(client.messages, 'companyCommandResult', requestId)).toMatchObject({
        ok: false,
        errorCode: 'workspace_untrusted',
      });
      expect(submitPrompt).not.toHaveBeenCalled();
    },
  );

  it('keeps terminal output on the replacement lease and private output off the public office socket', async () => {
    const sessionId = randomUUID();
    const firstLease = randomUUID();
    const replacementLease = randomUUID();
    let attachCount = 0;
    const terminal = {
      attach: async () => ({
        sessionId,
        runEpoch: 1,
        leaseId: attachCount++ === 0 ? firstLease : replacementLease,
        dataBase64: '',
        cols: 80,
        rows: 24,
      }),
    };
    store = new AgentStateStore();
    app = (
      await createHttpServer({
        host: '127.0.0.1',
        port: 0,
        token: TOKEN,
        embedded: false,
        store,
        getCompany: () => ({ terminal }) as unknown as CompanyCommandServices,
        isCompanyExecutionAllowed: () => true,
      })
    ).app;
    const first = await connect(true);
    const replacement = await connect(true);
    const publicOffice = await connect(false);
    for (const client of [first, replacement]) {
      const requestId = randomUUID();
      client.socket.send(
        JSON.stringify({
          type: 'terminalAttach',
          requestId,
          sessionId,
          runEpoch: 1,
        }),
      );
      await receive(client.messages, 'terminalAttached', requestId);
    }
    const output = 'private native terminal output';
    store.broadcast({
      type: 'terminalData',
      sessionId,
      runEpoch: 1,
      data: Buffer.from(output).toString('base64'),
      seq: 1,
    });
    store.broadcast({
      type: 'companyTextDelta',
      sessionId,
      runEpoch: 1,
      text: 'private public-model text',
      excerpt: 'private public-model text',
      seq: 1,
    });
    // A subsequent public frame is an ordering witness: once each socket receives
    // it, the preceding frames have passed its real per-client egress gate.
    store.broadcast({ type: 'agentCreated', id: 321 });
    for (const client of [first, replacement, publicOffice])
      await receive(client.messages, 'agentCreated');
    expect(first.messages.filter((message) => message.type === 'terminalData')).toEqual([]);
    expect(replacement.messages.filter((message) => message.type === 'terminalData')).toEqual([
      expect.objectContaining({ data: Buffer.from(output).toString('base64') }),
    ]);
    expect(
      publicOffice.messages.filter(
        (message) =>
          String(message.type).startsWith('company') || String(message.type).startsWith('terminal'),
      ),
    ).toEqual([]);
  });
});

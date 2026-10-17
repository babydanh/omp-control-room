/**
 * The native model catalog: what OMP actually offers, read from inside the OMP
 * process and delivered over the authenticated bridge.
 *
 * The catalog is the one company decision that cannot be made from the host:
 * only a live OMP extension holds `ctx.models.list()`, the runtime's own
 * credential-filtered model set, plus the baked `input` modalities and
 * `thinking.efforts` of each model. So every case here drives the real host
 * against the real extension module over a real pipe, with the injected
 * `ExtensionAPI` seam faked — and the fake reproduces the installed OMP 18.4.9
 * shapes read from `@oh-my-pi/pi-coding-agent` source:
 *
 *   `ExtensionContext.models.list()`          → `modelRegistry.getAvailable()`
 *                                               (authenticated models only)
 *   `ExtensionContext.modelRegistry`          → `hasConfiguredAuth(model)`
 *   `Model.id` / `Model.provider`             → `id` and `Provider` (a string)
 *   `Model.input`                             → `("text" | "image")[]`
 *   `Model.reasoning` / `Model.thinking`      → `ThinkingConfig.efforts`
 *
 * Fail-closed behavior is asserted at every step: a context without the model
 * facade, a catalog that is not an array, rows without an id, a throwing
 * registry, a catalog too large for one frame, and a result naming another run
 * all refuse to produce a catalog rather than degrade into an empty one.
 *
 * Timing: every case awaits an actual frame, socket close or answered promise;
 * `waitFor` is the only polling and it fails naming what it awaited.
 */

import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  assertImageDeliverable,
  buildCompanyModelCatalogFromBridge,
} from '../src/company/modelCatalog.js';
import type { OmpBridgeEvent, OmpBridgeHandle } from '../src/company/ompBridge.js';
import {
  createOmpBridge,
  OMP_BRIDGE_ENV,
  OMP_BRIDGE_MAX_CATALOG_MODELS,
  OMP_BRIDGE_MAX_PENDING_MODEL_REQUESTS,
  OMP_BRIDGE_PROTOCOL_VERSION,
} from '../src/company/ompBridge.js';
import ompBridgeExtension from '../src/company/ompBridgeExtension.js';

// ── Installed OMP shapes (18.4.9) ──────────────────────────────

/**
 * A `Model` row as the runtime materializes it. The sensitive-looking fields
 * (`baseUrl`, `cost`, `headers`) are present on purpose: the assertion that
 * they never reach the wire is only meaningful if the runtime really has them.
 */
interface OmpModelRow {
  id: string;
  provider: string;
  name: string;
  reasoning: boolean;
  input: ('text' | 'image')[];
  thinking?: { mode: string; efforts: readonly string[] };
  baseUrl?: string;
  cost?: Record<string, unknown>;
  headers?: Record<string, string>;
}

function modelRow(overrides: Partial<OmpModelRow> & { id: string; provider: string }): OmpModelRow {
  return {
    name: overrides.id,
    reasoning: false,
    input: ['text'],
    baseUrl: 'https://api.internal.example/v1',
    cost: { input: 3, output: 15 },
    headers: { authorization: 'Bearer sk-super-secret-value' },
    ...overrides,
  };
}

/** The catalog a fully authenticated install of this user's OMP would report. */
const AVAILABLE_MODELS: OmpModelRow[] = [
  modelRow({ id: 'gpt-6.1-sol', provider: 'openai-codex', input: ['text', 'image'] }),
  modelRow({
    id: 'gpt-6-luna',
    provider: 'openai-codex',
    reasoning: true,
    thinking: { mode: 'effort', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  }),
  // A reasoning model with no controllable effort surface: `thinking: undefined`.
  modelRow({ id: 'space-bunny-alpha', provider: 'openrouter', reasoning: true }),
  modelRow({ id: 'claude-sonnet-5-5', provider: 'anthropic', input: ['text', 'image'] }),
];

// ── Fake OMP extension API ─────────────────────────────────────

interface FakeTool {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  execute(
    toolCallId: string,
    params: unknown,
    ...rest: unknown[]
  ): Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }>;
}

type FakeHandler = (event: unknown, ctx: FakeContext) => unknown;

interface FakeContext {
  agent: { kind: 'main' | 'sub' };
  isIdle(): boolean;
  hasPendingMessages(): boolean;
  getAsyncJobSnapshot(): { running: unknown[] };
  sessionManager: { getSessionId(): string; getSessionFile(): string | undefined };
  /** Present on a real context; absent models the "capability missing" case. */
  models?: { list(): unknown };
  modelRegistry?: { hasConfiguredAuth(model: unknown): boolean };
}

function fakeSchema(kind: string): unknown {
  const schema: Record<string, unknown> = { kind };
  for (const method of ['describe', 'optional', 'default']) schema[method] = () => schema;
  return schema;
}

class FakePi {
  readonly tools = new Map<string, FakeTool>();
  readonly handlers = new Map<string, FakeHandler[]>();
  readonly userMessages: { content: unknown; options: unknown }[] = [];
  readonly logs: { level: string; args: unknown[] }[] = [];
  readonly zod = {
    string: () => fakeSchema('string'),
    record: () => fakeSchema('record'),
    object: () => fakeSchema('object'),
    unknown: () => fakeSchema('unknown'),
  };
  readonly logger = {
    debug: (...args: unknown[]) => this.logs.push({ level: 'debug', args }),
    info: (...args: unknown[]) => this.logs.push({ level: 'info', args }),
    warn: (...args: unknown[]) => this.logs.push({ level: 'warn', args }),
    error: (...args: unknown[]) => this.logs.push({ level: 'error', args }),
  };

  registerTool(tool: FakeTool): void {
    this.tools.set(tool.name, tool);
  }

  on(event: string, handler: FakeHandler): void {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
  }

  sendUserMessage(content: unknown, options?: unknown): void {
    this.userMessages.push({ content, options });
  }

  async emit(event: string, payload: unknown, ctx: FakeContext): Promise<unknown> {
    let result: unknown;
    for (const handler of this.handlers.get(event) ?? []) {
      const value = await handler(payload, ctx);
      if (value !== undefined && result === undefined) result = value;
    }
    return result;
  }
}

/** A context whose model facade returns exactly what the runtime would. */
function modelContext(overrides: Partial<FakeContext> = {}): FakeContext {
  return {
    agent: { kind: 'main' },
    isIdle: () => true,
    hasPendingMessages: () => false,
    getAsyncJobSnapshot: () => ({ running: [] }),
    sessionManager: {
      getSessionId: () => 'native-session-1',
      getSessionFile: () => '/workspace/.company/sessions/native-session-1.jsonl',
    },
    models: { list: () => AVAILABLE_MODELS },
    modelRegistry: { hasConfiguredAuth: () => true },
    ...overrides,
  };
}

// ── Test harness ───────────────────────────────────────────────

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: Error) => void;
} {
  let resolve: (value: T) => void = () => undefined;
  let reject: (err: Error) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface RawClient {
  frames: Record<string, unknown>[];
  socket: net.Socket;
  send(value: unknown): void;
  waitFor(predicate: (frame: Record<string, unknown>) => boolean): Promise<Record<string, unknown>>;
  closed: Promise<void>;
  close(): void;
}

function openRawClient(endpoint: string): Promise<RawClient> {
  const connected = deferred<RawClient>();
  const socket = net.createConnection(endpoint);
  const frames: Record<string, unknown>[] = [];
  const waiters: {
    predicate: (frame: Record<string, unknown>) => boolean;
    resolve: (frame: Record<string, unknown>) => void;
  }[] = [];
  const closed = deferred<void>();
  let buffer = '';

  socket.setEncoding('utf8');
  socket.on('data', (chunk) => {
    buffer += chunk;
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf('\n');
      if (!line) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof parsed !== 'object' || parsed === null) continue;
      const frame = parsed as Record<string, unknown>;
      frames.push(frame);
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i].predicate(frame)) waiters.splice(i, 1)[0].resolve(frame);
      }
    }
  });
  socket.once('error', connected.reject);
  socket.once('close', () => closed.resolve());
  socket.once('connect', () => {
    connected.resolve({
      frames,
      socket,
      closed: closed.promise,
      send: (value) => socket.write(`${JSON.stringify(value)}\n`),
      waitFor: (predicate) => {
        const existing = frames.find(predicate);
        if (existing) return Promise.resolve(existing);
        const waiter = deferred<Record<string, unknown>>();
        waiters.push({ predicate, resolve: waiter.resolve });
        return waiter.promise;
      },
      close: () => socket.destroy(),
    });
  });
  return connected.promise;
}

async function waitFor(condition: () => boolean, what = 'condition'): Promise<void> {
  const deadline = Date.now() + 5000;
  for (;;) {
    if (condition()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

describe('native model catalog', () => {
  let socketDir: string;
  let bridge: OmpBridgeHandle | undefined;
  let rawClients: RawClient[] = [];
  const events: OmpBridgeEvent[] = [];

  beforeEach(() => {
    socketDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-catalog-'));
    rawClients = [];
    events.length = 0;
  });

  afterEach(async () => {
    for (const client of rawClients) client.close();
    rawClients = [];
    await bridge?.dispose();
    bridge = undefined;
    fs.rmSync(socketDir, { recursive: true, force: true });
    for (const key of Object.values(OMP_BRIDGE_ENV)) delete process.env[key];
  });

  function startBridge(
    overrides: Partial<Parameters<typeof createOmpBridge>[0]> = {},
  ): OmpBridgeHandle {
    const handle = createOmpBridge({
      sessionId: 'session-1',
      runEpoch: 7,
      role: 'director',
      socketDir,
      rpcHandler: async () => ({ allow: true }),
      ...overrides,
    });
    handle.onEvent((event) => events.push(event));
    bridge = handle;
    return handle;
  }

  /** Load the real extension and wait until it has authenticated. */
  async function startExtension(
    handle: OmpBridgeHandle,
    ctx: FakeContext = modelContext(),
  ): Promise<FakePi> {
    const pi = new FakePi();
    Object.assign(process.env, handle.childEnv);
    ompBridgeExtension(pi as unknown as never);
    await handle.ready;
    // The host settles `ready` when it accepts the handshake, while the
    // extension marks itself authenticated when it reads the acknowledgement.
    // Re-emitting until the host observes an authenticated-only event closes
    // that gap, so nothing here waits on a guessed delay.
    events.length = 0;
    await waitFor(() => {
      void pi.emit('session_start', { type: 'session_start' }, ctx);
      return events.some((event) => event.k === 'session' && event.phase === 'started');
    }, 'the extension to authenticate');
    return pi;
  }

  // ── Projection ──────────────────────────────────────────────

  it('reports the runtime model list with the ids, modalities and efforts OMP reports', async () => {
    const handle = startBridge();
    await startExtension(handle);

    const catalog = await handle.requestModelCatalog();

    expect(catalog.sessionId).toBe('session-1');
    expect(catalog.runEpoch).toBe(7);
    expect(catalog.models).toEqual([
      {
        id: 'openai-codex/gpt-6.1-sol',
        provider: 'openai-codex',
        model: 'gpt-6.1-sol',
        input: ['text', 'image'],
        configured: true,
      },
      {
        id: 'openai-codex/gpt-6-luna',
        provider: 'openai-codex',
        model: 'gpt-6-luna',
        input: ['text'],
        thinkingLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
        configured: true,
      },
      // Reasoning with no controllable effort surface: `thinking: undefined`.
      {
        id: 'openrouter/space-bunny-alpha',
        provider: 'openrouter',
        model: 'space-bunny-alpha',
        input: ['text'],
        configured: true,
      },
      {
        id: 'anthropic/claude-sonnet-5-5',
        provider: 'anthropic',
        model: 'claude-sonnet-5-5',
        input: ['text', 'image'],
        configured: true,
      },
    ]);
  });

  it('never puts a base url, price or header on the wire', async () => {
    const handle = startBridge();
    await startExtension(handle);

    const catalog = await handle.requestModelCatalog();

    const wire = JSON.stringify(catalog);
    expect(wire).not.toContain('api.internal.example');
    expect(wire).not.toContain('sk-super-secret-value');
    expect(wire).not.toContain('baseUrl');
    expect(wire).not.toContain('headers');
    expect(wire).not.toContain('cost');
  });

  it('marks a model the runtime reports no credential for as unconfigured', async () => {
    const handle = startBridge();
    await startExtension(
      handle,
      modelContext({
        modelRegistry: {
          hasConfiguredAuth: (model) => (model as OmpModelRow).provider !== 'anthropic',
        },
      }),
    );

    const catalog = await handle.requestModelCatalog();

    expect(
      catalog.models.find((entry) => entry.id === 'anthropic/claude-sonnet-5-5'),
    ).toMatchObject({ configured: false });
    expect(catalog.models.find((entry) => entry.id === 'openai-codex/gpt-6.1-sol')).toMatchObject({
      configured: true,
    });
  });

  it('gates image delivery on the modalities the runtime reported', async () => {
    const handle = startBridge();
    await startExtension(handle);

    const entries = buildCompanyModelCatalogFromBridge(await handle.requestModelCatalog(), {
      sessionId: 'session-1',
      runEpoch: 7,
    });

    expect(entries.find((entry) => entry.id === 'openai-codex/gpt-6.1-sol')).toMatchObject({
      acceptsImages: true,
      thinking: [],
      credentialsConfigured: true,
    });
    expect(() => assertImageDeliverable(entries, 'openai-codex/gpt-6.1-sol')).not.toThrow();
    expect(() => assertImageDeliverable(entries, 'openai-codex/gpt-6-luna')).toThrowError(
      expect.objectContaining({ code: 'image_not_supported_by_model' }),
    );
  });

  it('exposes the effort ladder a model declares and invents none for the others', async () => {
    const handle = startBridge();
    await startExtension(handle);

    const entries = buildCompanyModelCatalogFromBridge(await handle.requestModelCatalog(), {
      sessionId: 'session-1',
      runEpoch: 7,
    });

    expect(entries.find((entry) => entry.id === 'openai-codex/gpt-6-luna')?.thinking).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ]);
    // Reasoning without a controllable effort surface, and a plain text model.
    expect(entries.find((entry) => entry.id === 'openrouter/space-bunny-alpha')?.thinking).toEqual(
      [],
    );
    expect(entries.find((entry) => entry.id === 'anthropic/claude-sonnet-5-5')?.thinking).toEqual(
      [],
    );
  });

  // ── Fail closed ─────────────────────────────────────────────

  it('refuses the catalog when the extension context has no model facade', async () => {
    const handle = startBridge();
    await startExtension(handle, modelContext({ models: undefined, modelRegistry: undefined }));

    await expect(handle.requestModelCatalog()).rejects.toMatchObject({
      code: 'omp_model_capability_missing',
    });
  });

  it('refuses the catalog when the runtime list is not an array', async () => {
    const handle = startBridge();
    await startExtension(handle, modelContext({ models: { list: () => ({ gpt: 'not a list' }) } }));

    await expect(handle.requestModelCatalog()).rejects.toMatchObject({
      code: 'omp_model_catalog_malformed',
    });
  });

  it('refuses the whole catalog when one row carries no model id', async () => {
    const handle = startBridge();
    await startExtension(
      handle,
      modelContext({
        models: { list: () => [{ provider: 'openai-codex', input: ['text'] }] },
      }),
    );

    await expect(handle.requestModelCatalog()).rejects.toMatchObject({
      code: 'omp_model_catalog_malformed',
    });
  });

  it('refuses the catalog when the registry throws instead of answering', async () => {
    const handle = startBridge();
    await startExtension(
      handle,
      modelContext({
        models: {
          list: () => {
            throw new Error('registry offline');
          },
        },
      }),
    );

    await expect(handle.requestModelCatalog()).rejects.toMatchObject({
      code: 'omp_model_catalog_unavailable',
    });
  });

  it('refuses a catalog too large for one bridge frame rather than truncating it', async () => {
    const handle = startBridge();
    const rows = Array.from({ length: OMP_BRIDGE_MAX_CATALOG_MODELS + 1 }, (_, index) =>
      modelRow({ id: `model-with-a-long-identifier-${index}`, provider: 'openai-codex' }),
    );
    await startExtension(handle, modelContext({ models: { list: () => rows } }));

    await expect(handle.requestModelCatalog()).rejects.toMatchObject({
      code: 'omp_model_catalog_too_large',
    });
  });

  it('refuses a catalog result that names another session or run epoch', async () => {
    const handle = startBridge();
    const client = await openRawClient(handle.endpoint);
    rawClients.push(client);
    client.send({
      v: OMP_BRIDGE_PROTOCOL_VERSION,
      t: 'hello',
      sessionId: handle.sessionId,
      runEpoch: handle.runEpoch,
      nonce: handle.nonce,
    });
    await client.waitFor((frame) => frame['t'] === 'ack');

    const request = handle.requestModelCatalog();
    const asked = await client.waitFor((frame) => frame['t'] === 'models_request');
    client.send({
      v: OMP_BRIDGE_PROTOCOL_VERSION,
      t: 'models_result',
      id: asked['id'],
      sessionId: 'session-2',
      runEpoch: handle.runEpoch,
      ok: true,
      catalog: { models: [] },
    });

    await expect(request).rejects.toMatchObject({ code: 'omp_bridge_stale_run_identity' });
  });

  it('refuses the catalog when no native session is attached', async () => {
    const handle = startBridge();

    await expect(handle.requestModelCatalog()).rejects.toMatchObject({
      code: 'omp_bridge_disconnected',
    });
  });

  it('rejects every outstanding catalog request when the bridge is disposed', async () => {
    const handle = startBridge();
    // A peer that authenticates but never answers, so the only thing that can
    // end these reads is the bridge going away.
    const client = await openRawClient(handle.endpoint);
    rawClients.push(client);
    client.send({
      v: OMP_BRIDGE_PROTOCOL_VERSION,
      t: 'hello',
      sessionId: handle.sessionId,
      runEpoch: handle.runEpoch,
      nonce: handle.nonce,
    });
    await client.waitFor((frame) => frame['t'] === 'ack');

    const request = handle.requestModelCatalog();
    const rejected = expect(request).rejects.toMatchObject({ code: 'omp_bridge_disconnected' });
    await client.waitFor((frame) => frame['t'] === 'models_request');
    await handle.dispose();

    await rejected;
  });

  it('bounds the number of catalog requests held at once', async () => {
    const handle = startBridge();
    const client = await openRawClient(handle.endpoint);
    rawClients.push(client);
    client.send({
      v: OMP_BRIDGE_PROTOCOL_VERSION,
      t: 'hello',
      sessionId: handle.sessionId,
      runEpoch: handle.runEpoch,
      nonce: handle.nonce,
    });
    await client.waitFor((frame) => frame['t'] === 'ack');

    const held = Array.from({ length: OMP_BRIDGE_MAX_PENDING_MODEL_REQUESTS }, () =>
      handle.requestModelCatalog(),
    );
    const settled = Promise.all(
      held.map((request) => expect(request).resolves.toMatchObject({ models: [] })),
    );
    const last = handle.requestModelCatalog();

    await expect(last).rejects.toMatchObject({ code: 'omp_model_catalog_busy' });
    await waitFor(
      () =>
        client.frames.filter((candidate) => candidate['t'] === 'models_request').length ===
        OMP_BRIDGE_MAX_PENDING_MODEL_REQUESTS,
      'all held catalog requests to reach the peer',
    );

    // Release the held requests so the case leaves nothing pending.
    for (const frame of client.frames.filter((candidate) => candidate['t'] === 'models_request')) {
      client.send({
        v: OMP_BRIDGE_PROTOCOL_VERSION,
        t: 'models_result',
        id: frame['id'],
        sessionId: handle.sessionId,
        runEpoch: handle.runEpoch,
        ok: true,
        catalog: { models: [] },
      });
    }
    await settled;
  });

  it('refuses a catalog answer whose payload does not have the required shape', async () => {
    const handle = startBridge();
    const client = await openRawClient(handle.endpoint);
    rawClients.push(client);
    client.send({
      v: OMP_BRIDGE_PROTOCOL_VERSION,
      t: 'hello',
      sessionId: handle.sessionId,
      runEpoch: handle.runEpoch,
      nonce: handle.nonce,
    });
    await client.waitFor((frame) => frame['t'] === 'ack');

    // One row missing its modalities is enough to refuse the whole answer: a
    // catalog that dropped rows would read as "these are the models you have".
    const request = handle.requestModelCatalog();
    const asked = await client.waitFor((frame) => frame['t'] === 'models_request');
    client.send({
      v: OMP_BRIDGE_PROTOCOL_VERSION,
      t: 'models_result',
      id: asked['id'],
      sessionId: handle.sessionId,
      runEpoch: handle.runEpoch,
      ok: true,
      catalog: {
        models: [
          { id: 'p/good', provider: 'p', model: 'good', input: ['text'], configured: true },
          { id: 'p/nameless', provider: 'p', input: ['text'], configured: true },
        ],
      },
    });

    await expect(request).rejects.toMatchObject({ code: 'omp_model_catalog_malformed' });
  });

  it('surfaces the exact refusal the native runtime reported', async () => {
    const handle = startBridge();
    const client = await openRawClient(handle.endpoint);
    rawClients.push(client);
    client.send({
      v: OMP_BRIDGE_PROTOCOL_VERSION,
      t: 'hello',
      sessionId: handle.sessionId,
      runEpoch: handle.runEpoch,
      nonce: handle.nonce,
    });
    await client.waitFor((frame) => frame['t'] === 'ack');

    const request = handle.requestModelCatalog();
    const asked = await client.waitFor((frame) => frame['t'] === 'models_request');
    client.send({
      v: OMP_BRIDGE_PROTOCOL_VERSION,
      t: 'models_result',
      id: asked['id'],
      sessionId: handle.sessionId,
      runEpoch: handle.runEpoch,
      ok: false,
      error: { code: 'omp_model_capability_missing', message: 'no model query on this session' },
    });

    await expect(request).rejects.toMatchObject({
      code: 'omp_model_capability_missing',
      message: 'no model query on this session',
    });
  });
});

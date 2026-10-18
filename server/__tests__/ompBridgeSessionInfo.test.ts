/**
 * The live session description: what the running OMP session has loaded, read
 * from inside the OMP process over the real bridge. The ExtensionAPI seam is
 * faked with the registry shapes the installed OMP reports; the host and the
 * extension are the real modules over a real pipe.
 *
 * Also covered: a `read` of a `skill://` URL names its skill on the tool start
 * event, which is how skill use reaches the board.
 *
 * No case waits on a duration. Each one awaits an answered request or an event
 * the host has observed.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { OmpBridgeEvent, OmpBridgeHandle } from '../src/company/ompBridge.js';
import {
  createOmpBridge,
  OMP_BRIDGE_ENV,
  OMP_BRIDGE_MAX_PENDING_INFO_REQUESTS,
} from '../src/company/ompBridge.js';
import ompBridgeExtension from '../src/company/ompBridgeExtension.js';

// ── Fake OMP extension API ─────────────────────────────────────

type FakeHandler = (payload: unknown, ctx: FakeContext) => unknown;

interface FakeContext {
  readonly agent: { kind: string };
  readonly isIdle: () => boolean;
  readonly hasPendingMessages: () => boolean;
  readonly getAsyncJobSnapshot: () => { running: unknown[] };
  readonly sessionManager: { getSessionId(): string; getSessionFile(): string };
  readonly model?: { id: string; provider: string };
}

function fakeSchema(kind: string): unknown {
  const schema: Record<string, unknown> = { kind };
  for (const method of ['describe', 'optional', 'default', 'min']) schema[method] = () => schema;
  return schema;
}

class FakePi {
  readonly handlers = new Map<string, FakeHandler[]>();
  readonly logs: { level: string; args: unknown[] }[] = [];
  readonly zod = {
    string: () => fakeSchema('string'),
    number: () => fakeSchema('number'),
    boolean: () => fakeSchema('boolean'),
    array: () => fakeSchema('array'),
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

  // The registry the describe read reports. A case removes one method to model
  // an OMP build that does not expose its registry.
  activeTools: readonly string[] = [];
  allTools: readonly unknown[] = [];
  commands: readonly unknown[] = [];
  thinking: string | undefined;
  getActiveTools?: () => unknown = () => this.activeTools;
  getAllTools?: () => unknown = () => this.allTools;
  getCommands?: () => unknown = () => this.commands;
  getThinkingLevel?: () => unknown = () => this.thinking;

  registerTool(): void {
    // The describe cases register no tools of their own.
  }

  on(event: string, handler: FakeHandler): void {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
  }

  sendUserMessage(): void {
    // Not used by these cases.
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

function makeContext(model?: { id: string; provider: string }): FakeContext {
  return {
    agent: { kind: 'main' },
    isIdle: () => true,
    hasPendingMessages: () => false,
    getAsyncJobSnapshot: () => ({ running: [] }),
    sessionManager: {
      getSessionId: () => 'native-session-1',
      getSessionFile: () => '/workspace/.company/sessions/native-session-1.jsonl',
    },
    ...(model === undefined ? {} : { model }),
  };
}

/** The `code` an OMP bridge refusal carries, or undefined for any other rejection. */
function refusalCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}

// ── Async helpers ──────────────────────────────────────────────

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

/**
 * A promise settled from outside. The executor is the only promise constructor
 * here: the server tsconfig targets ES2022, which has no `Promise.withResolvers`.
 */
function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

interface EventWaiter {
  readonly match: (event: OmpBridgeEvent) => boolean;
  readonly settle: (event: OmpBridgeEvent) => void;
}

// ── Test harness ───────────────────────────────────────────────

describe('omp session description', () => {
  let socketDir: string;
  let bridge: OmpBridgeHandle | undefined;
  let events: OmpBridgeEvent[] = [];
  let waiters: EventWaiter[] = [];

  beforeEach(() => {
    socketDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-session-info-'));
    events = [];
    waiters = [];
  });

  afterEach(async () => {
    await bridge?.dispose();
    bridge = undefined;
    fs.rmSync(socketDir, { recursive: true, force: true });
    for (const key of Object.values(OMP_BRIDGE_ENV)) delete process.env[key];
  });

  function observe(event: OmpBridgeEvent): void {
    events.push(event);
    const matched = waiters.filter((waiter) => waiter.match(event));
    waiters = waiters.filter((waiter) => !matched.includes(waiter));
    for (const waiter of matched) waiter.settle(event);
  }

  /** Resolves with the first observed event that matches: one already seen, or the next one. */
  function awaitEvent(match: (event: OmpBridgeEvent) => boolean): Promise<OmpBridgeEvent> {
    const seen = events.find(match);
    if (seen !== undefined) return Promise.resolve(seen);
    const waiter = deferred<OmpBridgeEvent>();
    waiters.push({ match, settle: waiter.resolve });
    return waiter.promise;
  }

  function startBridge(): OmpBridgeHandle {
    const handle = createOmpBridge({
      sessionId: 'session-1',
      runEpoch: 3,
      role: 'worker',
      socketDir,
      rpcHandler: async () => ({ allow: true }),
    });
    handle.onEvent(observe);
    bridge = handle;
    return handle;
  }

  /**
   * Load the real extension against this registry and start its session.
   *
   * The host writes the acknowledgement before it settles `ready`, and frames on
   * one socket are read in order, so a describe request written after `ready`
   * is read after the extension authenticates. Its answer is the gate.
   */
  async function startExtension(
    handle: OmpBridgeHandle,
    pi: FakePi,
    ctx: FakeContext,
  ): Promise<void> {
    Object.assign(process.env, handle.childEnv);
    ompBridgeExtension(pi as unknown as never);
    await handle.ready;
    await pi.emit('session_start', { type: 'session_start' }, ctx);
    await handle.requestSessionInfo();
  }

  it('describes the live session: working directory, model, thinking, session file, tools and skills', async () => {
    const handle = startBridge();
    const pi = new FakePi();
    pi.allTools = [
      { name: 'read', sourceInfo: { source: 'builtin' } },
      { name: 'mcp__github_search', sourceInfo: { source: 'mcp' } },
      { name: 'ask', sourceInfo: { source: 'extension' } },
    ];
    pi.activeTools = ['read', 'ask'];
    pi.commands = [
      { name: 'skill:brand', source: 'skill', description: 'Brand voice' },
      { name: 'compact', source: 'builtin' },
    ];
    pi.thinking = 'high';
    await startExtension(handle, pi, makeContext({ id: 'gpt-6-luna', provider: 'openai-codex' }));

    const info = await handle.requestSessionInfo();

    expect(info).toEqual({
      cwd: process.cwd(),
      model: 'openai-codex/gpt-6-luna',
      thinking: 'high',
      sessionFile: '/workspace/.company/sessions/native-session-1.jsonl',
      tools: [
        { name: 'read', source: 'builtin', active: true },
        { name: 'mcp__github_search', source: 'mcp', mcpServer: 'github', active: false },
        { name: 'ask', source: 'extension', active: true },
      ],
      skills: [{ name: 'brand', description: 'Brand voice' }],
    });
  });

  it('names the skill on a skill:// read start event and leaves other reads unnamed', async () => {
    const handle = startBridge();
    const pi = new FakePi();
    const ctx = makeContext();
    await startExtension(handle, pi, ctx);

    await pi.emit(
      'tool_execution_start',
      { toolName: 'read', toolCallId: 'read-skill', args: { path: 'skill://brand/SKILL.md' } },
      ctx,
    );
    await pi.emit(
      'tool_execution_start',
      { toolName: 'read', toolCallId: 'read-file', args: { path: 'src/app.ts' } },
      ctx,
    );
    const plain = await awaitEvent(
      (event) => event.k === 'tool' && event.toolCallId === 'read-file',
    );

    expect(events).toContainEqual(
      expect.objectContaining({
        k: 'tool',
        phase: 'start',
        toolCallId: 'read-skill',
        toolName: 'read',
        skill: 'brand',
      }),
    );
    expect(plain).not.toHaveProperty('skill');
  });

  it('reports an OMP build without a tool registry as unavailable rather than as an empty list', async () => {
    const handle = startBridge();
    const pi = new FakePi();
    const ctx = makeContext();
    await startExtension(handle, pi, ctx);
    pi.getAllTools = undefined;

    await expect(handle.requestSessionInfo()).rejects.toMatchObject({
      code: 'omp_session_info_unavailable',
    });
  });

  it('bounds describe reads in flight and refuses the one beyond the bound', async () => {
    const handle = startBridge();
    await startExtension(handle, new FakePi(), makeContext());

    // The bound is checked before each write, so every call is issued before
    // any answer can arrive.
    const reads = Array.from({ length: OMP_BRIDGE_MAX_PENDING_INFO_REQUESTS + 1 }, () =>
      handle.requestSessionInfo().then(
        () => 'answered',
        (error: unknown) => refusalCode(error),
      ),
    );

    const outcomes = await Promise.all(reads);
    expect(outcomes.slice(0, OMP_BRIDGE_MAX_PENDING_INFO_REQUESTS)).toEqual(
      Array.from({ length: OMP_BRIDGE_MAX_PENDING_INFO_REQUESTS }, () => 'answered'),
    );
    expect(outcomes[OMP_BRIDGE_MAX_PENDING_INFO_REQUESTS]).toBe('omp_session_info_busy');
  });
});

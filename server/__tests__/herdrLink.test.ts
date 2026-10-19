import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { HerdrAgentsMessage, HerdrKey, HerdrScreenMessage } from '../../core/src/messages.js';
import type { HerdrGitRunner, HerdrLink, HerdrScheduler } from '../src/herdr/herdrLink.js';
import {
  createHerdrLink,
  HERDR_MAX_KEYS,
  HERDR_PROMPT_MAX_BYTES,
  herdrEndpoint,
  HerdrError,
  isHerdrKey,
  isHerdrPaneId,
  resolveHerdrSocketPath,
} from '../src/herdr/herdrLink.js';

type Handler = (params: Record<string, unknown>) => unknown;

/** herdr sends a pushed event under its wire name, which differs from its subscription name. */
const WIRE_EVENT_NAMES: Readonly<Record<string, string>> = { 'pane.updated': 'pane_updated' };

interface RecordedRequest {
  readonly method: string;
  readonly params: Record<string, unknown>;
}

interface RequestLine {
  readonly id: string;
  readonly method: string;
  readonly params: Record<string, unknown>;
}

interface SubscriptionSpec {
  readonly type: string;
}

/** Fails a fake herdr call with a wire error code. */
class ReplyError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

/**
 * Stand-in for herdr's socket: newline-delimited JSON over a real named pipe
 * (Windows) or unix socket. Every request is recorded so tests can assert on
 * the wire parameters the link sends.
 */
class FakeHerdr {
  readonly endpoint: string =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\omp-herdr-test-${randomUUID()}`
      : path.join(os.tmpdir(), `omp-herdr-test-${randomUUID()}.sock`);
  readonly requests: RecordedRequest[] = [];
  private readonly replies = new Map<string, Handler>();
  private readonly open = new Set<net.Socket>();
  /** Live `events.subscribe` streams, keyed by socket, holding the subscribed event types. */
  private readonly subscribers = new Map<net.Socket, readonly string[]>();
  private readonly waiters = new Set<() => void>();
  private readonly server = net.createServer((socket: net.Socket) => this.accept(socket));

  constructor() {
    this.reply('ping', () => ({ type: 'pong', version: '0.9.5', protocol: 22, capabilities: [] }));
    this.reply('agent.list', () => ({ agents: [] }));
    this.reply('workspace.list', () => ({ type: 'workspace_list', workspaces: [] }));
    this.reply('agent.prompt', () => ({ type: 'ok' }));
    this.reply('agent.send_keys', () => ({ type: 'ok' }));
    this.reply('agent.focus', () => ({ type: 'ok' }));
  }

  get subscriberCount(): number {
    return this.subscribers.size;
  }

  get openCount(): number {
    return this.open.size;
  }

  listen(): Promise<void> {
    const { promise, resolve } = deferred<void>();
    this.server.listen(this.endpoint, () => resolve());
    return promise;
  }

  close(): Promise<void> {
    const { promise, resolve } = deferred<void>();
    for (const socket of this.open) socket.destroy();
    this.server.close(() => resolve());
    return promise;
  }

  reply(method: string, handler: Handler): void {
    this.replies.set(method, handler);
  }

  requestsTo(method: string): RecordedRequest[] {
    return this.requests.filter((request) => request.method === method);
  }

  /** Resolves once `predicate` holds; checked now and after every request or stream change. */
  until(predicate: () => boolean): Promise<void> {
    const { promise, resolve } = deferred<void>();
    const check = (): void => {
      if (!predicate()) return;
      this.waiters.delete(check);
      resolve();
    };
    this.waiters.add(check);
    check();
    return promise;
  }

  /** Pushes a `{event, data}` line to every stream subscribed to `event`. */
  push(event: string, data: unknown): void {
    this.write(event, { event, data });
  }

  /** Sends the `subscription_started` acknowledgement herdr emits when a stream starts. */
  startSubscription(event: string): void {
    this.write(event, { id: 'subscribe', result: { type: 'subscription_started' } });
  }

  /** Simulates herdr dropping every live subscription stream. */
  dropSubscribers(): void {
    for (const socket of this.subscribers.keys()) socket.destroy();
  }

  private accept(socket: net.Socket): void {
    this.open.add(socket);
    let buffered = '';
    socket.on('error', () => undefined);
    socket.on('close', () => {
      this.open.delete(socket);
      this.subscribers.delete(socket);
      this.notify();
    });
    socket.on('data', (chunk: Buffer) => {
      buffered += chunk.toString('utf8');
      for (let newline = buffered.indexOf('\n'); newline !== -1; newline = buffered.indexOf('\n')) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        this.handle(socket, JSON.parse(line) as RequestLine);
      }
    });
  }

  private handle(socket: net.Socket, request: RequestLine): void {
    this.requests.push({ method: request.method, params: request.params });
    this.notify();
    if (request.method === 'events.subscribe') {
      const subscriptions = request.params.subscriptions as SubscriptionSpec[];
      this.subscribers.set(
        socket,
        subscriptions.map((subscription) => subscription.type),
      );
      socket.write(encode({ id: request.id, result: { type: 'subscription_started' } }));
      this.notify();
      return;
    }
    const handler = this.replies.get(request.method);
    if (handler === undefined) {
      socket.end(
        encode({ id: request.id, error: { code: 'invalid_request', message: 'unknown method' } }),
      );
      return;
    }
    const fail = (error: unknown): void => {
      const code = error instanceof ReplyError ? error.code : 'invalid_request';
      socket.end(encode({ id: request.id, error: { code, message: code } }));
    };
    try {
      // A handler may return a promise; its reply is sent once the promise settles.
      void Promise.resolve(handler(request.params)).then(
        (result: unknown) => socket.end(encode({ id: request.id, result })),
        fail,
      );
    } catch (error) {
      fail(error);
    }
  }

  private write(event: string, line: unknown): void {
    for (const [socket, types] of this.subscribers) {
      const delivered = types.some((type) => type === event || WIRE_EVENT_NAMES[type] === event);
      if (delivered) socket.write(encode(line));
    }
  }

  private notify(): void {
    for (const check of [...this.waiters]) check();
  }
}

/** Stand-in for `git -C <cwd> rev-parse ...`: answers per cwd and records every call. */
class FakeGit {
  readonly calls: { readonly cwd: string; readonly args: readonly string[] }[] = [];
  private readonly answers = new Map<string, () => Promise<string>>();

  readonly run: HerdrGitRunner = (cwd, args) => {
    this.calls.push({ cwd, args });
    const answer = this.answers.get(cwd);
    return answer === undefined ? Promise.reject(new Error('not a git repository')) : answer();
  };

  /** Answers `git` run in `cwd` with this stdout. */
  checkout(cwd: string, stdout: string): void {
    this.respond(cwd, () => Promise.resolve(stdout));
  }

  /** Answers `git` run in `cwd` however a test needs: a failure, or a reply held open. */
  respond(cwd: string, reply: () => Promise<string>): void {
    this.answers.set(cwd, reply);
  }

  callsIn(cwd: string): number {
    return this.calls.filter((call) => call.cwd === cwd).length;
  }
}

/** Deferred; `Promise.withResolvers` needs a newer lib than this project targets. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function encode(line: unknown): string {
  return `${JSON.stringify(line)}\n`;
}

interface ScheduledCallback {
  readonly delayMs: number;
  readonly callback: () => void;
  cancelled: boolean;
}

interface ScheduleObserver {
  readonly delayMs: number;
  readonly resolve: () => void;
}

/** Holds scheduled callbacks until a test fires them, so no test waits on real time. */
class ManualScheduler implements HerdrScheduler {
  private live: ScheduledCallback[] = [];
  private observers: ScheduleObserver[] = [];
  private idleObservers: ScheduleObserver[] = [];

  schedule(callback: () => void, delayMs: number): () => void {
    const entry: ScheduledCallback = { delayMs, callback, cancelled: false };
    this.live.push(entry);
    const matched = this.observers.filter((observer) => observer.delayMs === delayMs);
    this.observers = this.observers.filter((observer) => observer.delayMs !== delayMs);
    for (const observer of matched) observer.resolve();
    return () => {
      entry.cancelled = true;
      this.settleIdle();
    };
  }

  /** Resolves on the next `schedule` call with this delay; event ordering, not elapsed time. */
  whenScheduled(delayMs: number): Promise<void> {
    const { promise, resolve } = deferred<void>();
    this.observers.push({ delayMs, resolve });
    return promise;
  }

  /** Resolves once no callback with this delay is live; event ordering, not elapsed time. */
  whenIdle(delayMs: number): Promise<void> {
    const { promise, resolve } = deferred<void>();
    this.idleObservers.push({ delayMs, resolve });
    this.settleIdle();
    return promise;
  }

  private settleIdle(): void {
    const idle = this.idleObservers.filter((observer) => this.liveCount(observer.delayMs) === 0);
    this.idleObservers = this.idleObservers.filter((observer) => !idle.includes(observer));
    for (const observer of idle) observer.resolve();
  }

  liveCount(delayMs: number): number {
    return this.live.filter((entry) => entry.delayMs === delayMs && !entry.cancelled).length;
  }

  /** Runs the live callbacks registered with this delay; callbacks may schedule or cancel more. */
  fire(delayMs: number): void {
    const due = this.live.filter((entry) => entry.delayMs === delayMs && !entry.cancelled);
    this.live = this.live.filter((entry) => entry.delayMs !== delayMs && !entry.cancelled);
    for (const entry of due) {
      if (!entry.cancelled) entry.callback();
    }
    this.settleIdle();
  }
}

function agentInfo(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    pane_id: 'wA:p2',
    workspace_id: 'wA',
    agent: 'omp',
    agent_status: 'working',
    name: 'omp',
    terminal_title: 'omp',
    terminal_title_stripped: 'omp',
    cwd: 'C:/repo',
    focused: true,
    ...overrides,
  };
}

function paneRead(text: string, format = 'text'): Record<string, unknown> {
  return {
    type: 'pane_read',
    read: {
      pane_id: 'wA:p3',
      workspace_id: 'wA',
      tab_id: 'wA:t1',
      source: 'recent_unwrapped',
      format,
      text,
      revision: 1,
      truncated: false,
    },
  };
}

/** The payload of a `pane.updated` event: the pane and the revision its screen has reached. */
function paneUpdated(paneId: string, revision: number): Record<string, unknown> {
  return { pane: { pane_id: paneId, revision } };
}

/** A `workspace.list` entry with the fields herdr sends for a workspace. */
function workspaceInfo(workspaceId: string, label: string): Record<string, unknown> {
  return {
    workspace_id: workspaceId,
    label,
    number: 1,
    focused: false,
    pane_count: 1,
    tab_count: 1,
    active_tab_id: `${workspaceId}:t1`,
    agent_status: 'idle',
  };
}

/** Resolves with the next roster the link publishes that satisfies `accept`. */
function nextAgents(
  link: HerdrLink,
  accept: (message: HerdrAgentsMessage) => boolean = () => true,
): Promise<HerdrAgentsMessage> {
  const { promise, resolve } = deferred<HerdrAgentsMessage>();
  const unsubscribe = link.onAgents((message) => {
    if (!accept(message)) return;
    unsubscribe();
    resolve(message);
  });
  return promise;
}

/** Resolves with the next screen update the link emits that satisfies `accept`. */
function nextScreen(
  link: HerdrLink,
  accept: (message: HerdrScreenMessage) => boolean = () => true,
): Promise<HerdrScreenMessage> {
  const { promise, resolve } = deferred<HerdrScreenMessage>();
  const unsubscribe = link.onScreen((message) => {
    if (!accept(message)) return;
    unsubscribe();
    resolve(message);
  });
  return promise;
}

/** Resolves with the HerdrError a call rejects with; any other outcome fails the test. */
async function herdrFailure(task: Promise<unknown>): Promise<HerdrError> {
  try {
    await task;
  } catch (error) {
    if (error instanceof HerdrError) return error;
    throw error;
  }
  throw new Error('expected herdr to reject');
}

/** Runs `body` in a fresh temporary directory that is removed afterwards. */
async function withTempDir(body: (dir: string) => Promise<void>): Promise<void> {
  const dir = path.join(os.tmpdir(), `omp-herdr-${randomUUID()}`);
  try {
    await body(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/** Writes an omp transcript as JSON lines and returns the file's absolute path. */
async function writeTranscript(
  dir: string,
  entries: readonly Record<string, unknown>[],
): Promise<string> {
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, 'session.jsonl');
  await fs.writeFile(file, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
  return file;
}

/** A `pane.process_info` result whose foreground group holds the given processes. */
function processInfo(processes: readonly Record<string, unknown>[]): Record<string, unknown> {
  return {
    type: 'pane_process_info',
    process_info: {
      foreground_process_group_id: 1,
      foreground_processes: processes,
      shell_pid: 1,
      pane_id: 'wA:p2',
    },
  };
}

describe('herdr socket resolution', () => {
  it('prefers HERDR_SOCKET_PATH over the session and default locations', () => {
    expect(
      resolveHerdrSocketPath(
        { HERDR_SOCKET_PATH: 'C:\\custom\\herdr.sock', HERDR_SESSION: 'dev' },
        'win32',
        'C:\\Users\\me',
      ),
    ).toBe('C:\\custom\\herdr.sock');
  });

  it('places a named session under the configuration directory', () => {
    expect(resolveHerdrSocketPath({ HERDR_SESSION: 'dev', APPDATA: 'C:\\Roaming' }, 'win32')).toBe(
      'C:\\Roaming\\herdr\\sessions\\dev\\herdr.sock',
    );
  });

  it('uses the Windows default under APPDATA and ~/.config elsewhere', () => {
    expect(resolveHerdrSocketPath({ APPDATA: 'C:\\Roaming' }, 'win32')).toBe(
      'C:\\Roaming\\herdr\\herdr.sock',
    );
    expect(resolveHerdrSocketPath({}, 'linux', '/home/me')).toBe(
      '/home/me/.config/herdr/herdr.sock',
    );
  });

  it('prefixes Windows socket paths as named pipes exactly once', () => {
    expect(herdrEndpoint('C:\\Users\\me\\herdr.sock', 'win32')).toBe(
      '\\\\.\\pipe\\C:\\Users\\me\\herdr.sock',
    );
    expect(herdrEndpoint('\\\\.\\pipe\\already', 'win32')).toBe('\\\\.\\pipe\\already');
    expect(herdrEndpoint('/tmp/herdr.sock', 'linux')).toBe('/tmp/herdr.sock');
  });
});

describe('herdr pane ids and keys', () => {
  it('accepts only herdr pane ids', () => {
    expect(isHerdrPaneId('wA:p2')).toBe(true);
    expect(isHerdrPaneId('wA:p2; rm -rf')).toBe(false);
    expect(isHerdrPaneId('wA')).toBe(false);
    expect(isHerdrPaneId(42)).toBe(false);
  });

  it('accepts the key names the board may send and nothing inherited from Object', () => {
    expect(isHerdrKey('ctrl+c')).toBe(true);
    expect(isHerdrKey('y')).toBe(true);
    expect(isHerdrKey('ctrl+d')).toBe(false);
    expect(isHerdrKey('toString')).toBe(false);
  });
});

describe('HerdrLink against a herdr socket', () => {
  let fake: FakeHerdr;
  let scheduler: ManualScheduler;
  let link: HerdrLink;
  let git: FakeGit;

  beforeEach(async () => {
    fake = new FakeHerdr();
    await fake.listen();
    scheduler = new ManualScheduler();
    git = new FakeGit();
    link = createHerdrLink({ socketPath: fake.endpoint, scheduler, runGit: git.run });
  });

  afterEach(async () => {
    link.stop();
    await fake.close();
  });

  it('publishes the roster after the ping and agent.list handshake', async () => {
    fake.reply('agent.list', () => ({
      agents: [
        agentInfo({
          terminal_title: 'π Đang sửa lỗi',
          terminal_title_stripped: 'Đang sửa lỗi',
          agent_status: 'working',
        }),
      ],
    }));
    const roster = nextAgents(link, (message) => message.available);

    link.start();

    expect(await roster).toEqual({
      type: 'herdrAgents',
      available: true,
      agents: [
        {
          paneId: 'wA:p2',
          workspaceId: 'wA',
          kind: 'omp',
          status: 'working',
          name: 'omp',
          title: 'Đang sửa lỗi',
          cwd: 'C:/repo',
          focused: true,
        },
      ],
      sleeping: [],
    });
    expect(link.snapshot().available).toBe(true);
  });

  it('maps unknown statuses to unknown and skips entries without a pane id', async () => {
    fake.reply('agent.list', () => ({
      agents: [agentInfo({ agent_status: 'mystery' }), { agent: 'omp', workspace_id: 'wA' }],
    }));
    const roster = nextAgents(link, (message) => message.available);

    link.start();

    const message = await roster;
    expect(message.agents).toHaveLength(1);
    expect(message.agents[0]?.status).toBe('unknown');
  });

  it('refreshes the roster from status events after subscribing to pane status', async () => {
    fake.reply('agent.list', () => ({ agents: [agentInfo()] }));
    const roster = nextAgents(link, (message) => message.available);
    const firstRefresh = scheduler.whenScheduled(150);

    link.start();
    await roster;
    // subscription_started schedules the first reconcile.
    await firstRefresh;

    const subscriptions = fake.requestsTo('events.subscribe')[0]?.params.subscriptions;
    expect(subscriptions).toContainEqual({ type: 'pane.agent_status_changed', pane_id: 'wA:p2' });
    expect(subscriptions).toContainEqual({ type: 'pane.created' });

    fake.reply('agent.list', () => ({ agents: [agentInfo({ agent_status: 'blocked' })] }));
    const blocked = nextAgents(link, (message) => message.agents[0]?.status === 'blocked');
    scheduler.fire(150);
    expect((await blocked).agents[0]?.status).toBe('blocked');

    const eventRefresh = scheduler.whenScheduled(150);
    fake.reply('agent.list', () => ({ agents: [agentInfo({ agent_status: 'done' })] }));
    fake.push('pane.agent_status_changed', { pane_id: 'wA:p2', agent_status: 'done' });
    await eventRefresh;
    const done = nextAgents(link, (message) => message.agents[0]?.status === 'done');
    scheduler.fire(150);

    expect((await done).agents[0]?.status).toBe('done');
    expect(fake.requestsTo('events.subscribe')).toHaveLength(1);
  });

  it('reports herdr unavailable when the stream drops, then reconnects on the scheduled retry', async () => {
    const roster = nextAgents(link, (message) => message.available);
    link.start();
    await roster;
    await fake.until(() => fake.subscriberCount === 1);

    const retry = scheduler.whenScheduled(1000);
    const dropped = nextAgents(link, (message) => !message.available);
    fake.dropSubscribers();

    expect((await dropped).agents).toEqual([]);
    await retry;

    const back = nextAgents(link, (message) => message.available);
    scheduler.fire(1000);

    expect((await back).available).toBe(true);
    expect(fake.requestsTo('ping')).toHaveLength(2);
  });

  it('reports an unreachable socket in Vietnamese', async () => {
    const missing = createHerdrLink({
      socketPath: path.join(os.tmpdir(), `omp-herdr-missing-${randomUUID()}.sock`),
      scheduler,
    });
    const unreachable = nextAgents(missing, (message) => !message.available);

    missing.start();

    expect((await unreachable).reason).toBe(
      'Không kết nối được tới herdr. Kiểm tra herdr đã chạy.',
    );
    missing.stop();
  });

  it('refuses a herdr protocol it does not speak before listing agents', async () => {
    fake.reply('ping', () => ({ type: 'pong', version: '0.8.0', protocol: 21, capabilities: [] }));
    const refused = nextAgents(link, (message) => !message.available);

    link.start();

    expect((await refused).reason).toBe('Giao thức herdr không khớp (herdr báo 21, board cần 22).');
    expect(fake.requestsTo('agent.list')).toHaveLength(0);
  });

  it('cancels reconnects and closes the stream on stop', async () => {
    const roster = nextAgents(link, (message) => message.available);
    link.start();
    await roster;
    await fake.until(() => fake.subscriberCount === 1);
    const dropped = nextAgents(link, (message) => !message.available);
    fake.dropSubscribers();
    await dropped;
    expect(scheduler.liveCount(1000)).toBe(1);

    link.stop();

    expect(scheduler.liveCount(1000)).toBe(0);
  });

  it('reads a bounded window of pane text with the agreed wire parameters', async () => {
    fake.reply('agent.read', () => paneRead('dòng một\ndòng hai'));

    const screen = await link.read('wA:p3', 50);

    expect(fake.requestsTo('agent.read')[0]?.params).toEqual({
      target: 'wA:p3',
      source: 'recent_unwrapped',
      lines: 50,
      format: 'ansi',
    });
    expect(screen).toEqual({
      type: 'herdrScreen',
      paneId: 'wA:p3',
      text: 'dòng một\ndòng hai',
      at: expect.any(String),
    });
  });

  it('keeps SGR colour escapes in the text it reads', async () => {
    const coloured = '\u001b[31mđỏ\u001b[0m\r\nxanh';
    fake.reply('agent.read', () => paneRead(coloured, 'ansi'));

    const screen = await link.read('wA:p3', 50);

    expect(fake.requestsTo('agent.read')[0]?.params).toEqual({
      target: 'wA:p3',
      source: 'recent_unwrapped',
      lines: 50,
      format: 'ansi',
    });
    expect(screen.text).toBe(coloured);
  });

  it('rejects an out-of-range line count or malformed pane id without contacting herdr', async () => {
    expect((await herdrFailure(link.read('wA:p3', 0))).code).toBe('invalid_request');
    expect((await herdrFailure(link.read('wA:p3', 2001))).code).toBe('invalid_request');
    expect((await herdrFailure(link.read('wA p3', 10))).code).toBe('invalid_request');
    expect(fake.requests).toHaveLength(0);
  });

  it('sends prompt text to the pane as one agent.prompt', async () => {
    await link.prompt('wA:p2', 'tiếp tục đi');

    expect(fake.requestsTo('agent.prompt')).toEqual([
      { method: 'agent.prompt', params: { target: 'wA:p2', text: 'tiếp tục đi' } },
    ]);
  });

  it('rejects blank or oversized prompts without contacting herdr', async () => {
    expect((await herdrFailure(link.prompt('wA:p2', '   '))).code).toBe('invalid_request');
    expect(
      (await herdrFailure(link.prompt('wA:p2', 'x'.repeat(HERDR_PROMPT_MAX_BYTES + 1)))).code,
    ).toBe('invalid_request');
    expect(fake.requests).toHaveLength(0);
  });

  it('maps a blocked agent to agent_blocked after exactly one attempt', async () => {
    fake.reply('agent.prompt', () => {
      throw new ReplyError('agent_blocked');
    });

    const failure = await herdrFailure(link.prompt('wA:p2', 'tiếp tục'));

    expect(failure.code).toBe('agent_blocked');
    expect(failure.message).toBe(
      'Agent đang chờ xác nhận (blocked). Hãy xem màn hình rồi trả lời bằng phím.',
    );
    expect(fake.requestsTo('agent.prompt')).toHaveLength(1);
  });

  it('sends only known, bounded key sequences', async () => {
    await link.keys('wA:p2', ['down', 'enter']);

    expect(fake.requestsTo('agent.send_keys')[0]?.params).toEqual({
      target: 'wA:p2',
      keys: ['down', 'enter'],
    });
    expect((await herdrFailure(link.keys('wA:p2', ['down', 'delete' as HerdrKey]))).code).toBe(
      'invalid_request',
    );
    expect((await herdrFailure(link.keys('wA:p2', []))).code).toBe('invalid_request');
    expect(
      (
        await herdrFailure(
          link.keys(
            'wA:p2',
            Array.from({ length: HERDR_MAX_KEYS + 1 }, () => 'down' as const),
          ),
        )
      ).code,
    ).toBe('invalid_request');
    expect(fake.requestsTo('agent.send_keys')).toHaveLength(1);
  });

  it('focuses a pane and maps a vanished pane to agent_not_found', async () => {
    await link.focus('wA:p2');
    expect(fake.requestsTo('agent.focus')[0]?.params).toEqual({ target: 'wA:p2' });

    fake.reply('agent.focus', () => {
      throw new ReplyError('pane_not_found');
    });
    expect((await herdrFailure(link.focus('wA:p9'))).code).toBe('agent_not_found');
  });

  /** Opens a screen watch and waits for its first frame and the stream's resync read. */
  async function openScreenWatch(paneId: string): Promise<void> {
    const frame = nextScreen(link, (message) => message.paneId === paneId);
    link.watch(paneId, true);
    await frame;
    // The first watch re-reads its pane once the shared stream starts, so two reads reach herdr.
    await fake.until(() => fake.requestsTo('agent.read').length === 2);
  }

  it('reads a pane without opening a screen watch', async () => {
    fake.reply('agent.read', () => paneRead('T0'));

    expect((await link.read('wA:p3', 20)).text).toBe('T0');
    expect(fake.requestsTo('agent.read')).toHaveLength(1);
    expect(fake.requestsTo('events.subscribe')).toHaveLength(0);
    expect(scheduler.liveCount(30_000)).toBe(0);
  });

  it('emits the first frame and shares one pane.updated stream across two panes', async () => {
    fake.reply('agent.read', () => paneRead('T0'));
    const first = nextScreen(link, (message) => message.paneId === 'wA:p3');
    const second = nextScreen(link, (message) => message.paneId === 'wA:p4');

    link.watch('wA:p3', true);
    link.watch('wA:p4', true);

    expect((await first).text).toBe('T0');
    expect((await second).text).toBe('T0');
    await fake.until(() => fake.subscriberCount === 1);
    const subscribes = fake.requestsTo('events.subscribe');
    expect(subscribes).toHaveLength(1);
    expect(subscribes[0]?.params).toEqual({ subscriptions: [{ type: 'pane.updated' }] });
  });

  it('reads nothing for an update to a pane that is not watched', async () => {
    fake.reply('agent.read', () => paneRead('T0'));
    await openScreenWatch('wA:p3');
    fake.reply('agent.read', () => paneRead('T1'));
    const changed = nextScreen(link, (message) => message.text === 'T1');

    fake.push('pane_updated', paneUpdated('wA:p9', 5));
    fake.push('pane_updated', paneUpdated('wA:p3', 2));
    await changed;

    // The unwatched pane's update is handled before the watched one's read emits, so no third
    // read can come from it.
    expect(fake.requestsTo('agent.read')).toHaveLength(3);
  });

  it('reads once for each new revision and never for a repeated one', async () => {
    fake.reply('agent.read', () => paneRead('T0'));
    await openScreenWatch('wA:p3');

    fake.push('pane_updated', paneUpdated('wA:p3', 2));
    await fake.until(() => fake.requestsTo('agent.read').length === 3);

    // The repeated revision must not mark the open window dirty.
    fake.push('pane_updated', paneUpdated('wA:p3', 2));
    // The stream restart is written after that update, so its resync read shows it was handled.
    fake.startSubscription('pane.updated');
    await fake.until(() => fake.requestsTo('agent.read').length === 4);

    scheduler.fire(120);
    expect(scheduler.liveCount(120)).toBe(0);
  });

  it('emits nothing when a new revision leaves the text unchanged', async () => {
    const updates: string[] = [];
    link.onScreen((message) => updates.push(message.text));
    fake.reply('agent.read', () => paneRead('T0'));
    await openScreenWatch('wA:p3');

    // The same text under a new revision reads the pane but emits nothing.
    fake.push('pane_updated', paneUpdated('wA:p3', 2));
    await fake.until(() => fake.requestsTo('agent.read').length === 3);
    scheduler.fire(120);

    fake.reply('agent.read', () => paneRead('T1'));
    const changed = nextScreen(link, (message) => message.text === 'T1');
    fake.push('pane_updated', paneUpdated('wA:p3', 3));
    await changed;

    expect(updates).toEqual(['T0', 'T1']);
  });

  it('coalesces updates inside one throttle window into a single trailing read', async () => {
    const updates: string[] = [];
    link.onScreen((message) => updates.push(message.text));
    fake.reply('agent.read', () => paneRead('T0'));
    await openScreenWatch('wA:p3');

    // The first update reads at once and opens the throttle window.
    fake.reply('agent.read', () => paneRead('T1'));
    const leading = nextScreen(link, (message) => message.text === 'T1');
    fake.push('pane_updated', paneUpdated('wA:p3', 2));
    await leading;

    // Inside the open window these updates only mark the screen dirty and trigger no read.
    fake.reply('agent.read', () => paneRead('T2'));
    fake.push('pane_updated', paneUpdated('wA:p3', 3));
    fake.push('pane_updated', paneUpdated('wA:p3', 4));
    // The stream restart follows those updates; its resync read is unthrottled.
    const restarted = nextScreen(link, (message) => message.text === 'T2');
    fake.startSubscription('pane.updated');
    await restarted;
    expect(fake.requestsTo('agent.read')).toHaveLength(4);

    // The window ends with the screen changed since its last read: one trailing read.
    fake.reply('agent.read', () => paneRead('T3'));
    const trailing = nextScreen(link, (message) => message.text === 'T3');
    scheduler.fire(120);
    expect((await trailing).text).toBe('T3');
    expect(fake.requestsTo('agent.read')).toHaveLength(5);
    expect(updates).toEqual(['T0', 'T1', 'T2', 'T3']);
  });

  it('drops a read reply that arrives after a newer read was emitted', async () => {
    const updates: string[] = [];
    link.onScreen((message) => updates.push(message.text));
    fake.reply('agent.read', () => paneRead('T0'));
    await openScreenWatch('wA:p3');

    // The next read is the older one: its reply is held until the newer read has been emitted.
    const held = deferred<Record<string, unknown>>();
    fake.reply('agent.read', () => held.promise);
    fake.push('pane_updated', paneUpdated('wA:p3', 2));
    await fake.until(() => fake.requestsTo('agent.read').length === 3);

    fake.reply('agent.read', () => paneRead('T2'));
    const newer = nextScreen(link, (message) => message.text === 'T2');
    fake.startSubscription('pane.updated');
    await newer;

    // Only the event stream and the held read stay open. Once the older reply's socket closes,
    // the link has read that reply and dropped it.
    await fake.until(() => fake.openCount === 2);
    held.resolve(paneRead('T1'));
    await fake.until(() => fake.openCount === 1);

    expect(updates).toEqual(['T0', 'T2']);
  });

  it('closes a screen watch 30 seconds after it was opened', async () => {
    fake.reply('agent.read', () => paneRead('T0'));
    await openScreenWatch('wA:p3');

    scheduler.fire(30_000);
    await fake.until(() => fake.subscriberCount === 0);
  });

  it('renews a screen watch lease when the pane is watched again', async () => {
    fake.reply('agent.read', () => paneRead('T0'));
    await openScreenWatch('wA:p3');

    const renewed = scheduler.whenScheduled(30_000);
    link.watch('wA:p3', true);
    await renewed;
    // The replaced lease is cancelled, so exactly one 30 s expiry stays live.
    expect(scheduler.liveCount(30_000)).toBe(1);

    scheduler.fire(30_000);
    await fake.until(() => fake.subscriberCount === 0);
  });

  it('closes the shared stream once the last watched pane is released', async () => {
    fake.reply('agent.read', () => paneRead('T0'));
    await openScreenWatch('wA:p3');
    const second = nextScreen(link, (message) => message.paneId === 'wA:p4');
    link.watch('wA:p4', true);
    await second;

    link.watch('wA:p3', false);
    // The pane still watched keeps its lease, so the shared stream stays open.
    expect(scheduler.liveCount(30_000)).toBe(1);

    link.watch('wA:p4', false);
    await fake.until(() => fake.subscriberCount === 0);
  });

  it('closes every screen watch when the shared stream fails', async () => {
    fake.reply('agent.read', () => paneRead('T0'));
    await openScreenWatch('wA:p3');
    const second = nextScreen(link, (message) => message.paneId === 'wA:p4');
    link.watch('wA:p4', true);
    await second;

    const closed = scheduler.whenIdle(30_000);
    fake.dropSubscribers();
    await closed;

    expect(scheduler.liveCount(30_000)).toBe(0);
  });

  it('releases the screen watch when stopped', async () => {
    fake.reply('agent.read', () => paneRead('T0'));
    await openScreenWatch('wA:p3');

    link.stop();
    await fake.until(() => fake.subscriberCount === 0);
    expect(scheduler.liveCount(30_000)).toBe(0);
  });

  it('accepts the dotted pane.updated event name', async () => {
    fake.reply('agent.read', () => paneRead('T0'));
    await openScreenWatch('wA:p3');
    fake.reply('agent.read', () => paneRead('T1'));
    const changed = nextScreen(link, (message) => message.text === 'T1');

    fake.push('pane.updated', paneUpdated('wA:p3', 2));
    expect((await changed).text).toBe('T1');
  });

  it('refuses a malformed pane id for a screen watch', () => {
    expect(() => link.watch('not-a-pane', true)).toThrow(HerdrError);
    expect(fake.requests).toHaveLength(0);
  });

  it('takes the pane title from terminal_title_stripped and falls back to terminal_title', async () => {
    fake.reply('agent.list', () => ({
      agents: [
        agentInfo({
          pane_id: 'wA:p2',
          terminal_title: 'raw',
          terminal_title_stripped: 'Đang sửa lỗi',
        }),
        agentInfo({
          pane_id: 'wA:p3',
          terminal_title: 'Chờ xác nhận',
          terminal_title_stripped: null,
        }),
      ],
    }));
    const roster = nextAgents(link, (message) => message.agents.length === 2);

    link.start();

    expect((await roster).agents.map((agent) => agent.title)).toEqual([
      'Đang sửa lỗi',
      'Chờ xác nhận',
    ]);
  });

  it('labels each agent with the label of its workspace', async () => {
    fake.reply('agent.list', () => ({
      agents: [
        agentInfo({ pane_id: 'wA:p2' }),
        agentInfo({ pane_id: 'wD:p1', workspace_id: 'wD' }),
      ],
    }));
    fake.reply('workspace.list', () => ({
      type: 'workspace_list',
      workspaces: [workspaceInfo('wA', 'D:\\'), workspaceInfo('wD', 'webgiaidau')],
    }));
    const roster = nextAgents(link, (message) => message.agents.length === 2);

    link.start();

    expect((await roster).agents.map((agent) => agent.workspaceLabel)).toEqual([
      'D:\\',
      'webgiaidau',
    ]);
  });

  it('keeps the roster when workspace.list fails', async () => {
    fake.reply('agent.list', () => ({ agents: [agentInfo()] }));
    fake.reply('workspace.list', () => {
      throw new ReplyError('invalid_request');
    });
    const roster = nextAgents(link, (message) => message.available);

    link.start();

    const message = await roster;
    expect(message.agents.map((agent) => agent.paneId)).toEqual(['wA:p2']);
    expect(message.agents[0]?.workspaceLabel).toBeUndefined();
  });

  it('names the repo and branch of each checkout, shared by a worktree and its main checkout', async () => {
    const repoRoot = path.resolve('repos', 'pixel-agents');
    const worktree = path.join(repoRoot, '.worktrees', 'multi-role-company');
    git.checkout(
      worktree,
      `${worktree}\nfeat/multi-role-company\n${path.join(repoRoot, '.git')}\n`,
    );
    git.checkout(repoRoot, `${repoRoot}\nmain\n.git\n`);
    fake.reply('agent.list', () => ({
      agents: [
        agentInfo({ pane_id: 'wA:p2', cwd: worktree }),
        agentInfo({ pane_id: 'wA:p3', cwd: repoRoot }),
      ],
    }));
    const roster = nextAgents(link, (message) =>
      message.agents.every((agent) => agent.repo !== undefined),
    );

    link.start();

    const [linked, main] = (await roster).agents;
    expect(linked).toMatchObject({
      repo: 'pixel-agents',
      branch: 'feat/multi-role-company',
      worktreeRoot: worktree,
    });
    expect(main).toMatchObject({ repo: 'pixel-agents', branch: 'main', worktreeRoot: repoRoot });
    expect(git.calls[0]?.args).toEqual([
      'rev-parse',
      '--show-toplevel',
      '--abbrev-ref',
      'HEAD',
      '--git-common-dir',
    ]);
  });

  it('shows no branch for a detached HEAD', async () => {
    const detached = path.resolve('repos', 'detached');
    git.checkout(detached, `${detached}\nHEAD\n${path.join(detached, '.git')}\n`);
    fake.reply('agent.list', () => ({ agents: [agentInfo({ cwd: detached })] }));
    const roster = nextAgents(link, (message) => message.agents[0]?.repo !== undefined);

    link.start();

    const agent = (await roster).agents[0];
    expect(agent?.repo).toBe('detached');
    expect(agent).not.toHaveProperty('branch');
  });

  it('names a bare repository without its .git suffix', async () => {
    const worktree = path.resolve('repos', 'feat-tool');
    git.checkout(worktree, `${worktree}\nfeat\n${path.resolve('repos', 'tool.git')}\n`);
    fake.reply('agent.list', () => ({ agents: [agentInfo({ cwd: worktree })] }));
    const roster = nextAgents(link, (message) => message.agents[0]?.repo !== undefined);

    link.start();

    expect((await roster).agents[0]).toMatchObject({
      repo: 'tool',
      branch: 'feat',
      worktreeRoot: worktree,
    });
  });

  it('publishes the roster before git answers, then republishes with the checkout', async () => {
    const worktree = path.resolve('repos', 'slow');
    const answer = deferred<string>();
    git.respond(worktree, () => answer.promise);
    fake.reply('agent.list', () => ({ agents: [agentInfo({ cwd: worktree })] }));
    const beforeGit = nextAgents(link, (message) => message.available);

    link.start();

    expect((await beforeGit).agents[0]?.repo).toBeUndefined();
    const withGit = nextAgents(link, (message) => message.agents[0]?.repo !== undefined);
    answer.resolve(`${worktree}\nmain\n${path.join(worktree, '.git')}\n`);
    expect((await withGit).agents[0]).toMatchObject({
      repo: 'slow',
      branch: 'main',
      worktreeRoot: worktree,
    });
  });

  it('keeps the roster when git fails for a checkout', async () => {
    const worktree = path.resolve('repos', 'broken');
    git.respond(worktree, () => Promise.reject(new Error('spawn git ENOENT')));
    fake.reply('workspace.list', () => ({
      type: 'workspace_list',
      workspaces: [workspaceInfo('wA', 'D:\\')],
    }));
    fake.reply('agent.list', () => ({
      agents: [agentInfo({ cwd: worktree, terminal_title_stripped: 'Đang sửa lỗi' })],
    }));
    const roster = nextAgents(link, (message) => message.available);

    link.start();

    const message = await roster;
    expect(message.agents).toEqual([
      expect.objectContaining({
        paneId: 'wA:p2',
        title: 'Đang sửa lỗi',
        workspaceLabel: 'D:\\',
        cwd: worktree,
      }),
    ]);
    expect(message.agents[0]?.repo).toBeUndefined();
  });

  it('reuses a checkout lookup for 30 seconds, including one that found no repository', async () => {
    const repoRoot = path.resolve('repos', 'pixel-agents');
    const outside = path.resolve('scratch');
    git.checkout(repoRoot, `${repoRoot}\nmain\n.git\n`);
    fake.reply('agent.list', () => ({
      agents: [
        agentInfo({ pane_id: 'wA:p2', cwd: repoRoot }),
        agentInfo({ pane_id: 'wA:p3', cwd: outside }),
      ],
    }));
    const roster = nextAgents(link, (message) => message.agents[0]?.repo !== undefined);
    // subscription_started schedules the first reconcile; it stays pending until fired below.
    const firstReconcile = scheduler.whenScheduled(150);

    link.start();
    await roster;
    await firstReconcile;
    expect(git.callsIn(repoRoot)).toBe(1);
    expect(git.callsIn(outside)).toBe(1);

    // Inside the window a reconcile reuses both lookups, the negative one included.
    fake.reply('agent.list', () => ({
      agents: [
        agentInfo({ pane_id: 'wA:p2', cwd: repoRoot, agent_status: 'blocked' }),
        agentInfo({ pane_id: 'wA:p3', cwd: outside, agent_status: 'blocked' }),
      ],
    }));
    const blocked = nextAgents(link, (message) => message.agents[0]?.status === 'blocked');
    scheduler.fire(150);
    const blockedRoster = await blocked;
    expect(blockedRoster.agents[0]?.repo).toBe('pixel-agents');
    expect(blockedRoster.agents[1]).not.toHaveProperty('repo');
    expect(git.callsIn(repoRoot)).toBe(1);
    expect(git.callsIn(outside)).toBe(1);

    // Once 30 seconds pass, the next reconcile looks both checkouts up again.
    scheduler.fire(30_000);
    const secondReconcile = scheduler.whenScheduled(150);
    fake.push('pane.agent_status_changed', { pane_id: 'wA:p2', agent_status: 'done' });
    await secondReconcile;
    fake.reply('agent.list', () => ({
      agents: [
        agentInfo({ pane_id: 'wA:p2', cwd: repoRoot, agent_status: 'done' }),
        agentInfo({ pane_id: 'wA:p3', cwd: outside, agent_status: 'done' }),
      ],
    }));
    const done = nextAgents(link, (message) => message.agents[0]?.status === 'done');
    scheduler.fire(150);
    await done;
    expect(git.callsIn(repoRoot)).toBe(2);
    expect(git.callsIn(outside)).toBe(2);
  });

  it('renames an agent with a herdr-valid name, targeting its pane', async () => {
    fake.reply('agent.rename', () => ({ type: 'ok' }));

    await link.rename('wA:p2', 'reviewer_2');

    expect(fake.requestsTo('agent.rename')).toEqual([
      { method: 'agent.rename', params: { target: 'wA:p2', name: 'reviewer_2' } },
    ]);
  });

  it('refuses names herdr would reject before sending anything', async () => {
    for (const name of ['', 'Reviewer', '2agent', 'my agent', 'a'.repeat(33), 'bạn']) {
      expect((await herdrFailure(link.rename('wA:p2', name))).code).toBe('invalid_request');
    }
    expect(fake.requests).toHaveLength(0);
  });

  it('maps a pane that vanished during a rename to agent_not_found', async () => {
    fake.reply('agent.rename', () => {
      throw new ReplyError('agent_not_found');
    });

    expect((await herdrFailure(link.rename('wA:p9', 'reviewer'))).code).toBe('agent_not_found');
  });

  it('describes an omp agent from its transcript, with the cwd it runs in now', async () => {
    await withTempDir(async (dir) => {
      const file = await writeTranscript(dir, [
        { type: 'session', version: 3, id: 's1', cwd: 'V:\\repo' },
        { type: 'model_change', model: 'anthropic/claude-haiku-5-5' },
        { type: 'thinking_level_change', thinkingLevel: 'high' },
        {
          type: 'message',
          message: {
            role: 'assistant',
            provider: 'anthropic',
            model: 'claude-opus-5-5',
            requestControls: {
              tools: {
                declared: ['read', 'bash', 'mcp__openviking_write'],
                deferred: [],
                active: ['read', 'bash'],
              },
            },
            content: [
              { type: 'toolCall', id: 't1', name: 'read', arguments: { path: 'skill://lavish' } },
              { type: 'toolCall', id: 't2', name: 'mcp__openviking_write', arguments: {} },
              { type: 'toolCall', id: 't3', name: 'bash', arguments: {} },
              { type: 'toolCall', id: 't4', name: 'bash', arguments: {} },
            ],
          },
        },
      ]);
      fake.reply('agent.list', () => ({
        agents: [
          agentInfo({
            cwd: 'V:\\repo',
            agent_session: { agent: 'omp', kind: 'path', value: file },
          }),
        ],
      }));
      fake.reply('pane.process_info', () =>
        processInfo([
          { name: 'cmd.exe', argv: ['cmd.exe'], cwd: 'V:\\repo\\' },
          { name: 'omp.exe', argv: ['omp'], cwd: 'V:\\repo\\sub' },
        ]),
      );

      const info = await link.info('wA:p2');

      expect(info).toMatchObject({
        collectedFrom: 'transcript',
        cwd: 'V:\\repo\\sub',
        launchCwd: 'V:\\repo',
        model: 'anthropic/claude-opus-5-5',
        thinking: 'high',
        sessionFile: file,
        skills: [{ name: 'lavish', used: true }],
        toolUsage: [
          { name: 'bash', count: 2 },
          { name: 'mcp__openviking_write', count: 1 },
          { name: 'read', count: 1 },
        ],
      });
      expect(info.tools).toEqual([
        { name: 'bash', source: 'builtin', active: true },
        { name: 'mcp__openviking_write', source: 'mcp', mcpServer: 'openviking', active: false },
        { name: 'read', source: 'builtin', active: true },
      ]);
      expect(info).not.toHaveProperty('note');
    });
  });

  it('keeps the roster cwd when herdr cannot describe the pane processes', async () => {
    fake.reply('agent.list', () => ({ agents: [agentInfo({ cwd: 'C:/repo' })] }));
    fake.reply('pane.process_info', () => {
      throw new ReplyError('pane_not_found');
    });

    const info = await link.info('wA:p2');

    expect(info).toMatchObject({ collectedFrom: 'herdr', cwd: 'C:/repo' });
    expect(info).not.toHaveProperty('launchCwd');
  });

  it('reports no launch cwd when the foreground directory is the same one', async () => {
    fake.reply('agent.list', () => ({ agents: [agentInfo({ cwd: 'V:\\repo' })] }));
    fake.reply('pane.process_info', () =>
      processInfo([{ name: 'cmd.exe', argv: ['cmd.exe'], cwd: 'v:\\repo\\' }]),
    );

    const info = await link.info('wA:p2');

    expect(info.cwd).toBe('v:\\repo\\');
    expect(info).not.toHaveProperty('launchCwd');
  });

  it('reports only herdr facts for an agent that is not omp', async () => {
    fake.reply('agent.list', () => ({ agents: [agentInfo({ agent: 'claude', cwd: 'V:\\repo' })] }));

    expect(await link.info('wA:p2')).toMatchObject({
      collectedFrom: 'herdr',
      cwd: 'V:\\repo',
      note: 'Agent này không chạy omp, nên chỉ có thư mục làm việc từ herdr.',
    });
  });

  it('explains when omp has not reported a transcript path', async () => {
    fake.reply('agent.list', () => ({ agents: [agentInfo({ cwd: 'V:\\repo' })] }));

    expect(await link.info('wA:p2')).toMatchObject({
      collectedFrom: 'herdr',
      note: 'omp chưa báo đường dẫn transcript, nên chỉ có thông tin từ herdr.',
    });
  });

  it('explains when the omp transcript cannot be read', async () => {
    await withTempDir(async (dir) => {
      const file = path.join(dir, 'gone.jsonl');
      fake.reply('agent.list', () => ({
        agents: [agentInfo({ cwd: 'V:\\repo', agent_session: { kind: 'path', value: file } })],
      }));

      expect(await link.info('wA:p2')).toMatchObject({
        collectedFrom: 'herdr',
        note: 'Không đọc được transcript của omp, nên chỉ có thông tin từ herdr.',
      });
    });
  });

  it('reports a pane that is no longer listed as not found', async () => {
    fake.reply('agent.list', () => ({ agents: [agentInfo({ pane_id: 'wA:p7' })] }));

    expect((await herdrFailure(link.info('wA:p2'))).code).toBe('agent_not_found');
  });

  it('disarms the transcript deadline once the transcript has been read', async () => {
    await withTempDir(async (dir) => {
      const file = await writeTranscript(dir, [
        { type: 'model_change', model: 'anthropic/claude-opus-5-5' },
      ]);
      fake.reply('agent.list', () => ({
        agents: [agentInfo({ agent_session: { kind: 'path', value: file } })],
      }));

      await link.info('wA:p2');

      // Every call and the transcript read have settled, so no 5 s timer may stay armed.
      expect(scheduler.liveCount(5_000)).toBe(0);
    });
  });
});

describe('HerdrLink sleeping sessions and wake', () => {
  const SESSION_FILE = 'C:/omp/sessions/2026-01-01_1f2e3d4c-5b6a-4978-8a9b-000087572576.jsonl';
  const SID8 = '87572576';
  const SLEPT = {
    pane: 'wD:p4',
    terminal: 'term_slept',
    file: SESSION_FILE,
    cwd: 'V:\\Duancanhan',
    phase: 'sleeping',
    ts: '2026-01-01T00:00:00Z',
  };
  let dir: string;
  let registryFile: string;
  let fake: FakeHerdr;
  let scheduler: ManualScheduler;
  let warnings: string[];
  let link: HerdrLink;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'omp-herdr-sleep-'));
    registryFile = path.join(dir, 'omp-ngu.json');
    fake = new FakeHerdr();
    await fake.listen();
    scheduler = new ManualScheduler();
    warnings = [];
    const git = new FakeGit();
    link = createHerdrLink({
      socketPath: fake.endpoint,
      scheduler,
      runGit: git.run,
      sleepRegistryFile: registryFile,
      warn: (message) => warnings.push(message),
    });
  });

  afterEach(async () => {
    link.stop();
    await fake.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  /** A `pane.list` entry for the sleeping session's pane; each test overrides what changed. */
  function sleepingPane(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      pane_id: 'wD:p4',
      workspace_id: 'wD',
      terminal_id: 'term_slept',
      cwd: 'V:\\Duancanhan',
      label: `zz omp: Refactor modal #${SID8}`,
      ...overrides,
    };
  }

  async function writeRegistry(entries: readonly Record<string, unknown>[]): Promise<void> {
    await fs.writeFile(registryFile, JSON.stringify(entries));
  }

  it('lists a sleeping session on the roster with its title and slept time', async () => {
    await writeRegistry([SLEPT]);
    fake.reply('pane.list', () => ({ panes: [sleepingPane()] }));
    const roster = nextAgents(link, (message) => message.sleeping.length > 0);

    link.start();

    const message = await roster;
    expect(message.sleeping).toEqual([
      {
        paneId: 'wD:p4',
        title: 'Refactor modal',
        sessionFile: SESSION_FILE,
        sleptAt: '2026-01-01T00:00:00.000Z',
        cwd: 'V:\\Duancanhan',
      },
    ]);
    expect(message.agents).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it('keeps the agents and lists no sleeping session when the pane read fails', async () => {
    fake.reply('agent.list', () => ({ agents: [agentInfo()] }));
    fake.reply('pane.list', () => {
      throw new ReplyError('agent_not_found');
    });
    const roster = nextAgents(link, (message) => message.available && message.agents.length === 1);

    link.start();

    expect((await roster).sleeping).toEqual([]);
  });

  it('wakes a sleeping session by typing the prompt and pressing Enter in its pane', async () => {
    await writeRegistry([SLEPT]);
    fake.reply('pane.list', () => ({ panes: [sleepingPane()] }));
    fake.reply('pane.send_text', () => ({ type: 'ok' }));
    fake.reply('pane.send_keys', () => ({ type: 'ok' }));

    await link.wake('wD:p4', 'tiếp tục');

    expect(fake.requestsTo('pane.send_text')).toEqual([
      { method: 'pane.send_text', params: { pane_id: 'wD:p4', text: 'tiếp tục' } },
    ]);
    expect(fake.requestsTo('pane.send_keys')).toEqual([
      { method: 'pane.send_keys', params: { pane_id: 'wD:p4', keys: ['enter'] } },
    ]);
  });

  it('wakes without typing anything when no prompt is given', async () => {
    await writeRegistry([SLEPT]);
    fake.reply('pane.list', () => ({ panes: [sleepingPane()] }));
    fake.reply('pane.send_keys', () => ({ type: 'ok' }));

    await link.wake('wD:p4');

    expect(fake.requestsTo('pane.send_text')).toEqual([]);
    expect(fake.requestsTo('pane.send_keys')).toHaveLength(1);
  });

  it('refuses a pane that has started an agent and sends nothing', async () => {
    await writeRegistry([SLEPT]);
    fake.reply('pane.list', () => ({ panes: [sleepingPane({ agent: 'omp' })] }));

    const error = await herdrFailure(link.wake('wD:p4'));

    expect(error.code).toBe('not_sleeping');
    expect(error.message).toBe('Pane này đang chạy agent, phiên không còn ngủ đông.');
    expect(fake.requestsTo('pane.send_keys')).toEqual([]);
  });

  it('refuses a session that is no longer in the registry', async () => {
    await writeRegistry([]);
    fake.reply('pane.list', () => ({ panes: [sleepingPane()] }));

    const error = await herdrFailure(link.wake('wD:p4'));

    expect(error.code).toBe('not_sleeping');
    expect(error.message).toBe('Phiên này không còn ngủ đông. Hãy làm mới bảng.');
    expect(fake.requestsTo('pane.send_keys')).toEqual([]);
  });

  it('refuses a session whose exit has not finished yet', async () => {
    await writeRegistry([{ ...SLEPT, phase: 'exit-requested' }]);
    fake.reply('pane.list', () => ({ panes: [sleepingPane()] }));

    const error = await herdrFailure(link.wake('wD:p4'));

    expect(error.message).toBe('Phiên omp vẫn đang thoát, chưa ngủ xong. Thử lại sau vài giây.');
    expect(fake.requestsTo('pane.send_keys')).toEqual([]);
  });

  it('holds a second wake of the same pane until the hold window passes', async () => {
    await writeRegistry([SLEPT]);
    fake.reply('pane.list', () => ({ panes: [sleepingPane()] }));
    fake.reply('pane.send_keys', () => ({ type: 'ok' }));

    await link.wake('wD:p4');
    const second = await herdrFailure(link.wake('wD:p4'));

    expect(second.code).toBe('not_sleeping');
    expect(second.message).toBe('Đang đánh thức phiên này, hãy chờ omp chạy lại.');
    expect(fake.requestsTo('pane.send_keys')).toHaveLength(1);

    // The hold lasts 20 seconds; firing that delay ends it.
    scheduler.fire(20_000);
    await link.wake('wD:p4');
    expect(fake.requestsTo('pane.send_keys')).toHaveLength(2);
  });

  it('releases the hold when a wake is refused, so the next attempt is judged afresh', async () => {
    await writeRegistry([SLEPT]);
    fake.reply('pane.list', () => ({ panes: [sleepingPane({ agent: 'omp' })] }));
    fake.reply('pane.send_keys', () => ({ type: 'ok' }));
    await herdrFailure(link.wake('wD:p4'));

    fake.reply('pane.list', () => ({ panes: [sleepingPane()] }));
    await link.wake('wD:p4');

    expect(fake.requestsTo('pane.send_keys')).toHaveLength(1);
  });

  it('rejects blank, multi-line, and oversized prompts before contacting herdr', async () => {
    expect((await herdrFailure(link.wake('wD:p4', '   '))).code).toBe('invalid_request');
    expect((await herdrFailure(link.wake('wD:p4', 'dòng một\ndòng hai'))).code).toBe(
      'invalid_request',
    );
    expect((await herdrFailure(link.wake('wD:p4', 'x'.repeat(4001)))).code).toBe('invalid_request');
    expect(fake.requests).toHaveLength(0);
  });

  it('re-reads the registry on the poll timer, so a new sleep appears without a herdr event', async () => {
    fake.reply('pane.list', () => ({ panes: [sleepingPane()] }));
    const first = nextAgents(link, (message) => message.available);

    link.start();

    expect((await first).sleeping).toEqual([]);
    expect(scheduler.liveCount(10_000)).toBe(1);
    await writeRegistry([SLEPT]);
    const later = nextAgents(link, (message) => message.sleeping.length === 1);

    scheduler.fire(10_000);

    expect((await later).sleeping).toHaveLength(1);
  });
});

describe('HerdrLink workspace tags', () => {
  const SESSION_FILE = 'C:/omp/sessions/2026-01-01_1f2e3d4c-5b6a-4978-8a9b-000087572576.jsonl';
  const SESSION_ID = '87572576';
  const SLEPT_CWD = 'V:\\Duancanhan\\Project_QuanLyGiaiDau';
  let dir: string;
  let fake: FakeHerdr;
  let scheduler: ManualScheduler;
  /** Open folder per cwd, as the folder scope answers it. */
  let folders: Map<string, string>;
  let link: HerdrLink;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'omp-herdr-scope-'));
    fake = new FakeHerdr();
    await fake.listen();
    scheduler = new ManualScheduler();
    folders = new Map();
    link = createHerdrLink({
      socketPath: fake.endpoint,
      scheduler,
      runGit: new FakeGit().run,
      sleepRegistryFile: path.join(dir, 'omp-ngu.json'),
      workspaceFor: async (cwd) => folders.get(cwd),
    });
  });

  afterEach(async () => {
    link.stop();
    await fake.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('tags an agent with the open folder holding its cwd and leaves an outside agent untagged', async () => {
    folders.set('C:/repo', 'C:/repo');
    fake.reply('agent.list', () => ({
      agents: [
        agentInfo(),
        agentInfo({ pane_id: 'wB:p1', workspace_id: 'wB', cwd: 'D:/elsewhere' }),
      ],
    }));
    const roster = nextAgents(link, (message) => message.agents.length === 2);

    link.start();

    const [inside, outside] = (await roster).agents;
    expect(inside).toMatchObject({ paneId: 'wA:p2', workspacePath: 'C:/repo' });
    expect(outside).toMatchObject({ paneId: 'wB:p1' });
    expect(outside).not.toHaveProperty('workspacePath');
  });

  it('tags a sleeping pane with the open folder holding its cwd', async () => {
    folders.set(SLEPT_CWD, 'V:\\Duancanhan\\Project_QuanLyGiaiDau');
    await fs.writeFile(
      path.join(dir, 'omp-ngu.json'),
      JSON.stringify([
        {
          pane: 'wD:p4',
          terminal: 'term_slept',
          file: SESSION_FILE,
          cwd: SLEPT_CWD,
          phase: 'sleeping',
          ts: '2026-01-01T00:00:00Z',
        },
      ]),
    );
    fake.reply('pane.list', () => ({
      panes: [
        {
          pane_id: 'wD:p4',
          workspace_id: 'wD',
          terminal_id: 'term_slept',
          cwd: SLEPT_CWD,
          label: `zz omp: Refactor modal #${SESSION_ID}`,
        },
      ],
    }));
    const roster = nextAgents(link, (message) => message.sleeping.length > 0);

    link.start();

    expect((await roster).sleeping).toMatchObject([
      { paneId: 'wD:p4', workspacePath: 'V:\\Duancanhan\\Project_QuanLyGiaiDau' },
    ]);
  });

  it('re-tags the roster on rescope, dropping the tag from a folder that closed', async () => {
    folders.set('C:/repo', 'C:/repo');
    fake.reply('agent.list', () => ({ agents: [agentInfo()] }));
    const first = nextAgents(link, (message) => message.agents.length === 1);

    link.start();

    expect((await first).agents[0]).toMatchObject({ workspacePath: 'C:/repo' });

    folders.delete('C:/repo');
    const retagged = nextAgents(link, (message) => message.agents.length === 1);
    await link.rescope();

    expect((await retagged).agents[0]).not.toHaveProperty('workspacePath');
  });
});

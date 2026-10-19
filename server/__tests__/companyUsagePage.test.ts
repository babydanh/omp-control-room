import { describe, expect, it, vi } from 'vitest';

import type { ServerMessage, UsageStatsTotals } from '../../core/src/messages.js';
import { type CompanyCommandContext, handleCompanyCommand } from '../src/company/clientCommands.js';
import { CompanyError } from '../src/company/companyError.js';
import {
  COMPANY_USAGE_HISTORY_MIN_INTERVAL_MS,
  COMPANY_USAGE_HISTORY_TTL_MS,
  COMPANY_USAGE_LIMITS_MIN_INTERVAL_MS,
  COMPANY_USAGE_LIMITS_TTL_MS,
  COMPANY_USAGE_STATS_TTL_MS,
} from '../src/company/constants.js';
import type { QuotaRunner, QuotaRunnerResult } from '../src/company/quotaService.js';
import {
  createUsageReader,
  parseOmpClientsPayload,
  parseOmpHistoryPayload,
  parseOmpStatsOutput,
  usageClientsArgv,
  type UsageControl,
  usageHistoryArgv,
  type UsageHistoryReply,
  type UsageLimitsReply,
  usageStatsArgv,
  type UsageStatsReply,
} from '../src/company/usagePage.js';

const T0 = 1_790_914_741_315;
const SINCE_MS = 1_790_913_600_000;

const iso = (epochMs: number): string => new Date(epochMs).toISOString();

const LIMITS_PAYLOAD = JSON.stringify({
  generatedAt: T0,
  reports: [
    {
      provider: 'openai-codex',
      fetchedAt: T0,
      limits: [
        {
          id: 'openai-codex:primary',
          label: '7 days',
          amount: { used: 27, unit: 'percent' },
        },
      ],
      metadata: { accountId: 'cd*' },
    },
  ],
  accountsWithoutUsage: [],
  disabledCredentials: [],
  capacity: {},
});

const HISTORY_PAYLOAD = JSON.stringify({
  generatedAt: T0,
  sinceMs: SINCE_MS,
  entries: [
    {
      recordedAt: 1_790_914_000_000,
      provider: 'anthropic',
      accountKey: 'anthropic:6d*',
      email: 'an*',
      accountId: '6d*',
      limitId: 'anthropic:5h',
      label: '5 hours',
      windowLabel: '5h',
      usedFraction: 0.42,
      status: 'ok',
      resetsAt: 1_790_930_000_000,
    },
    {
      recordedAt: 1_790_917_600_000,
      provider: 'openai-codex',
      accountKey: 'openai-codex:cd*',
      limitId: 'openai-codex:primary',
      label: '7 days',
      usedFraction: 0.27,
    },
  ],
});

const CLIENTS_PAYLOAD = JSON.stringify({
  generatedAt: T0,
  sinceMs: SINCE_MS,
  clients: [
    {
      installId: 'inst-1',
      hostname: 'laptop',
      firstSeen: SINCE_MS,
      lastSeen: T0,
      providers: [
        {
          provider: 'anthropic',
          requests: 3,
          inputTokens: 100,
          outputTokens: 50,
          cacheReadTokens: 10,
          cacheWriteTokens: 5,
          costUsd: 0.5,
        },
        {
          provider: 'openai-codex',
          app: 'omp',
          requests: 2,
          inputTokens: 40,
          outputTokens: 20,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          costUsd: 0.25,
        },
      ],
    },
    { installId: 'inst-2', firstSeen: SINCE_MS, lastSeen: SINCE_MS, providers: [] },
  ],
});

const STATS_TOTALS: UsageStatsTotals = {
  totalRequests: 10,
  successfulRequests: 9,
  failedRequests: 1,
  errorRate: 0.1,
  totalInputTokens: 1000,
  totalOutputTokens: 500,
  totalCacheReadTokens: 200,
  totalCacheWriteTokens: 50,
  cacheRate: 0.2,
  cacheSavings: 0.01,
  totalCost: 1.5,
  unpricedRequests: 0,
  totalPremiumRequests: 0,
  avgDuration: 1200,
  avgTtft: 300,
  avgTokensPerSecond: 42,
};

const STATS_PAYLOAD = JSON.stringify({
  overall: { ...STATS_TOTALS, firstTimestamp: SINCE_MS, lastTimestamp: T0 },
  byModel: [{ model: 'claude-x', provider: 'anthropic', ...STATS_TOTALS }],
  byFolder: [{ folder: '/w/app', ...STATS_TOTALS }],
  byAgentType: [
    {
      agentType: 'main',
      totalRequests: 10,
      totalInputTokens: 1000,
      totalOutputTokens: 500,
      totalCacheReadTokens: 200,
      totalCacheWriteTokens: 50,
      totalCost: 1.5,
    },
  ],
  timeSeries: [{ timestamp: SINCE_MS, requests: 3, errors: 0, tokens: 600, cost: 0.5 }],
  modelPerformanceSeries: [
    {
      timestamp: SINCE_MS,
      model: 'claude-x',
      provider: 'anthropic',
      requests: 3,
      avgTtft: 300,
      avgTokensPerSecond: 42,
    },
  ],
  costSeries: [
    {
      timestamp: SINCE_MS,
      model: 'claude-x',
      provider: 'anthropic',
      cost: 0.5,
      costInput: 0.2,
      costOutput: 0.2,
      costCacheRead: 0.05,
      costCacheWrite: 0.05,
      requests: 3,
      unpricedRequests: 0,
    },
  ],
  modelSeries: [{ timestamp: SINCE_MS, model: 'claude-x' }],
});

/** `omp stats` prints progress lines before its JSON object. */
const STATS_OUTPUT = `Syncing session files...\nSynced 1250 new entries\n${STATS_PAYLOAD}`;

function ok(stdout: string): QuotaRunnerResult {
  return { stdout, stderr: '', exitCode: 0, timedOut: false };
}

/** Maps each literal OMP argv to its fixture. Unknown argv fails loudly. */
function ompRoute(argv: readonly string[]): QuotaRunnerResult {
  switch (argv.join(' ')) {
    case 'usage --json --redact':
      return ok(LIMITS_PAYLOAD);
    case 'usage --history --days 7 --json --redact':
      return ok(HISTORY_PAYLOAD);
    case 'usage clients --days 7 --json --redact':
      return ok(CLIENTS_PAYLOAD);
    case 'stats --json':
      return ok(STATS_OUTPUT);
    default:
      return {
        stdout: '',
        stderr: `unexpected argv: ${argv.join(' ')}`,
        exitCode: 2,
        timedOut: false,
      };
  }
}

type RouteFn = (argv: readonly string[]) => QuotaRunnerResult;

interface ReaderHarness {
  usage: UsageControl;
  /** Each spawned argv, joined with spaces, in spawn order. */
  calls: string[];
  logs: string[];
  now(): number;
  advance(ms: number): void;
  setRoute(route: RouteFn): void;
}

function readerHarness(): ReaderHarness {
  let clock = T0;
  const calls: string[] = [];
  const logs: string[] = [];
  const state: { route: RouteFn } = { route: ompRoute };
  const runner: QuotaRunner = (request) => {
    calls.push(request.argv.join(' '));
    return Promise.resolve(state.route(request.argv));
  };
  const usage = createUsageReader({
    command: () => ({ file: '/opt/omp/bin/omp', args: [] }),
    cwd: '/workspace',
    runner,
    now: () => clock,
    logger: (message) => logs.push(message),
  });
  return {
    usage,
    calls,
    logs,
    now: () => clock,
    advance: (ms) => {
      clock += ms;
    },
    setRoute: (route) => {
      state.route = route;
    },
  };
}

/** A promise the test resolves by hand, so a read can be held in flight. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** The `code` of the thrown `CompanyError`, or undefined when nothing was thrown. */
function codeOf(run: () => unknown): string | undefined {
  try {
    run();
  } catch (err) {
    return err instanceof CompanyError ? err.code : undefined;
  }
  return undefined;
}

describe('usage argv', () => {
  it('builds the literal OMP argv for each read', () => {
    expect(usageHistoryArgv(7)).toEqual([
      'usage',
      '--history',
      '--days',
      '7',
      '--json',
      '--redact',
    ]);
    expect(usageClientsArgv(30)).toEqual([
      'usage',
      'clients',
      '--days',
      '30',
      '--json',
      '--redact',
    ]);
    expect(usageStatsArgv()).toEqual(['stats', '--json']);
  });
});

describe('parseOmpHistoryPayload', () => {
  it('converts times to ISO and keeps optional fields only when OMP sends them', () => {
    const parsed = parseOmpHistoryPayload(HISTORY_PAYLOAD);
    expect(parsed.sinceAt).toBe(iso(SINCE_MS));
    expect(parsed.entries).toHaveLength(2);
    expect(parsed.entries[0]).toMatchObject({
      recordedAt: iso(1_790_914_000_000),
      provider: 'anthropic',
      accountKey: 'anthropic:6d*',
      email: 'an*',
      accountId: '6d*',
      windowLabel: '5h',
      usedFraction: 0.42,
      status: 'ok',
      resetAt: iso(1_790_930_000_000),
    });
    expect(parsed.entries[1]).not.toHaveProperty('email');
    expect(parsed.entries[1]).not.toHaveProperty('resetAt');
  });

  it('skips progress lines before the JSON object', () => {
    const parsed = parseOmpHistoryPayload(`Reading usage history...\n${HISTORY_PAYLOAD}`);
    expect(parsed.entries).toHaveLength(2);
  });

  it('rejects an entry missing a required field as usage_payload_invalid', () => {
    const broken = JSON.stringify({
      sinceMs: SINCE_MS,
      entries: [{ recordedAt: 1, accountKey: 'x', limitId: 'x', label: 'x', usedFraction: 0.5 }],
    });
    expect(codeOf(() => parseOmpHistoryPayload(broken))).toBe('usage_payload_invalid');
  });

  it('keeps a balance-only row without a usage fraction and leaves the key out', () => {
    const payload = JSON.stringify({
      sinceMs: SINCE_MS,
      entries: [
        {
          recordedAt: 1,
          provider: 'commandcode',
          accountKey: 'ap*',
          limitId: 'commandcode:balance',
          label: 'Credit balance',
        },
      ],
    });
    const parsed = parseOmpHistoryPayload(payload);
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0]).not.toHaveProperty('usedFraction');
  });

  it('rejects output that is not JSON as usage_payload_invalid', () => {
    expect(codeOf(() => parseOmpHistoryPayload('Error: not logged in'))).toBe(
      'usage_payload_invalid',
    );
  });
});

describe('parseOmpClientsPayload', () => {
  it('names a client by hostname and sums each metric across its providers', () => {
    expect(parseOmpClientsPayload(CLIENTS_PAYLOAD)).toEqual([
      {
        name: 'laptop',
        metrics: [
          { key: 'requests', value: 5 },
          { key: 'inputTokens', value: 140 },
          { key: 'outputTokens', value: 70 },
          { key: 'cacheReadTokens', value: 10 },
          { key: 'cacheWriteTokens', value: 5 },
          { key: 'costUsd', value: 0.75 },
        ],
      },
      {
        name: 'inst-2',
        metrics: [
          { key: 'requests', value: 0 },
          { key: 'inputTokens', value: 0 },
          { key: 'outputTokens', value: 0 },
          { key: 'cacheReadTokens', value: 0 },
          { key: 'cacheWriteTokens', value: 0 },
          { key: 'costUsd', value: 0 },
        ],
      },
    ]);
  });

  it('rejects a provider row missing a metric as usage_payload_invalid', () => {
    const broken = JSON.stringify({
      clients: [{ installId: 'inst-1', providers: [{ provider: 'anthropic', requests: 1 }] }],
    });
    expect(codeOf(() => parseOmpClientsPayload(broken))).toBe('usage_payload_invalid');
  });
});

describe('parseOmpStatsOutput', () => {
  it('reads every contract section and drops the modelSeries OMP adds', () => {
    const parsed = parseOmpStatsOutput(STATS_OUTPUT);
    expect(parsed.overall).toMatchObject({
      firstAt: iso(SINCE_MS),
      lastAt: iso(T0),
      totalCost: 1.5,
      totalRequests: 10,
    });
    expect(parsed.byModel[0]).toEqual({
      model: 'claude-x',
      provider: 'anthropic',
      totals: expect.objectContaining({ totalCost: 1.5 }),
    });
    expect(parsed.byModel[0].totals).not.toHaveProperty('model');
    // Agent rows are flat: the totals are not nested under a `totals` key.
    expect(parsed.byAgentType[0]).toEqual({
      agentType: 'main',
      totalRequests: 10,
      totalInputTokens: 1000,
      totalOutputTokens: 500,
      totalCacheReadTokens: 200,
      totalCacheWriteTokens: 50,
      totalCost: 1.5,
    });
    expect(parsed.costSeries[0].unpricedRequests).toBe(0);
    expect(parsed).not.toHaveProperty('modelSeries');
  });

  it('rejects a folder row missing its folder name as usage_payload_invalid', () => {
    const payload: Record<string, unknown> = JSON.parse(STATS_PAYLOAD);
    const broken = JSON.stringify({ ...payload, byFolder: [{ totalRequests: 1 }] });
    expect(codeOf(() => parseOmpStatsOutput(broken))).toBe('usage_payload_invalid');
  });

  it('omits timing averages OMP reports as null instead of rejecting the read', () => {
    const payload: Record<string, unknown> = JSON.parse(STATS_PAYLOAD);
    const broken = JSON.stringify({
      ...payload,
      modelPerformanceSeries: [
        {
          timestamp: SINCE_MS,
          model: 'claude-x',
          provider: 'anthropic',
          requests: 3,
          avgTtft: null,
          avgTokensPerSecond: null,
        },
      ],
    });
    const parsed = parseOmpStatsOutput(broken);
    expect(parsed.modelPerformanceSeries[0]).toMatchObject({ model: 'claude-x', requests: 3 });
    expect(parsed.modelPerformanceSeries[0]).not.toHaveProperty('avgTtft');
    expect(parsed.modelPerformanceSeries[0]).not.toHaveProperty('avgTokensPerSecond');
  });
});

describe('createUsageReader cache and reads', () => {
  it('serves limits from the cache inside the TTL and reads again after it', async () => {
    const h = readerHarness();
    const first = await h.usage.limits(false);
    expect(first.status).toBe('available');
    expect(first.cached).toBe(false);

    h.advance(1_000);
    expect((await h.usage.limits(false)).cached).toBe(true);
    expect(h.calls).toEqual(['usage --json --redact']);

    h.advance(COMPANY_USAGE_LIMITS_TTL_MS);
    expect((await h.usage.limits(false)).cached).toBe(false);
    expect(h.calls).toHaveLength(2);
  });

  it('never reads a forced limits request inside the minimum interval', async () => {
    const h = readerHarness();
    await h.usage.limits(false);

    h.advance(COMPANY_USAGE_LIMITS_MIN_INTERVAL_MS - 1);
    expect((await h.usage.limits(true)).cached).toBe(true);
    expect(h.calls).toHaveLength(1);

    h.advance(1);
    expect((await h.usage.limits(true)).cached).toBe(false);
    expect(h.calls).toHaveLength(2);
  });

  it('reads history and clients together and combines them into one reply', async () => {
    const h = readerHarness();
    const reply = await h.usage.history(7, false);

    expect(h.calls).toEqual([
      'usage --history --days 7 --json --redact',
      'usage clients --days 7 --json --redact',
    ]);
    expect(reply).toMatchObject({
      generatedAt: iso(T0),
      sinceAt: iso(SINCE_MS),
      days: 7,
    });
    expect(reply.entries).toHaveLength(2);
    expect(reply.clients[0].name).toBe('laptop');
  });

  it('serves history from the cache inside the TTL', async () => {
    const h = readerHarness();
    await h.usage.history(7, false);
    h.advance(COMPANY_USAGE_HISTORY_TTL_MS - 1);
    await h.usage.history(7, false);
    expect(h.calls).toHaveLength(2);

    h.advance(1);
    await h.usage.history(7, false);
    expect(h.calls).toHaveLength(4);
  });

  it('a forced history request reads sooner than the TTL but not inside the minimum interval', async () => {
    const h = readerHarness();
    await h.usage.history(7, false);

    h.advance(COMPANY_USAGE_HISTORY_MIN_INTERVAL_MS - 1);
    await h.usage.history(7, true);
    expect(h.calls).toHaveLength(2);

    h.advance(1);
    await h.usage.history(7, true);
    expect(h.calls).toHaveLength(4);
  });

  it('reads stats once per five-minute TTL', async () => {
    const h = readerHarness();
    await h.usage.stats(false);
    expect(h.calls).toEqual(['stats --json']);

    h.advance(COMPANY_USAGE_STATS_TTL_MS - 1);
    await h.usage.stats(false);
    expect(h.calls).toHaveLength(1);

    h.advance(1);
    await h.usage.stats(false);
    expect(h.calls).toHaveLength(2);
  });

  it('shares one in-flight stats read between concurrent requests', async () => {
    const gate = deferred<QuotaRunnerResult>();
    let started = 0;
    const runner: QuotaRunner = () => {
      started += 1;
      return gate.promise;
    };
    const usage = createUsageReader({
      command: () => ({ file: '/opt/omp/bin/omp', args: [] }),
      cwd: '/workspace',
      runner,
      now: () => T0,
      logger: () => {},
    });

    const first = usage.stats(false);
    const second = usage.stats(false);
    gate.resolve(ok(STATS_OUTPUT));
    const [a, b] = await Promise.all([first, second]);

    expect(started).toBe(1);
    expect(b).toEqual(a);
  });

  it('does not cache a failed stats read', async () => {
    const h = readerHarness();
    h.setRoute(() => ({ stdout: '', stderr: 'boom', exitCode: 1, timedOut: false }));
    await expect(h.usage.stats(false)).rejects.toMatchObject({ code: 'usage_read_failed' });

    h.setRoute(ompRoute);
    await expect(h.usage.stats(false)).resolves.toMatchObject({ overall: { totalRequests: 10 } });
    expect(h.calls).toEqual(['stats --json', 'stats --json']);
  });

  it('answers a timed-out history read as usage_read_failed', async () => {
    const h = readerHarness();
    h.setRoute((argv) =>
      argv.includes('--history')
        ? { stdout: '', stderr: '', exitCode: null, timedOut: true }
        : ompRoute(argv),
    );
    await expect(h.usage.history(7, false)).rejects.toMatchObject({
      code: 'usage_read_failed',
      message: expect.stringContaining('quá thời gian'),
    });
  });

  it('keeps token-shaped stderr out of the failure and the log', async () => {
    const h = readerHarness();
    h.setRoute(() => ({
      stdout: '',
      stderr: '401 unauthorized sk-live-abcdef0123456789',
      exitCode: 1,
      timedOut: false,
    }));
    const failure = await h.usage.stats(false).catch((err: unknown) => err);

    const message = failure instanceof Error ? failure.message : '';
    expect(message).toContain('401 unauthorized');
    expect(message).not.toContain('sk-live-abcdef0123456789');
    expect(h.logs.join('\n')).not.toContain('sk-live-abcdef0123456789');
    expect(h.logs.join('\n')).toContain('[Usage] stats failed');
  });

  it('answers usage_unavailable without spawning when the OMP command cannot be resolved', async () => {
    const calls: string[] = [];
    const usage = createUsageReader({
      command: () => {
        throw new Error('omp not found');
      },
      cwd: '/workspace',
      runner: (request) => {
        calls.push(request.argv.join(' '));
        return Promise.resolve(ok(''));
      },
      now: () => T0,
      logger: () => {},
    });

    await expect(usage.history(7, false)).rejects.toMatchObject({ code: 'usage_unavailable' });
    await expect(usage.limits(false)).rejects.toMatchObject({ code: 'usage_unavailable' });
    expect(calls).toHaveLength(0);
  });

  it('answers a limits payload of the wrong shape as usage_payload_invalid', async () => {
    const h = readerHarness();
    h.setRoute(() => ok(JSON.stringify({ generatedAt: 1 })));
    await expect(h.usage.limits(false)).rejects.toMatchObject({ code: 'usage_payload_invalid' });
  });

  it('stamps the stats reply with the reader clock and keeps the folder rows', async () => {
    const h = readerHarness();
    const reply = await h.usage.stats(false);
    expect(reply.generatedAt).toBe(iso(T0));
    expect(reply.byFolder).toEqual([expect.objectContaining({ folder: '/w/app' })]);
    expect(reply).not.toHaveProperty('modelSeries');
  });
});

const ZERO_LIMITS: UsageLimitsReply = {
  generatedAt: iso(T0),
  status: 'available',
  cached: false,
  snapshots: [],
  capacity: [],
};

const EMPTY_HISTORY: UsageHistoryReply = {
  generatedAt: iso(T0),
  sinceAt: iso(SINCE_MS),
  days: 7,
  entries: [],
  clients: [],
};

const EMPTY_STATS: UsageStatsReply = {
  generatedAt: iso(T0),
  overall: STATS_TOTALS,
  byModel: [],
  byFolder: [],
  byAgentType: [],
  timeSeries: [],
  modelPerformanceSeries: [],
  costSeries: [],
};

describe('usage requests through the company dispatcher', () => {
  const REQUEST_ID = '3f1c2b7e-8d4a-4e5f-9a6b-7c8d9e0f1a2b';

  function fakeControl(): { control: UsageControl; calls: string[] } {
    const calls: string[] = [];
    const control: UsageControl = {
      limits: (force) => {
        calls.push(`limits ${force}`);
        return Promise.resolve(ZERO_LIMITS);
      },
      history: (days, force) => {
        calls.push(`history ${days} ${force}`);
        return Promise.resolve({ ...EMPTY_HISTORY, days });
      },
      stats: (force) => {
        calls.push(`stats ${force}`);
        return Promise.resolve(EMPTY_STATS);
      },
    };
    return { control, calls };
  }

  const failingControl = (): UsageControl => {
    const readFailure = (): CompanyError =>
      new CompanyError('usage_read_failed', 'Không đọc được dữ liệu sử dụng token.');
    return {
      limits: () => Promise.reject(readFailure()),
      history: () => Promise.reject(readFailure()),
      stats: () => Promise.reject(readFailure()),
    };
  };

  const context = (
    usage: UsageControl | null,
    overrides: Partial<CompanyCommandContext> = {},
  ): CompanyCommandContext => ({
    services: null,
    privileged: true,
    executionAllowed: true,
    usage,
    ...overrides,
  });

  /** Dispatch one message and wait for its reply. Usage requests answer asynchronously. */
  async function dispatch(
    msg: Record<string, unknown>,
    ctx: CompanyCommandContext,
  ): Promise<ServerMessage[]> {
    const outbox: ServerMessage[] = [];
    expect(handleCompanyCommand(msg, (message) => outbox.push(message), ctx)).toBe(true);
    await vi.waitFor(() => expect(outbox.length).toBeGreaterThan(0));
    return outbox;
  }

  it('answers a limits request with the reply and its request id', async () => {
    const { control, calls } = fakeControl();
    const outbox = await dispatch(
      { type: 'usageLimitsRequest', requestId: REQUEST_ID, force: true },
      context(control),
    );
    expect(outbox).toEqual([{ type: 'usageLimits', requestId: REQUEST_ID, ...ZERO_LIMITS }]);
    expect(calls).toEqual(['limits true']);
  });

  it('passes the requested history window through to the reader', async () => {
    const { control, calls } = fakeControl();
    const outbox = await dispatch(
      { type: 'usageHistoryRequest', requestId: REQUEST_ID, days: 30 },
      context(control),
    );
    expect(outbox[0]).toMatchObject({ type: 'usageHistory', requestId: REQUEST_ID, days: 30 });
    expect(calls).toEqual(['history 30 false']);
  });

  it('answers a stats request with the forced flag', async () => {
    const { control, calls } = fakeControl();
    const outbox = await dispatch(
      { type: 'usageStatsRequest', requestId: REQUEST_ID, force: true },
      context(control),
    );
    expect(outbox[0]).toMatchObject({ type: 'usageStats', requestId: REQUEST_ID });
    expect(calls).toEqual(['stats true']);
  });

  it('refuses a history window outside 1, 7, or 30 days without reading', async () => {
    const { control, calls } = fakeControl();
    const outbox = await dispatch(
      { type: 'usageHistoryRequest', requestId: REQUEST_ID, days: 3 },
      context(control),
    );
    expect(outbox[0]).toMatchObject({
      type: 'companyCommandResult',
      requestId: REQUEST_ID,
      ok: false,
      errorCode: 'invalid_request',
    });
    expect(calls).toEqual([]);
  });

  it('refuses a non-boolean force flag without reading', async () => {
    const { control, calls } = fakeControl();
    const outbox = await dispatch(
      { type: 'usageStatsRequest', requestId: REQUEST_ID, force: 'yes' },
      context(control),
    );
    expect(outbox[0]).toMatchObject({
      type: 'companyCommandResult',
      ok: false,
      errorCode: 'invalid_request',
    });
    expect(calls).toEqual([]);
  });

  it('refuses a request without a request id, since no reply can be correlated', async () => {
    const { control, calls } = fakeControl();
    const outbox = await dispatch({ type: 'usageStatsRequest' }, context(control));
    expect(outbox[0]).toMatchObject({
      type: 'companyCommandResult',
      ok: false,
      errorCode: 'invalid_request',
    });
    expect(calls).toEqual([]);
  });

  it('refuses an unprivileged connection before any usage read', async () => {
    const { control, calls } = fakeControl();
    const outbox = await dispatch(
      { type: 'usageLimitsRequest', requestId: REQUEST_ID },
      context(control, { privileged: false }),
    );
    expect(outbox[0]).toMatchObject({
      type: 'companyCommandResult',
      ok: false,
      errorCode: 'forbidden',
    });
    expect(calls).toEqual([]);
  });

  it('answers usage requests in an untrusted workspace, since they only read', async () => {
    const { control, calls } = fakeControl();
    const outbox = await dispatch(
      { type: 'usageLimitsRequest', requestId: REQUEST_ID },
      context(control, { executionAllowed: false }),
    );
    expect(outbox[0]).toMatchObject({ type: 'usageLimits', requestId: REQUEST_ID });
    expect(calls).toEqual(['limits false']);
  });

  it('answers usage_unavailable when this process runs no usage reader', async () => {
    const outbox = await dispatch(
      { type: 'usageLimitsRequest', requestId: REQUEST_ID },
      context(null),
    );
    expect(outbox[0]).toMatchObject({
      type: 'companyCommandResult',
      requestId: REQUEST_ID,
      ok: false,
      errorCode: 'usage_unavailable',
    });
  });

  it('reports a reader failure by its error code', async () => {
    const outbox = await dispatch(
      { type: 'usageStatsRequest', requestId: REQUEST_ID },
      context(failingControl()),
    );
    expect(outbox[0]).toMatchObject({
      type: 'companyCommandResult',
      requestId: REQUEST_ID,
      ok: false,
      errorCode: 'usage_read_failed',
    });
  });
});

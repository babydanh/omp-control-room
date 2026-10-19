/**
 * usagePage: the reader behind the usage page. It runs OMP for the account
 * limits, the recorded limit history, per-client token burn, and the stats
 * roll-up. Each payload is parsed strictly, and each read is cached so the page
 * never starts a process it does not need.
 *
 * Nothing runs until a request arrives: no timers, no polling. Every read has
 * its own cache slot. A non-forced request is answered from cache while the
 * entry is younger than its TTL. A forced request is answered from cache while
 * the entry is younger than the minimum interval, so a refresh control cannot
 * start a process on every click. Concurrent requests for one slot share one
 * in-flight read, whatever their force flag. Failed reads are never cached.
 *
 * A missing required field fails the whole payload with `usage_payload_invalid`;
 * no partial list is returned. Epoch milliseconds become ISO strings on the way
 * out. Failure messages and log lines are scrubbed by `redactQuotaText`.
 */

import type {
  UsageClientBurn,
  UsageHistoryEntry,
  UsageHistoryMessage,
  UsageHistoryRequestMessage,
  UsageLimitsMessage,
  UsageStatsMessage,
  UsageStatsTotals,
} from '../../../core/src/messages.js';
import { CompanyError } from './companyError.js';
import {
  COMPANY_USAGE_HISTORY_MIN_INTERVAL_MS,
  COMPANY_USAGE_HISTORY_TIMEOUT_MS,
  COMPANY_USAGE_HISTORY_TTL_MS,
  COMPANY_USAGE_LIMITS_MIN_INTERVAL_MS,
  COMPANY_USAGE_LIMITS_TTL_MS,
  COMPANY_USAGE_STATS_MIN_INTERVAL_MS,
  COMPANY_USAGE_STATS_TIMEOUT_MS,
  COMPANY_USAGE_STATS_TTL_MS,
} from './constants.js';
import type { OmpRunnerCommand } from './ompRunner.js';
import type { QuotaRefreshResult, QuotaRunner, QuotaRunnerResult } from './quotaService.js';
import {
  defaultQuotaRunner,
  describeError,
  isoFromEpochMs,
  jsonFromOmpOutput,
  OmpQuotaService,
  redactQuotaText,
  resolveOmpCommand,
} from './quotaService.js';
import { ompJsonField, ompNumberField, ompStringField } from './usageService.js';

/** Days a history or clients window may cover; the page offers exactly these. */
export type UsageHistoryDays = UsageHistoryRequestMessage['days'];

/** Reply bodies: each contract message minus its envelope fields, which the dispatcher adds. */
export type UsageLimitsReply = Omit<UsageLimitsMessage, 'type' | 'requestId'>;
export type UsageHistoryReply = Omit<UsageHistoryMessage, 'type' | 'requestId'>;
export type UsageStatsReply = Omit<UsageStatsMessage, 'type' | 'requestId'>;

type UsageLimitsBody = Omit<UsageLimitsReply, 'cached'>;
type UsageStatsBody = Omit<UsageStatsReply, 'generatedAt'>;

/** Per-client metrics the page shows. Each is summed over that client's providers. */
export const USAGE_CLIENT_METRIC_KEYS = [
  'requests',
  'inputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'costUsd',
] as const;

export type UsageClientMetricKey = (typeof USAGE_CLIENT_METRIC_KEYS)[number];

/** Every usage read the page can request. Each returns a complete reply or throws a `CompanyError`. */
export interface UsageControl {
  limits(force: boolean): Promise<UsageLimitsReply>;
  history(days: UsageHistoryDays, force: boolean): Promise<UsageHistoryReply>;
  stats(force: boolean): Promise<UsageStatsReply>;
}

export interface UsageReaderOptions {
  /** The OMP command, resolved on every read. A throw answers `usage_unavailable`. */
  command: () => OmpRunnerCommand;
  /** Working directory for every read: the workspace. */
  cwd: string;
  /** Process boundary. Production uses `defaultQuotaRunner`; tests inject a fake. */
  runner?: QuotaRunner;
  /** Clock for cache age and `generatedAt`. */
  now?: () => number;
  /** Receives redacted diagnostics. */
  logger?: (message: string) => void;
}

/** `omp usage --history --days N --json --redact`: recorded limit snapshots for the window. */
export function usageHistoryArgv(days: UsageHistoryDays): readonly string[] {
  return ['usage', '--history', '--days', String(days), '--json', '--redact'];
}

/** `omp usage clients --days N --json --redact`: per-client token burn over the window. */
export function usageClientsArgv(days: UsageHistoryDays): readonly string[] {
  return ['usage', 'clients', '--days', String(days), '--json', '--redact'];
}

/** `omp stats --json`: the whole session-file history. OMP has no range flag for it. */
export function usageStatsArgv(): readonly string[] {
  return ['stats', '--json'];
}

type UsageFailureCode = 'usage_unavailable' | 'usage_read_failed' | 'usage_payload_invalid';

/** A failure the dispatcher reports by `errorCode`. The text is Vietnamese; the diagnostic is redacted. */
function usageFailure(code: UsageFailureCode, message: string): CompanyError {
  return new CompanyError(code, redactQuotaText(message));
}

function readFailed(detail: string): CompanyError {
  return usageFailure('usage_read_failed', `Không đọc được dữ liệu sử dụng token: ${detail}`);
}

function invalidPayload(where: string, detail: string): CompanyError {
  return usageFailure(
    'usage_payload_invalid',
    `Dữ liệu sử dụng token không đúng định dạng tại ${where}: ${detail}`,
  );
}

/** The JSON object of an OMP command's output; not JSON is a payload failure. */
function payloadOf(stdout: string, label: string): unknown {
  try {
    return jsonFromOmpOutput(stdout);
  } catch (err) {
    throw invalidPayload(label, `không phải JSON (${describeError(err)})`);
  }
}

function fieldNumber(source: unknown, key: string, where: string): number {
  const value = ompNumberField(source, key);
  if (value === undefined)
    throw invalidPayload(`${where}.${key}`, 'thiếu hoặc không phải số hữu hạn');
  return value;
}

/** An optional number: absent or null is omitted; any other value must be a finite number. */
function optionalFieldNumber(source: unknown, key: string, where: string): number | undefined {
  const raw = ompJsonField(source, key);
  if (raw === undefined || raw === null) return undefined;
  return fieldNumber(source, key, where);
}

function fieldString(source: unknown, key: string, where: string): string {
  const value = ompJsonField(source, key);
  if (typeof value !== 'string')
    throw invalidPayload(`${where}.${key}`, 'thiếu hoặc không phải chuỗi');
  return value;
}

function fieldArray(source: unknown, key: string, where: string): unknown[] {
  const value = ompJsonField(source, key);
  if (!Array.isArray(value))
    throw invalidPayload(`${where}.${key}`, 'thiếu hoặc không phải danh sách');
  return value;
}

function fieldObject(source: unknown, key: string, where: string): unknown {
  const value = ompJsonField(source, key);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalidPayload(`${where}.${key}`, 'thiếu hoặc không phải đối tượng');
  }
  return value;
}

function fieldTime(source: unknown, key: string, where: string): string {
  const iso = isoFromEpochMs(ompNumberField(source, key));
  if (iso === undefined)
    throw invalidPayload(`${where}.${key}`, 'thiếu hoặc không phải mốc thời gian (ms)');
  return iso;
}

/** Optional text. An empty string counts as absent. */
function optionalText(source: unknown, key: string): string | undefined {
  const value = ompStringField(source, key);
  return value === '' ? undefined : value;
}

/** Optional account text, masked the same way limit labels are. */
function optionalAccountText(source: unknown, key: string): string | undefined {
  const value = optionalText(source, key);
  return value === undefined ? undefined : redactQuotaText(value, 64);
}

function optionalTime(source: unknown, key: string): string | undefined {
  return isoFromEpochMs(ompNumberField(source, key));
}

/** `omp usage --history --days N --json --redact`: recorded limit snapshots, times as ISO. */
export function parseOmpHistoryPayload(
  stdout: string,
): Pick<UsageHistoryReply, 'sinceAt' | 'entries'> {
  const payload = payloadOf(stdout, 'usage history');
  return {
    sinceAt: fieldTime(payload, 'sinceMs', 'usage history'),
    entries: fieldArray(payload, 'entries', 'usage history').map((entry, index) =>
      historyEntry(entry, `usage history.entries[${index}]`),
    ),
  };
}

function historyEntry(entry: unknown, where: string): UsageHistoryEntry {
  const email = optionalAccountText(entry, 'email');
  const accountId = optionalAccountText(entry, 'accountId');
  const windowLabel = optionalText(entry, 'windowLabel');
  const status = optionalText(entry, 'status');
  const resetAt = optionalTime(entry, 'resetsAt');
  const usedFraction = optionalFieldNumber(entry, 'usedFraction', where);
  return {
    recordedAt: fieldTime(entry, 'recordedAt', where),
    provider: fieldString(entry, 'provider', where),
    accountKey: fieldString(entry, 'accountKey', where),
    ...(email === undefined ? {} : { email }),
    ...(accountId === undefined ? {} : { accountId }),
    limitId: fieldString(entry, 'limitId', where),
    label: fieldString(entry, 'label', where),
    ...(windowLabel === undefined ? {} : { windowLabel }),
    ...(usedFraction === undefined ? {} : { usedFraction }),
    ...(status === undefined ? {} : { status }),
    ...(resetAt === undefined ? {} : { resetAt }),
  };
}

/**
 * `omp usage clients --days N --json --redact`. A client is named by its hostname,
 * falling back to its install id; each metric is summed over that client's providers.
 */
export function parseOmpClientsPayload(stdout: string): UsageClientBurn[] {
  const payload = payloadOf(stdout, 'usage clients');
  return fieldArray(payload, 'clients', 'usage clients').map((client, index) =>
    clientBurn(client, `usage clients.clients[${index}]`),
  );
}

function clientBurn(client: unknown, where: string): UsageClientBurn {
  const hostname = optionalText(client, 'hostname');
  const totals: Record<UsageClientMetricKey, number> = {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
  };
  fieldArray(client, 'providers', where).forEach((provider, index) => {
    const at = `${where}.providers[${index}]`;
    for (const key of USAGE_CLIENT_METRIC_KEYS) {
      totals[key] += fieldNumber(provider, key, at);
    }
  });
  const name = hostname ?? fieldString(client, 'installId', where);
  return {
    name: redactQuotaText(name, 64),
    metrics: USAGE_CLIENT_METRIC_KEYS.map((key) => ({ key, value: totals[key] })),
  };
}

/**
 * `omp stats --json`. OMP's `modelSeries` has no slot in the contract and is not
 * read; every section the contract names is required.
 */
export function parseOmpStatsOutput(stdout: string): UsageStatsBody {
  const payload = payloadOf(stdout, 'stats');
  return {
    overall: statsTotals(fieldObject(payload, 'overall', 'stats'), 'stats.overall'),
    byModel: fieldArray(payload, 'byModel', 'stats').map((row, index) => {
      const where = `stats.byModel[${index}]`;
      return {
        model: fieldString(row, 'model', where),
        provider: fieldString(row, 'provider', where),
        totals: statsTotals(row, where),
      };
    }),
    byFolder: fieldArray(payload, 'byFolder', 'stats').map((row, index) => {
      const where = `stats.byFolder[${index}]`;
      return { folder: fieldString(row, 'folder', where), totals: statsTotals(row, where) };
    }),
    byAgentType: fieldArray(payload, 'byAgentType', 'stats').map((row, index) => {
      const where = `stats.byAgentType[${index}]`;
      return {
        agentType: fieldString(row, 'agentType', where),
        totalRequests: fieldNumber(row, 'totalRequests', where),
        totalInputTokens: fieldNumber(row, 'totalInputTokens', where),
        totalOutputTokens: fieldNumber(row, 'totalOutputTokens', where),
        totalCacheReadTokens: fieldNumber(row, 'totalCacheReadTokens', where),
        totalCacheWriteTokens: fieldNumber(row, 'totalCacheWriteTokens', where),
        totalCost: fieldNumber(row, 'totalCost', where),
      };
    }),
    timeSeries: fieldArray(payload, 'timeSeries', 'stats').map((point, index) => {
      const where = `stats.timeSeries[${index}]`;
      return {
        timestamp: fieldTime(point, 'timestamp', where),
        requests: fieldNumber(point, 'requests', where),
        errors: fieldNumber(point, 'errors', where),
        tokens: fieldNumber(point, 'tokens', where),
        cost: fieldNumber(point, 'cost', where),
      };
    }),
    modelPerformanceSeries: fieldArray(payload, 'modelPerformanceSeries', 'stats').map(
      (point, index) => {
        const where = `stats.modelPerformanceSeries[${index}]`;
        const avgTtft = optionalFieldNumber(point, 'avgTtft', where);
        const avgTokensPerSecond = optionalFieldNumber(point, 'avgTokensPerSecond', where);
        return {
          timestamp: fieldTime(point, 'timestamp', where),
          model: fieldString(point, 'model', where),
          provider: fieldString(point, 'provider', where),
          requests: fieldNumber(point, 'requests', where),
          ...(avgTtft === undefined ? {} : { avgTtft }),
          ...(avgTokensPerSecond === undefined ? {} : { avgTokensPerSecond }),
        };
      },
    ),
    costSeries: fieldArray(payload, 'costSeries', 'stats').map((point, index) => {
      const where = `stats.costSeries[${index}]`;
      return {
        timestamp: fieldTime(point, 'timestamp', where),
        model: fieldString(point, 'model', where),
        provider: fieldString(point, 'provider', where),
        cost: fieldNumber(point, 'cost', where),
        costInput: fieldNumber(point, 'costInput', where),
        costOutput: fieldNumber(point, 'costOutput', where),
        costCacheRead: fieldNumber(point, 'costCacheRead', where),
        costCacheWrite: fieldNumber(point, 'costCacheWrite', where),
        requests: fieldNumber(point, 'requests', where),
        unpricedRequests: fieldNumber(point, 'unpricedRequests', where),
      };
    }),
  };
}

/** Totals from one stats source (overall, a model row, or a folder row). */
function statsTotals(source: unknown, where: string): UsageStatsTotals {
  const firstAt = optionalTime(source, 'firstTimestamp');
  const lastAt = optionalTime(source, 'lastTimestamp');
  const avgDuration = optionalFieldNumber(source, 'avgDuration', where);
  const avgTtft = optionalFieldNumber(source, 'avgTtft', where);
  const avgTokensPerSecond = optionalFieldNumber(source, 'avgTokensPerSecond', where);
  return {
    totalRequests: fieldNumber(source, 'totalRequests', where),
    successfulRequests: fieldNumber(source, 'successfulRequests', where),
    failedRequests: fieldNumber(source, 'failedRequests', where),
    errorRate: fieldNumber(source, 'errorRate', where),
    totalInputTokens: fieldNumber(source, 'totalInputTokens', where),
    totalOutputTokens: fieldNumber(source, 'totalOutputTokens', where),
    totalCacheReadTokens: fieldNumber(source, 'totalCacheReadTokens', where),
    totalCacheWriteTokens: fieldNumber(source, 'totalCacheWriteTokens', where),
    cacheRate: fieldNumber(source, 'cacheRate', where),
    cacheSavings: fieldNumber(source, 'cacheSavings', where),
    totalCost: fieldNumber(source, 'totalCost', where),
    unpricedRequests: fieldNumber(source, 'unpricedRequests', where),
    totalPremiumRequests: fieldNumber(source, 'totalPremiumRequests', where),
    ...(avgDuration === undefined ? {} : { avgDuration }),
    ...(avgTtft === undefined ? {} : { avgTtft }),
    ...(avgTokensPerSecond === undefined ? {} : { avgTokensPerSecond }),
    ...(firstAt === undefined ? {} : { firstAt }),
    ...(lastAt === undefined ? {} : { lastAt }),
  };
}

/**
 * Map one limits refresh onto the reply. A read that produced nothing usable throws
 * and is never cached; a read that reports an account state returns it as is.
 */
function limitsBody(result: QuotaRefreshResult, generatedAt: string): UsageLimitsBody {
  const status = result.status;
  if (status === null) throw readFailed('chưa có kết quả đọc hạn mức.');
  if (status === 'invalid') {
    throw usageFailure(
      'usage_payload_invalid',
      `Dữ liệu hạn mức không đúng định dạng: ${result.message ?? ''}`,
    );
  }
  if (status === 'error' && result.snapshots.length === 0) {
    throw readFailed(result.message ?? 'lỗi không xác định.');
  }
  return {
    generatedAt,
    status,
    ...(status === 'available' || result.message === undefined ? {} : { message: result.message }),
    snapshots: result.snapshots,
    capacity: result.capacity,
  };
}

/**
 * Two windows per cache slot. A non-forced request accepts an entry younger than
 * `ttlMs`; a forced request accepts one younger than `forceMinIntervalMs`, so it
 * reads sooner than the TTL but never more often than the minimum interval.
 */
interface CacheWindows {
  ttlMs: number;
  forceMinIntervalMs: number;
}

/** One cached value per key, plus at most one in-flight read per key. Failed reads are not cached. */
class ReadCache<T> {
  readonly #entries = new Map<string, { value: T; readAt: number }>();
  readonly #inflight = new Map<string, Promise<T>>();
  readonly #windows: CacheWindows;
  readonly #now: () => number;

  constructor(windows: CacheWindows, now: () => number) {
    this.#windows = windows;
    this.#now = now;
  }

  async get(
    key: string,
    force: boolean,
    read: () => Promise<T>,
  ): Promise<{ value: T; cached: boolean }> {
    const running = this.#inflight.get(key);
    if (running !== undefined) return { value: await running, cached: false };

    const entry = this.#entries.get(key);
    const maxAgeMs = force ? this.#windows.forceMinIntervalMs : this.#windows.ttlMs;
    if (entry !== undefined && this.#now() - entry.readAt < maxAgeMs) {
      return { value: entry.value, cached: true };
    }

    const pending = read().then((value) => {
      this.#entries.set(key, { value, readAt: this.#now() });
      return value;
    });
    this.#inflight.set(key, pending);
    try {
      return { value: await pending, cached: false };
    } finally {
      this.#inflight.delete(key);
    }
  }
}

class OmpUsageReader implements UsageControl {
  readonly #command: () => OmpRunnerCommand;
  readonly #cwd: string;
  readonly #runner: QuotaRunner;
  readonly #now: () => number;
  readonly #logger: ((message: string) => void) | undefined;
  readonly #quota: OmpQuotaService;
  readonly #limitsCache: ReadCache<UsageLimitsBody>;
  readonly #historyCache: ReadCache<UsageHistoryReply>;
  readonly #statsCache: ReadCache<UsageStatsReply>;

  constructor(options: UsageReaderOptions) {
    this.#command = options.command;
    this.#cwd = options.cwd;
    this.#runner = options.runner ?? defaultQuotaRunner;
    this.#now = options.now ?? (() => Date.now());
    this.#logger = options.logger;
    this.#quota = new OmpQuotaService({
      command: this.#command,
      cwd: this.#cwd,
      runner: this.#runner,
      now: this.#now,
      minRefreshMs: COMPANY_USAGE_LIMITS_MIN_INTERVAL_MS,
      logger: this.#logger,
    });
    this.#limitsCache = new ReadCache(
      {
        ttlMs: COMPANY_USAGE_LIMITS_TTL_MS,
        forceMinIntervalMs: COMPANY_USAGE_LIMITS_MIN_INTERVAL_MS,
      },
      this.#now,
    );
    this.#historyCache = new ReadCache(
      {
        ttlMs: COMPANY_USAGE_HISTORY_TTL_MS,
        forceMinIntervalMs: COMPANY_USAGE_HISTORY_MIN_INTERVAL_MS,
      },
      this.#now,
    );
    this.#statsCache = new ReadCache(
      {
        ttlMs: COMPANY_USAGE_STATS_TTL_MS,
        forceMinIntervalMs: COMPANY_USAGE_STATS_MIN_INTERVAL_MS,
      },
      this.#now,
    );
  }

  async limits(force: boolean): Promise<UsageLimitsReply> {
    const read = await this.#limitsCache.get('limits', force, () => this.#readLimits());
    return { ...read.value, cached: read.cached };
  }

  async history(days: UsageHistoryDays, force: boolean): Promise<UsageHistoryReply> {
    const read = await this.#historyCache.get(String(days), force, () => this.#readHistory(days));
    return read.value;
  }

  async stats(force: boolean): Promise<UsageStatsReply> {
    const read = await this.#statsCache.get('stats', force, () => this.#readStats());
    return read.value;
  }

  #readLimits(): Promise<UsageLimitsBody> {
    return this.#logged('limits', async () => {
      const result = await this.#quota.refresh();
      return limitsBody(result, this.#iso());
    });
  }

  #readHistory(days: UsageHistoryDays): Promise<UsageHistoryReply> {
    return this.#logged(`history ${days}d`, async () => {
      const [historyStdout, clientsStdout] = await Promise.all([
        this.#runOmp(usageHistoryArgv(days), COMPANY_USAGE_HISTORY_TIMEOUT_MS, 'usage history'),
        this.#runOmp(usageClientsArgv(days), COMPANY_USAGE_HISTORY_TIMEOUT_MS, 'usage clients'),
      ]);
      const history = parseOmpHistoryPayload(historyStdout);
      return {
        generatedAt: this.#iso(),
        sinceAt: history.sinceAt,
        days,
        entries: history.entries,
        clients: parseOmpClientsPayload(clientsStdout),
      };
    });
  }

  #readStats(): Promise<UsageStatsReply> {
    return this.#logged('stats', async () => {
      const stdout = await this.#runOmp(usageStatsArgv(), COMPANY_USAGE_STATS_TIMEOUT_MS, 'stats');
      return { generatedAt: this.#iso(), ...parseOmpStatsOutput(stdout) };
    });
  }

  /** Run one OMP read through the runner. Any non-zero exit, timeout, or spawn failure is `usage_read_failed`. */
  async #runOmp(argv: readonly string[], timeoutMs: number, label: string): Promise<string> {
    const command = resolveOmpCommand(this.#command);
    let result: QuotaRunnerResult;
    try {
      result = await this.#runner({
        executable: command.file,
        argv: [...command.args, ...argv],
        cwd: this.#cwd,
        timeoutMs,
      });
    } catch (err) {
      throw readFailed(`${label} không khởi chạy được: ${describeError(err)}`);
    }
    if (result.timedOut) throw readFailed(`${label} quá thời gian ${timeoutMs} ms.`);
    if (result.exitCode !== 0) {
      const detail = result.stderr.trim() || 'không có thông báo lỗi.';
      throw readFailed(`${label} thoát với mã ${result.exitCode ?? 'null'}: ${detail}`);
    }
    return result.stdout;
  }

  async #logged<T>(label: string, read: () => Promise<T>): Promise<T> {
    try {
      return await read();
    } catch (err) {
      this.#logger?.(`[Usage] ${label} failed: ${redactQuotaText(describeError(err))}`);
      throw err;
    }
  }

  #iso(): string {
    return new Date(this.#now()).toISOString();
  }
}

/** The usage reader the server wires into the dispatcher. Nothing runs until a method is called. */
export function createUsageReader(options: UsageReaderOptions): UsageControl {
  return new OmpUsageReader(options);
}

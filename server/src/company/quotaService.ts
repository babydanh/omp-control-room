/**
 * quotaService: provider quota, read on demand and never guessed at.
 *
 * `omp usage --json --redact` is the only source of truth for a provider's
 * quota windows, and it is account scoped, not a per-session budget. The
 * service therefore never attributes a window to a session, never divides one
 * across sessions, and never fills a missing number with 0. A provider with no
 * usage endpoint reads `unsupported`, a disabled credential reads
 * `unauthenticated`, and a failed read keeps the last good snapshots marked
 * `stale` so the page shows how old the numbers are.
 *
 * Snapshots are keyed by provider and account, so two accounts of one provider
 * are two rows, never one overwriting the other.
 *
 * A refresh runs only when a caller asks (the usage reader's cache decides
 * that). It is rate limited to one process per
 * {@link COMPANY_USAGE_LIMITS_MIN_INTERVAL_MS}. The command runs through
 * `execFile` with `shell: false` and a literal argv, and it is killed on
 * timeout instead of being awaited forever.
 *
 * No credential file is read here. `--redact` asks OMP to mask account
 * identity before it reaches us, and error text is scrubbed of token-shaped
 * strings before it is logged or stored.
 */

import { execFile } from 'node:child_process';

import type { QuotaCapacityRow, QuotaSnapshot, QuotaWindow } from '../../../core/src/messages.js';
import { CompanyError } from './companyError.js';
import { COMPANY_QUOTA_TIMEOUT_MS, COMPANY_USAGE_LIMITS_MIN_INTERVAL_MS } from './constants.js';
import type { OmpRunnerCommand } from './ompRunner.js';
import { ompArrayField, ompJsonField, ompNumberField, ompStringField } from './usageService.js';

/** The literal argv, quoted here so a caller cannot smuggle shell syntax. */
export const OMP_USAGE_ARGV: readonly string[] = ['usage', '--json', '--redact'];

const NOTE_NO_USAGE_ENDPOINT = 'Nhà cung cấp này không công bố điểm đo hạn mức.';
const NOTE_DISABLED_CREDENTIAL = 'Thông tin đăng nhập đã bị tắt.';

/**
 * How one limits read ended. `invalid` means the payload was not the documented
 * shape; `error` means the command failed or printed nothing usable.
 */
export type QuotaOutcomeKind =
  'available' | 'unsupported' | 'unauthenticated' | 'error' | 'invalid';

/** What one limits payload said, already parsed. */
export type QuotaRefreshOutcome = {
  kind: QuotaOutcomeKind;
  /** Account snapshots the payload names; empty when it names none. */
  snapshots: QuotaSnapshot[];
  /** Capacity rows the payload reports; empty when it reports none. */
  capacity: QuotaCapacityRow[];
  /** Redacted diagnostic, safe to log and to show. */
  message: string;
};

/** The state a caller renders, whether or not an attempt ran. */
export interface QuotaRefreshResult {
  /** True when a process actually ran; false when the cooldown refused it. */
  ran: boolean;
  /** Why the request did not run, when `ran` is false. */
  skipped?: 'cooldown';
  /** How the attempt in force ended; null until one has run. */
  status: QuotaOutcomeKind | null;
  /** Redacted diagnostic of the attempt in force; absent until one has run. */
  message?: string;
  snapshots: QuotaSnapshot[];
  capacity: QuotaCapacityRow[];
  /** Wall-clock ms the process took; 0 when the cooldown refused it. */
  elapsedMs: number;
  /** Epoch ms before which the next refresh will not spawn a process. */
  nextAllowedAt: number;
}

/** A single command invocation, fully resolved and literal. */
export interface QuotaRunnerRequest {
  executable: string;
  argv: readonly string[];
  cwd: string;
  timeoutMs: number;
}

/** What a runner reports back. `exitCode` is null when the process never exited normally. */
export interface QuotaRunnerResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

/** Runs one command. Production uses {@link defaultQuotaRunner}; tests inject a fake. */
export type QuotaRunner = (request: QuotaRunnerRequest) => Promise<QuotaRunnerResult>;

export interface QuotaServiceOptions {
  /** The resolved OMP command, read on every refresh; `args` lead the argv, `file` is the executable. */
  command: () => OmpRunnerCommand;
  /** Working directory for the command: the workspace. */
  cwd: string;
  now?: () => number;
  runner?: QuotaRunner;
  /** Minimum ms between two real refreshes. Defaults to COMPANY_USAGE_LIMITS_MIN_INTERVAL_MS. */
  minRefreshMs?: number;
  /** Per-attempt deadline. Defaults to COMPANY_QUOTA_TIMEOUT_MS. */
  timeoutMs?: number;
  logger?: (message: string) => void;
}

/**
 * Runs `execFile` with a literal argv, `shell: false`, and a kill on timeout.
 * Exported because the other OMP probes share the same boundary.
 */
export const defaultQuotaRunner: QuotaRunner = (request) =>
  new Promise((resolve) => {
    execFile(
      request.executable,
      [...request.argv],
      {
        cwd: request.cwd,
        timeout: request.timeoutMs,
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
        // Never true: a provider name or path must not be able to inject a shell
        // fragment, and the argv above is already fully literal.
        shell: false,
      },
      (error, stdout, stderr) => {
        resolve({
          stdout,
          stderr,
          // A spawn failure (ENOENT, EACCES) reports a string code and leaves
          // `exitCode` null, which the parser reads as "no output, no exit".
          exitCode: error === null ? 0 : (ompNumberField(error, 'code') ?? null),
          timedOut: ompJsonField(error, 'killed') === true,
        });
      },
    );
  });

export interface QuotaService {
  /** Refresh provider quota. Resolves without spawning while the cooldown holds, returning the stored state. */
  refresh(): Promise<QuotaRefreshResult>;
  /** Latest snapshot per account, in insertion order; a stale one is included. */
  snapshots(): QuotaSnapshot[];
  /** Epoch ms before which `refresh` will not spawn a process. */
  nextAllowedAt(): number;
}

const SECRET_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  /\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/gi,
  /\b(?:api[_-]?key|auth[_-]?token|access[_-]?token|refresh[_-]?token|client[_-]?secret)"?\s*[:=]\s*"?[^\s",}]{8,}/gi,
  /\bey[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  /\b[A-Fa-f0-9]{40,}\b/g,
];

/**
 * Scrub anything token-shaped from text that may reach a log or a reply, then
 * cap its length. Account labels reuse this with a smaller cap.
 */
export function redactQuotaText(text: string, maxLength = 400): string {
  let redacted = text;
  for (const pattern of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, '[redacted]');
  }
  return redacted.length > maxLength ? `${redacted.slice(0, maxLength)}…` : redacted;
}

/** Message text of an unknown thrown value. */
export function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** ISO time for an epoch-ms value; undefined when the value is absent or not a date. */
export function isoFromEpochMs(epochMs: number | undefined): string | undefined {
  if (epochMs === undefined) return undefined;
  const date = new Date(epochMs);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/**
 * The JSON object an OMP command printed. Some commands print progress lines
 * (`Syncing session files...`) before the payload, so the object starts at the
 * first line that begins with `{`. Throws when there is no such line or it does
 * not parse.
 */
export function jsonFromOmpOutput(stdout: string): unknown {
  const start = stdout.search(/^\{/m);
  if (start === -1) throw new SyntaxError('no JSON object line in output');
  return JSON.parse(stdout.slice(start));
}

/**
 * Resolve the OMP command for one read. A throw from the resolver, or a command
 * with no executable, is `usage_unavailable`: nothing was spawned.
 */
export function resolveOmpCommand(command: () => OmpRunnerCommand): OmpRunnerCommand {
  let resolved: OmpRunnerCommand;
  try {
    resolved = command();
  } catch (err) {
    throw new CompanyError(
      'usage_unavailable',
      redactQuotaText(`Không chạy được lệnh OMP: ${describeError(err)}`),
    );
  }
  if (resolved.file.trim() === '') {
    throw new CompanyError('usage_unavailable', 'Không chạy được lệnh OMP: chưa có tệp thực thi.');
  }
  return resolved;
}

export class OmpQuotaService implements QuotaService {
  readonly #command: () => OmpRunnerCommand;
  readonly #cwd: string;
  readonly #now: () => number;
  readonly #runner: QuotaRunner;
  readonly #minRefreshMs: number;
  readonly #timeoutMs: number;
  readonly #logger: ((message: string) => void) | undefined;
  /** Latest snapshot per account, keyed so one account never overwrites another. */
  readonly #snapshots = new Map<string, QuotaSnapshot>();
  #capacity: QuotaCapacityRow[] = [];
  #lastAttemptAt = Number.NEGATIVE_INFINITY;
  /** Outcome of the attempt in force; null until one has run. */
  #lastOutcome: { kind: QuotaOutcomeKind; message: string } | null = null;

  constructor(options: QuotaServiceOptions) {
    this.#command = options.command;
    this.#cwd = options.cwd;
    this.#now = options.now ?? (() => Date.now());
    this.#runner = options.runner ?? defaultQuotaRunner;
    this.#minRefreshMs = options.minRefreshMs ?? COMPANY_USAGE_LIMITS_MIN_INTERVAL_MS;
    this.#timeoutMs = options.timeoutMs ?? COMPANY_QUOTA_TIMEOUT_MS;
    this.#logger = options.logger;
  }

  async refresh(): Promise<QuotaRefreshResult> {
    const startedAt = this.#now();
    const ran = startedAt >= this.nextAllowedAt();
    if (ran) {
      await this.#attempt(startedAt);
    }
    return {
      ran,
      ...(ran ? {} : { skipped: 'cooldown' as const }),
      status: this.#lastOutcome?.kind ?? null,
      ...(this.#lastOutcome === null ? {} : { message: this.#lastOutcome.message }),
      snapshots: this.snapshots(),
      capacity: [...this.#capacity],
      elapsedMs: ran ? this.#now() - startedAt : 0,
      nextAllowedAt: this.nextAllowedAt(),
    };
  }

  snapshots(): QuotaSnapshot[] {
    return [...this.#snapshots.values()];
  }

  nextAllowedAt(): number {
    return this.#lastAttemptAt + this.#minRefreshMs;
  }

  /** Run one OMP attempt and store what it said. Callers check the cooldown first. */
  async #attempt(startedAt: number): Promise<void> {
    // Resolved before the cooldown is consumed: a command that cannot be
    // resolved spawns nothing, so it may be retried at once.
    const command = resolveOmpCommand(this.#command);
    // Set before the spawn so a failed launch still consumes the cooldown: a
    // missing executable must not become one process per request.
    this.#lastAttemptAt = startedAt;

    let result: QuotaRunnerResult | undefined;
    let spawnError: string | undefined;
    try {
      result = await this.#runner({
        executable: command.file,
        argv: [...command.args, ...OMP_USAGE_ARGV],
        cwd: this.#cwd,
        timeoutMs: this.#timeoutMs,
      });
    } catch (err) {
      spawnError = describeError(err);
    }

    const outcome: QuotaRefreshOutcome =
      spawnError !== undefined
        ? {
            kind: 'error',
            snapshots: [],
            capacity: [],
            message: redactQuotaText(`Quota command failed to start: ${spawnError}`),
          }
        : result !== undefined && result.timedOut
          ? {
              kind: 'error',
              snapshots: [],
              capacity: [],
              message: `Quota command timed out after ${this.#timeoutMs}ms.`,
            }
          : parseOmpUsagePayload(
              result?.stdout ?? '',
              result?.stderr ?? '',
              result?.exitCode ?? null,
            );

    this.#apply(outcome);
    this.#lastOutcome = { kind: outcome.kind, message: outcome.message };
    if (outcome.kind !== 'available') {
      this.#logger?.(`[Quota] ${outcome.kind}: ${redactQuotaText(outcome.message)}`);
    }
  }

  #apply(outcome: QuotaRefreshOutcome): void {
    if (outcome.kind === 'error' || outcome.kind === 'invalid') {
      // Nothing new was learned: the previous numbers stay, relabelled stale,
      // with the capacity they had.
      this.#markAll('stale');
      return;
    }
    if (outcome.kind === 'available') {
      // A full report is authoritative for every account it names.
      this.#snapshots.clear();
    }
    outcome.snapshots.forEach((snapshot, position) => {
      // Keyed by account id. A snapshot with no account id keys by its position
      // in the payload: stable for one payload, not across payloads.
      const key =
        snapshot.accountId === undefined
          ? `${snapshot.provider}\u0000#${position}`
          : `${snapshot.provider}\u0000${snapshot.accountId}`;
      this.#snapshots.set(key, snapshot);
    });
    if (outcome.kind !== 'available' && outcome.snapshots.length === 0) {
      this.#markAll(outcome.kind);
    }
    this.#capacity = outcome.capacity;
  }

  #markAll(status: QuotaSnapshot['status']): void {
    for (const [key, snapshot] of this.#snapshots) {
      if (snapshot.status === status) continue;
      this.#snapshots.set(key, { ...snapshot, status });
    }
  }
}

/**
 * Parse one `omp usage --json --redact` attempt into an outcome. Exit 0 with a
 * payload of the wrong shape is `invalid`; a failed command with no JSON is
 * `error`. The payload's own `accountsWithoutUsage` and `disabledCredentials`
 * lists become typed snapshots, never silently dropped.
 */
export function parseOmpUsagePayload(
  stdout: string,
  stderr: string,
  exitCode: number | null,
): QuotaRefreshOutcome {
  if (stdout.trim().length === 0) {
    const message = stderr.trim();
    if (
      exitCode !== 0 &&
      /no credentials|not (?:logged in|authenticated)|unauthorized/i.test(message)
    ) {
      return {
        kind: 'unauthenticated',
        snapshots: [],
        capacity: [],
        message: redactQuotaText(message),
      };
    }
    if (exitCode !== 0 && /without a usage endpoint|no usage data/i.test(message)) {
      return {
        kind: 'unsupported',
        snapshots: [],
        capacity: [],
        message: redactQuotaText(message),
      };
    }
    return {
      kind: 'error',
      snapshots: [],
      capacity: [],
      message: redactQuotaText(message || 'Quota command produced no output.'),
    };
  }

  let payload: unknown;
  try {
    payload = jsonFromOmpOutput(stdout);
  } catch (err) {
    if (exitCode !== 0) {
      return {
        kind: 'error',
        snapshots: [],
        capacity: [],
        message: redactQuotaText(
          `Quota command exited with code ${exitCode ?? 'null'} and printed no JSON: ${stderr.trim()}`,
        ),
      };
    }
    return {
      kind: 'invalid',
      snapshots: [],
      capacity: [],
      message: redactQuotaText(`Quota payload is not JSON: ${describeError(err)}`),
    };
  }

  if (!Array.isArray(ompJsonField(payload, 'reports'))) {
    return {
      kind: 'invalid',
      snapshots: [],
      capacity: [],
      message: 'Quota payload has no reports list.',
    };
  }
  const capacity = capacityRows(payload);
  if (capacity === null) {
    return {
      kind: 'invalid',
      snapshots: [],
      capacity: [],
      message: 'Quota payload capacity is not the documented shape.',
    };
  }

  const reports = ompArrayField(payload, 'reports');
  const accountsWithoutUsage = ompArrayField(payload, 'accountsWithoutUsage');
  const disabledCredentials = ompArrayField(payload, 'disabledCredentials');
  const fetchedAtFallback =
    isoFromEpochMs(ompNumberField(payload, 'generatedAt')) ?? new Date().toISOString();

  const typedEntries: { entry: unknown; status: QuotaSnapshot['status']; note: string }[] = [
    ...accountsWithoutUsage.map((entry) => ({
      entry,
      status: 'unsupported' as const,
      note: NOTE_NO_USAGE_ENDPOINT,
    })),
    ...disabledCredentials.map((entry) => ({
      entry,
      status: 'unauthenticated' as const,
      note: NOTE_DISABLED_CREDENTIAL,
    })),
  ];
  const snapshots: QuotaSnapshot[] = [
    ...reports.map((report): QuotaSnapshot => ({
      provider: ompStringField(report, 'provider') || 'unknown',
      ...accountFields(ompJsonField(report, 'metadata')),
      windows: ompArrayField(report, 'limits').map(windowFromLimit),
      fetchedAt: isoFromEpochMs(ompNumberField(report, 'fetchedAt')) ?? fetchedAtFallback,
      status: 'available',
    })),
    // A provider the payload names without quota windows: a typed state, never a window.
    ...typedEntries.map(({ entry, status, note }): QuotaSnapshot => ({
      provider: ompStringField(entry, 'provider') || 'unknown',
      ...accountFields(entry),
      note,
      windows: [],
      fetchedAt: fetchedAtFallback,
      status,
    })),
  ];

  if (reports.length > 0) {
    return {
      kind: 'available',
      snapshots,
      capacity,
      message: `Reported quota for ${reports.length} account report(s).`,
    };
  }
  if (accountsWithoutUsage.length > 0) {
    return {
      kind: 'unsupported',
      snapshots,
      capacity,
      message: 'Stored credentials belong to providers without a usage endpoint.',
    };
  }
  if (disabledCredentials.length > 0) {
    return {
      kind: 'unauthenticated',
      snapshots,
      capacity,
      message: 'Every stored credential for a usage-reporting provider is disabled.',
    };
  }
  return {
    kind: 'unauthenticated',
    snapshots,
    capacity,
    message: 'No credentials found for any usage-reporting provider.',
  };
}

/** Account identity from an OMP `metadata` or typed entry, already masked by `--redact`. */
function accountFields(source: unknown): { accountId?: string; accountLabel?: string } {
  const accountId = ompStringField(source, 'accountId');
  const email = ompStringField(source, 'email');
  const label = email || accountId;
  return {
    ...(accountId === '' ? {} : { accountId: redactQuotaText(accountId, 64) }),
    ...(label === '' ? {} : { accountLabel: redactQuotaText(label, 64) }),
  };
}

function windowFromLimit(limit: unknown): QuotaWindow {
  const scope = ompJsonField(limit, 'scope');
  const window = ompJsonField(limit, 'window');
  const amount = ompJsonField(limit, 'amount');
  const id = ompStringField(limit, 'id') || ompStringField(scope, 'windowId') || 'window';
  const windowLabel = ompStringField(window, 'label');
  const shared = ompJsonField(scope, 'shared');
  const tier = ompStringField(scope, 'tier');
  const durationMs = ompNumberField(window, 'durationMs');
  const used = ompNumberField(amount, 'used');
  const limitAmount = ompNumberField(amount, 'limit');
  const remaining = ompNumberField(amount, 'remaining');
  const usedFraction = ompNumberField(amount, 'usedFraction');
  const resetAt = isoFromEpochMs(ompNumberField(window, 'resetsAt'));
  const status = ompStringField(limit, 'status');
  return {
    id,
    label: ompStringField(limit, 'label') || windowLabel || id,
    ...(windowLabel === '' ? {} : { windowLabel }),
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(typeof shared === 'boolean' ? { shared } : {}),
    ...(tier === '' ? {} : { tier }),
    ...(used === undefined ? {} : { used }),
    ...(limitAmount === undefined ? {} : { limit: limitAmount }),
    ...(remaining === undefined ? {} : { remaining }),
    ...(usedFraction === undefined ? {} : { usedFraction }),
    ...(resetAt === undefined ? {} : { resetAt }),
    // The provider's own unit (credits, percent, tokens), never converted to a
    // unit the provider did not report.
    reportedUnit: ompStringField(amount, 'unit') || 'unknown',
    ...(status === '' ? {} : { status }),
  };
}

/**
 * Capacity rows across providers. An absent `capacity` is an empty list; a
 * present one that is not the documented shape is null, which the caller
 * reports as `invalid`.
 */
function capacityRows(payload: unknown): QuotaCapacityRow[] | null {
  const capacity = ompJsonField(payload, 'capacity');
  if (capacity === undefined) return [];
  if (typeof capacity !== 'object' || capacity === null || Array.isArray(capacity)) return null;
  const rows: QuotaCapacityRow[] = [];
  for (const [provider, list] of Object.entries(capacity as Record<string, unknown>)) {
    if (!Array.isArray(list)) return null;
    for (const row of list) {
      const parsed = capacityRow(provider, row);
      if (parsed === null) return null;
      rows.push(parsed);
    }
  }
  return rows;
}

function capacityRow(provider: string, row: unknown): QuotaCapacityRow | null {
  const window = ompStringField(row, 'window');
  const durationMs = ompNumberField(row, 'durationMs');
  const accounts = ompNumberField(row, 'accounts');
  const usedAccounts = ompNumberField(row, 'usedAccounts');
  const remainingAccounts = ompNumberField(row, 'remainingAccounts');
  const meter = ompStringField(row, 'meter');
  if (
    window === '' ||
    durationMs === undefined ||
    accounts === undefined ||
    usedAccounts === undefined ||
    remainingAccounts === undefined
  ) {
    return null;
  }
  return {
    provider,
    window,
    durationMs,
    ...(meter === '' ? {} : { meter }),
    accounts,
    usedAccounts,
    remainingAccounts,
  };
}

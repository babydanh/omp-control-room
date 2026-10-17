/**
 * quotaService: provider quota, read on demand and never guessed at.
 *
 * `omp usage --json --redact` is the only source of truth for a provider's
 * quota windows, and it is account/provider scoped -- it is not a per-session
 * budget. The service therefore never attributes a quota window to a session,
 * never divides one across sessions, and never fills a missing number with 0:
 * an unsupported provider reads `unsupported`, a provider with no credential
 * reads `unauthenticated`, and a timeout keeps the last good snapshot but marks
 * it `stale` so the panel shows how old the numbers are.
 *
 * The refresh is explicit (an opened UsagePanel or a user click) and rate
 * limited to one process per {@link COMPANY_QUOTA_MIN_REFRESH_MS}. The command
 * runs through `execFile` with `shell: false` and a literal argv, so nothing a
 * user types can become a shell fragment, and it is killed on timeout instead of
 * being awaited forever.
 *
 * No credential file is ever read. `--redact` asks OMP to mask account identity
 * before it reaches us, and error text is scrubbed of anything token-shaped
 * before it is logged or stored.
 */

import { execFile } from 'node:child_process';

import type { QuotaSnapshot, QuotaWindow } from '../../../core/src/company.js';
import { COMPANY_QUOTA_MIN_REFRESH_MS, COMPANY_QUOTA_TIMEOUT_MS } from './constants.js';
import { ompArrayField, ompJsonField, ompNumberField, ompStringField } from './usageService.js';

/** The literal argv, quoted here so a caller cannot smuggle shell syntax. */
export const OMP_USAGE_ARGV: readonly string[] = ['usage', '--json', '--redact'];

/** How a refresh attempt ended. */
export type QuotaRefreshOutcome = {
  kind: 'available' | 'unsupported' | 'unauthenticated' | 'error';
  /** Provider snapshots the payload names; empty when it names none. */
  snapshots: QuotaSnapshot[];
  /** Redacted diagnostic, safe to log. */
  message: string;
};

/** Result of a refresh request, including the cooldown short-circuit. */
export interface QuotaRefreshResult {
  /** True when a process actually ran, false when the cooldown refused it. */
  ran: boolean;
  /** Why the request did not run, when `ran` is false. */
  skipped?: 'cooldown';
  /** How the attempt ended; null until one has run. A skipped refresh repeats it. */
  status: QuotaRefreshOutcome['kind'] | null;
  snapshots: QuotaSnapshot[];
  /** Wall-clock ms the running process took. */
  elapsedMs: number;
  /** Epoch ms of the next allowed refresh attempt. */
  nextAllowedAt: number;
}

/** Runs the quota command. The only place a process is spawned. */
export type QuotaRunner = (request: QuotaRunnerRequest) => Promise<QuotaRunnerResult>;

export interface QuotaRunnerRequest {
  executable: string;
  argv: readonly string[];
  cwd: string;
  timeoutMs: number;
}

export interface QuotaRunnerResult {
  stdout: string;
  stderr: string;
  /** null when the process was killed before it exited. */
  exitCode: number | null;
  timedOut: boolean;
}

export interface QuotaServiceOptions {
  /** Absolute path to the resolved OMP executable. Never a shell string. */
  executable: string;
  /** Working directory for the command; the workspace, never a temp guess. */
  cwd: string;
  /** Injectable clock, so the cooldown is testable without real waiting. */
  now?: () => number;
  /** Injectable process boundary, so tests never spawn OMP. */
  runner?: QuotaRunner;
  /** Minimum ms between two real refreshes. Defaults to 300_000. */
  minRefreshMs?: number;
  /** Per-attempt deadline. Defaults to 20_000. */
  timeoutMs?: number;
  /** Redacts the command line before it is logged. */
  logger?: (message: string) => void;
}

/**
 * The real process boundary: `execFile` with `shell: false`, a literal argv and
 * a timeout that actually kills the child.
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

/**
 * Quota state for one provider, kept across refreshes so a failed fetch shows
 * the previous numbers marked stale instead of blanking the panel.
 */
export interface QuotaService {
  /**
   * Refresh provider quota. Resolves without spawning when the cooldown has not
   * elapsed, returning the current snapshots so a caller can render either way.
   */
  refresh(): Promise<QuotaRefreshResult>;
  /** Latest snapshot per provider, in insertion order. */
  snapshots(): QuotaSnapshot[];
  /** The last snapshot for one provider, including a stale one. */
  snapshotFor(provider: string): QuotaSnapshot | undefined;
  /** Epoch ms before which `refresh` will not spawn a process. */
  nextAllowedAt(): number;
}

/**
 * Patterns scrubbed from any text that came out of the quota command. OMP's own
 * `--redact` masks account identity, but a crash message can still carry a token
 * or a key, and that text is logged and stored.
 */
const SECRET_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  /\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/gi,
  /\b(?:api[_-]?key|auth[_-]?token|access[_-]?token|refresh[_-]?token|client[_-]?secret)"?\s*[:=]\s*"?[^\s",}]{8,}/gi,
  /\bey[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  /\b[A-Fa-f0-9]{40,}\b/g,
];

/** Redact token-shaped text and cap its length. */
export function redactQuotaText(text: string, maxLength = 400): string {
  let redacted = text;
  for (const pattern of SECRET_PATTERNS) redacted = redacted.replace(pattern, '[redacted]');
  return redacted.length > maxLength ? `${redacted.slice(0, maxLength)}…` : redacted;
}

/**
 * Read a provider's quota limits.
 *
 * One instance per workspace; the coordinator holds it and the UsagePanel
 * refreshes through it.
 */
export class OmpQuotaService implements QuotaService {
  readonly #executable: string;
  readonly #cwd: string;
  readonly #minRefreshMs: number;
  readonly #timeoutMs: number;
  readonly #logger: ((message: string) => void) | undefined;
  readonly #runner: QuotaRunner;
  readonly #now: () => number;
  readonly #snapshots = new Map<string, QuotaSnapshot>();
  #lastAttemptAt = Number.NEGATIVE_INFINITY;
  /** Status of the attempt in force; null until one has run. */
  #lastStatus: QuotaRefreshOutcome['kind'] | null = null;

  constructor(options: QuotaServiceOptions) {
    this.#executable = options.executable;
    this.#cwd = options.cwd;
    this.#minRefreshMs = options.minRefreshMs ?? COMPANY_QUOTA_MIN_REFRESH_MS;
    this.#timeoutMs = options.timeoutMs ?? COMPANY_QUOTA_TIMEOUT_MS;
    this.#logger = options.logger;
    this.#runner = options.runner ?? defaultQuotaRunner;
    this.#now = options.now ?? (() => Date.now());
  }

  async refresh(): Promise<QuotaRefreshResult> {
    const startedAt = this.#now();
    const nextAllowedAt = this.#lastAttemptAt + this.#minRefreshMs;
    if (startedAt < nextAllowedAt) {
      return {
        ran: false,
        skipped: 'cooldown',
        status: this.#lastStatus,
        snapshots: this.snapshots(),
        elapsedMs: 0,
        nextAllowedAt,
      };
    }
    // Set before the spawn so a failed launch still consumes the cooldown: a
    // missing executable must not become one process per panel render.
    this.#lastAttemptAt = startedAt;

    let result: QuotaRunnerResult | undefined;
    let spawnError: string | undefined;
    try {
      result = await this.#runner({
        executable: this.#executable,
        argv: OMP_USAGE_ARGV,
        cwd: this.#cwd,
        timeoutMs: this.#timeoutMs,
      });
    } catch (err) {
      spawnError = String(err);
    }

    const outcome: QuotaRefreshOutcome =
      spawnError !== undefined
        ? { kind: 'error', snapshots: [], message: `Quota command failed to start: ${spawnError}` }
        : result !== undefined && result.timedOut
          ? {
              kind: 'error',
              snapshots: [],
              message: `Quota command timed out after ${this.#timeoutMs}ms.`,
            }
          : parseOmpUsagePayload(
              result?.stdout ?? '',
              result?.stderr ?? '',
              result?.exitCode ?? null,
            );

    if (outcome.kind === 'error') {
      // Nothing was learned. The previous windows stay, relabelled stale so the
      // panel shows real numbers together with their age.
      this.#markAll('stale');
    } else if (outcome.kind === 'available') {
      // A full report is authoritative for every provider it names.
      this.#snapshots.clear();
      for (const snapshot of outcome.snapshots) this.#snapshots.set(snapshot.provider, snapshot);
    } else {
      // A typed per-provider state replaces that provider only; a provider the
      // payload never mentioned keeps the windows it last really had.
      for (const snapshot of outcome.snapshots) this.#snapshots.set(snapshot.provider, snapshot);
      if (outcome.snapshots.length === 0) this.#markAll(outcome.kind);
    }
    if (outcome.kind !== 'available') {
      this.#logger?.(`[Quota] ${outcome.kind}: ${redactQuotaText(outcome.message)}`);
    }
    this.#lastStatus = outcome.kind;

    return {
      ran: true,
      status: outcome.kind,
      snapshots: this.snapshots(),
      elapsedMs: this.#now() - startedAt,
      nextAllowedAt,
    };
  }

  snapshots(): QuotaSnapshot[] {
    return [...this.#snapshots.values()];
  }

  snapshotFor(provider: string): QuotaSnapshot | undefined {
    return this.#snapshots.get(provider);
  }

  nextAllowedAt(): number {
    return this.#lastAttemptAt + this.#minRefreshMs;
  }

  /**
   * Keep the previous windows and relabel their status. A panel showing a real
   * window that is five minutes old beats an empty one, and `stale` says so.
   * With nothing cached there is nothing to keep, so the caller falls back to
   * the outcome status on the refresh result.
   */
  #markAll(status: QuotaSnapshot['status']): void {
    for (const [provider, snapshot] of this.#snapshots) {
      if (snapshot.status === status) continue;
      this.#snapshots.set(provider, { ...snapshot, status });
    }
  }
}

/**
 * Map OMP's `usage --json --redact` payload onto quota snapshots.
 *
 * Three payload facts decide the outcome, and none of them is a guess:
 *  - `reports[]` present: windows were reported, so `available`.
 *  - `accountsWithoutUsage[]`: credentials exist for providers that publish no
 *    quota endpoint, so those providers read `unsupported`.
 *  - `disabledCredentials[]`: the credential for a usage-reporting provider is
 *    switched off, so that provider reads `unauthenticated`.
 *
 * A provider named by the payload always yields a snapshot, because a named
 * provider with no windows is a real state the panel has to show. A payload that
 * names no provider at all (no credentials anywhere) yields none: inventing a
 * provider key would be fabrication, so the status travels on the outcome.
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
      return { kind: 'unauthenticated', snapshots: [], message: redactQuotaText(message) };
    }
    if (exitCode !== 0 && /without a usage endpoint|no usage data/i.test(message)) {
      return { kind: 'unsupported', snapshots: [], message: redactQuotaText(message) };
    }
    return {
      kind: 'error',
      snapshots: [],
      message: redactQuotaText(message || 'Quota command produced no output.'),
    };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(stdout);
  } catch (err) {
    return {
      kind: 'error',
      snapshots: [],
      message: redactQuotaText(`Quota payload is not JSON: ${String(err)}`),
    };
  }

  const fetchedAt = new Date().toISOString();
  // All three provider lists describe the same account pool and can appear in
  // one payload: a provider that reports windows and a provider whose
  // credential has no quota endpoint are independent facts, and the panel has to
  // show both.
  const reports = ompArrayField(payload, 'reports');
  const accounts = ompArrayField(payload, 'accountsWithoutUsage');
  const disabled = ompArrayField(payload, 'disabledCredentials');
  const snapshots = [
    ...reports.map((report) => snapshotFromReport(report, fetchedAt)),
    ...accounts.map((account) =>
      typedSnapshot(
        account,
        fetchedAt,
        'unsupported',
        'This provider publishes no quota endpoint.',
      ),
    ),
    ...disabled.map((account) =>
      typedSnapshot(account, fetchedAt, 'unauthenticated', 'The stored credential is disabled.'),
    ),
  ];

  if (reports.length > 0) {
    return {
      kind: 'available',
      snapshots,
      message: `Reported quota for ${snapshots.length} provider(s).`,
    };
  }
  if (accounts.length > 0) {
    return {
      kind: 'unsupported',
      snapshots,
      message: 'Stored credentials belong to providers without a usage endpoint.',
    };
  }
  if (disabled.length > 0) {
    return {
      kind: 'unauthenticated',
      snapshots,
      message: 'Every stored credential for a usage-reporting provider is disabled.',
    };
  }
  return {
    kind: 'unauthenticated',
    snapshots,
    message: 'No credentials found for any usage-reporting provider.',
  };
}

/** A snapshot that states a provider's condition and carries no window. */
function typedSnapshot(
  account: unknown,
  fetchedAt: string,
  status: QuotaSnapshot['status'],
  note: string,
): QuotaSnapshot {
  const accountLabel = ompStringField(account, 'email') || ompStringField(account, 'accountId');
  return {
    provider: ompStringField(account, 'provider') || 'unknown',
    ...(accountLabel === '' ? {} : { accountLabel: redactQuotaText(accountLabel, 64) }),
    windows: [{ label: note, reportedUnit: 'unknown' }],
    fetchedAt,
    status,
  };
}

/**
 * Build one provider snapshot. Reported numbers are copied with their unit; a
 * window missing `used` or `remaining` omits the field instead of reporting 0,
 * because "not reported" and "nothing left" are different states.
 */
function snapshotFromReport(report: unknown, fetchedAt: string): QuotaSnapshot {
  const provider = ompStringField(report, 'provider');
  const metadata = ompJsonField(report, 'metadata');
  const accountLabel = ompStringField(metadata, 'email') || ompStringField(metadata, 'accountId');
  const windows = ompArrayField(report, 'limits').map((limit) => windowFromLimit(limit));

  return {
    provider: provider || 'unknown',
    ...(accountLabel === '' ? {} : { accountLabel: redactQuotaText(accountLabel, 64) }),
    windows,
    fetchedAt,
    status: 'available',
  };
}

function windowFromLimit(limit: unknown): QuotaWindow {
  const amount = ompJsonField(limit, 'amount');
  const window = ompJsonField(limit, 'window');
  const used = ompNumberField(amount, 'used');
  const remaining = ompNumberField(amount, 'remaining');
  const resetsAt = ompNumberField(window, 'resetsAt');
  return {
    label: ompStringField(limit, 'label') || ompStringField(window, 'label') || 'window',
    ...(used === undefined ? {} : { used }),
    ...(remaining === undefined ? {} : { remaining }),
    ...(resetsAt === undefined ? {} : { resetAt: new Date(resetsAt).toISOString() }),
    // The provider's own unit (credits, percent, tokens), never normalised to a
    // currency the provider did not report.
    reportedUnit: ompStringField(amount, 'unit') || 'unknown',
  };
}

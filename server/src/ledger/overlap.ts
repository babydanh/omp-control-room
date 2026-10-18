/**
 * Overlap scans: one overlap.py run at a time, through one queue for every
 * repo. A repo is due when it has two or more checkouts and was never scanned
 * or last finished at least five minutes ago. Scans never block the poll.
 */

import type {
  LedgerOverlapConflict,
  LedgerOverlapMain,
  LedgerOverlapPair,
  LedgerOverlapScan,
} from '../../../core/src/messages.js';
import {
  LEDGER_OVERLAP_BASE,
  LEDGER_OVERLAP_BUDGET_SECONDS,
  LEDGER_OVERLAP_INTERVAL_MS,
  LEDGER_OVERLAP_MAX_BYTES,
  LEDGER_OVERLAP_TIMEOUT_MS,
  LEDGER_REASON_OVERLAP_FAILED,
  LEDGER_REASON_OVERLAP_FORMAT,
  LEDGER_REASON_OVERLAP_TIMEOUT,
  LEDGER_REASON_OVERLAP_TOO_LARGE,
  LEDGER_REASON_OVERLAP_UNREADABLE,
} from './constants.js';
import { ledgerPathKey, normalizeLedgerPath } from './ledgerPath.js';
import { formatLedgerTime } from './ledgerTime.js';
import type { ProcessResult, ScriptRunner } from './processRunner.js';

export type OverlapOutcome =
  | {
      readonly ok: true;
      readonly complete: boolean;
      readonly base: string | null;
      readonly lanes: number;
      readonly pairs: LedgerOverlapPair[];
      readonly main: LedgerOverlapMain[];
      readonly pending: string[];
    }
  | { readonly ok: false; readonly error: string };

/** overlap.py `--json` as read at the boundary. Leaf fields are checked with typeof when used. */
interface RawOverlapJson {
  readonly complete?: unknown;
  readonly base?: unknown;
  readonly lanes?: unknown;
  readonly pairs: RawPair[];
  readonly main: RawMain[];
  readonly pending: unknown[];
}

interface RawPair {
  readonly a?: unknown;
  readonly b?: unknown;
  readonly a_label?: unknown;
  readonly b_label?: unknown;
  readonly conflicts?: RawConflict[];
  readonly auto?: unknown[];
}

interface RawMain {
  readonly lane?: unknown;
  readonly label?: unknown;
  readonly conflicts?: RawConflict[];
}

interface RawConflict {
  readonly file?: unknown;
  readonly hunks?: RawHunk[];
}

interface RawHunk {
  readonly line?: unknown;
  readonly symbol?: unknown;
  readonly ours?: unknown[];
  readonly theirs?: unknown[];
}

/** Reads one overlap.py run. Exit 2 means the budget ran out; the JSON flag covers the rest. */
export function parseOverlapResult(result: ProcessResult): OverlapOutcome {
  if (result.timedOut) return { ok: false, error: LEDGER_REASON_OVERLAP_TIMEOUT };
  if (!result.ok) {
    return { ok: false, error: result.stderr.trim() || LEDGER_REASON_OVERLAP_FAILED };
  }
  if (result.truncated) return { ok: false, error: LEDGER_REASON_OVERLAP_TOO_LARGE };
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return { ok: false, error: LEDGER_REASON_OVERLAP_UNREADABLE };
  }
  const raw = parsed as RawOverlapJson | null;
  if (
    raw === null ||
    typeof raw !== 'object' ||
    !Array.isArray(raw.pairs) ||
    !Array.isArray(raw.main) ||
    !Array.isArray(raw.pending)
  ) {
    return { ok: false, error: LEDGER_REASON_OVERLAP_FORMAT };
  }
  return {
    ok: true,
    complete: result.code !== 2 && raw.complete !== false,
    base: typeof raw.base === 'string' ? raw.base : null,
    lanes: typeof raw.lanes === 'number' ? raw.lanes : 0,
    pairs: raw.pairs.map((pair) => ({
      a: stringOf(pair.a),
      b: stringOf(pair.b),
      aLabel: stringOf(pair.a_label),
      bLabel: stringOf(pair.b_label),
      conflicts: conflictsOf(pair.conflicts),
      auto: stringsOf(pair.auto),
    })),
    main: raw.main.map((lane) => ({
      lane: stringOf(lane.lane),
      label: stringOf(lane.label),
      conflicts: conflictsOf(lane.conflicts),
    })),
    pending: stringsOf(raw.pending),
  };
}

function stringOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function stringsOf(value: unknown[] | undefined): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function conflictsOf(value: RawConflict[] | undefined): LedgerOverlapConflict[] {
  if (!Array.isArray(value)) return [];
  return value.map((conflict) => ({
    file: stringOf(conflict.file),
    hunks: Array.isArray(conflict.hunks)
      ? conflict.hunks.map((hunk) => ({
          line: typeof hunk.line === 'number' ? hunk.line : 0,
          symbol: stringOf(hunk.symbol),
          ours: stringsOf(hunk.ours),
          theirs: stringsOf(hunk.theirs),
        }))
      : [],
  }));
}

interface OverlapRecord {
  readonly repo: string;
  state: LedgerOverlapScan['state'];
  startedAt: string | null;
  finishedAt: string | null;
  finishedMs: number | null;
  base: string | null;
  lanes: number;
  pairs: LedgerOverlapPair[];
  main: LedgerOverlapMain[];
  pending: string[];
  complete: boolean;
  error: string | null;
}

export interface OverlapScannerOptions {
  readonly run: ScriptRunner;
  readonly now: () => number;
  /** Called after each finished scan, never after dispose. */
  readonly onSettled: (repo: string) => void;
}

export class OverlapScanner {
  private readonly records = new Map<string, OverlapRecord>();
  private readonly queue: OverlapRecord[] = [];
  private current: OverlapRecord | null = null;
  private idleWaiters: Array<() => void> = [];
  private disposed = false;

  constructor(private readonly options: OverlapScannerOptions) {}

  /** Queues a scan when the repo has at least two checkouts and its last scan is old enough. */
  enqueueIfDue(repo: string, checkoutCount: number): void {
    if (this.disposed || checkoutCount < 2) return;
    const record = this.recordFor(repo);
    if (this.current === record || this.queue.includes(record)) return;
    if (
      record.finishedMs !== null &&
      this.options.now() - record.finishedMs < LEDGER_OVERLAP_INTERVAL_MS
    ) {
      return;
    }
    this.queue.push(record);
    this.pump();
  }

  snapshot(repo: string): LedgerOverlapScan {
    const record = this.recordFor(repo);
    return {
      repo: record.repo,
      state: record.state,
      startedAt: record.startedAt,
      finishedAt: record.finishedAt,
      base: record.base,
      lanes: record.lanes,
      pairs: record.pairs,
      main: record.main,
      pending: record.pending,
      complete: record.complete,
      error: record.error,
    };
  }

  /** Resolves once no scan is running and none is queued. */
  idle(): Promise<void> {
    if (this.current === null && this.queue.length === 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.idleWaiters.push(() => resolve());
    });
  }

  dispose(): void {
    this.disposed = true;
    this.queue.length = 0;
    this.releaseIdle();
  }

  private recordFor(repo: string): OverlapRecord {
    const normalized = normalizeLedgerPath(repo);
    const key = ledgerPathKey(normalized);
    let record = this.records.get(key);
    if (record === undefined) {
      record = {
        repo: normalized,
        state: 'idle',
        startedAt: null,
        finishedAt: null,
        finishedMs: null,
        base: null,
        lanes: 0,
        pairs: [],
        main: [],
        pending: [],
        complete: false,
        error: null,
      };
      this.records.set(key, record);
    }
    return record;
  }

  private pump(): void {
    if (this.current !== null) return;
    const next = this.disposed ? undefined : this.queue.shift();
    if (next === undefined) {
      this.releaseIdle();
      return;
    }
    this.current = next;
    void this.runScan(next);
  }

  private async runScan(record: OverlapRecord): Promise<void> {
    record.state = 'running';
    record.startedAt = formatLedgerTime(this.options.now());
    let outcome: OverlapOutcome;
    try {
      const result = await this.options.run(
        [
          record.repo,
          '--json',
          '--base',
          LEDGER_OVERLAP_BASE,
          '--budget',
          String(LEDGER_OVERLAP_BUDGET_SECONDS),
        ],
        {
          cwd: record.repo,
          timeoutMs: LEDGER_OVERLAP_TIMEOUT_MS,
          okCodes: [0, 1, 2],
          maxBytes: LEDGER_OVERLAP_MAX_BYTES,
        },
      );
      outcome = parseOverlapResult(result);
    } catch (error) {
      outcome = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    this.current = null;
    if (!this.disposed) {
      applyOutcome(record, outcome, this.options.now());
      this.options.onSettled(record.repo);
    }
    this.pump();
  }

  private releaseIdle(): void {
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const waiter of waiters) waiter();
  }
}

function applyOutcome(record: OverlapRecord, outcome: OverlapOutcome, nowMs: number): void {
  record.finishedAt = formatLedgerTime(nowMs);
  record.finishedMs = nowMs;
  if (!outcome.ok) {
    record.state = 'error';
    record.error = outcome.error;
    record.complete = false;
    record.base = null;
    record.lanes = 0;
    record.pairs = [];
    record.main = [];
    record.pending = [];
    return;
  }
  record.state = outcome.complete ? 'done' : 'partial';
  record.error = null;
  record.complete = outcome.complete;
  record.base = outcome.base;
  record.lanes = outcome.lanes;
  record.pairs = outcome.pairs;
  record.main = outcome.main;
  record.pending = outcome.pending;
}

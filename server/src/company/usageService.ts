/**
 * usageService: what the company actually spent, and how little of it lies about.
 *
 * Four rules drive this module, and each exists because the naive version is a
 * lie the user would act on:
 *
 *  - **The ledger stores exactly what it persists.** A `UsageRecord` carries its
 *    own `provenance`, `toolCallId`, `runEpoch`, `taskId`, `contractId` and
 *    `totalTokens`, so a ledger rebuilt from the store after a restart reaches
 *    the same totals as the one that was running. Reconciliation metadata kept
 *    only in memory would be silently lost on restart, and the numbers would
 *    quietly change.
 *
 *  - **Dollars are only ever source-provided.** OMP writes `usage.cost.total`
 *    when the provider reports a price. When it does not, the cost stays absent
 *    and the aggregate is `null` -- never `0`. A "$0.00" row on a provider that
 *    silently omits pricing reads as "this was free".
 *
 *  - **A child's spend is counted once.** A native subagent writes its assistant
 *    usage into its own transcript AND the parent's `task` tool result carries an
 *    aggregated `details.usage` covering those same calls. Summing both doubles
 *    the tokens. The child's own entries win; the parent's aggregate counts only
 *    while no child entry for that tool call exists, so spend is never lost when
 *    a child transcript is unavailable and never doubled when it is readable.
 *
 *  - **Context occupancy is a snapshot, not a sum.** Occupied context is the
 *    newest native `contextTokens` / `contextSnapshot`. Adding turns measures
 *    spend, not the window that is actually full.
 *
 * The JSONL reader is OMP-specific and incremental. It reads forward from a byte
 * offset, carries the unterminated trailing line as raw bytes so a multi-byte
 * character split across two appends survives, and only reads fields OMP writes
 * (`message.usage`, `model_usage`, `task` tool-result `details.usage`). It never
 * touches the Claude transcript parser, which understands a different format.
 *
 * `ompJsonField` and friends are the single JSON boundary for the company
 * subsystem's OMP output. They narrow to `unknown` and are never bypassed with a
 * cast, so a shape change in OMP's payloads surfaces here as an absent value
 * instead of as `undefined` leaking into a UsageRecord.
 */

import * as fs from 'node:fs';

import type { CompanyRole, UsageProvenance, UsageRecord } from '../../../core/src/company.js';
import { CompanyError } from './companyError.js';

/** Where a usage entry came from, matching the protocol enum. */
export type UsageSource = 'provider' | 'native_session';

/**
 * Token buckets exactly as OMP reports them; nothing is inferred here.
 */
export interface NativeUsageTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Reported by OMP as `totalTokens`; absent when the source omitted it. */
  totalTokens?: number;
}

/** One native usage observation, before it becomes a durable record. */
export interface UsageObservation {
  /** Company session that owns the spend. Child spend uses the parent's id. */
  sessionId: string;
  nativeSessionId: string;
  nativeEntryId: string;
  role: CompanyRole;
  model: string;
  provider: string;
  /** Native purpose: `model_usage` carries its own, turns get a label. */
  purpose: string;
  tokens: NativeUsageTokens;
  /** Present only when the source reported a price. Absent means unknown. */
  costUsd?: number;
  timestamp: string;
  source: UsageSource;
  /** How the entry relates to the owning session; see the protocol enum. */
  provenance: UsageProvenance;
  /** Run epoch the call belonged to; scopes the "this run" totals. */
  runEpoch: number;
  /** Tool call id linking a child entry to its parent's rollup. */
  toolCallId?: string;
  taskId?: string;
  contractId?: string;
}

/** A ledger entry: the durable record plus its insertion order. */
export interface UsageEntry {
  record: UsageRecord;
  /** Monotonic insertion order, stable across a hydration pass. */
  sequence: number;
}

/** Cache-hit ratio with the denominator it was computed from, always shown. */
export interface CacheHitRate {
  cacheRead: number;
  /** input + cacheRead + cacheWrite. Zero when nothing was billed. */
  denominator: number;
  /** null when the denominator is absent, rather than a fabricated 0%. */
  ratio: number | null;
}

/** Totals for one model inside a scope. */
export interface ModelTotals {
  provider: string;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  records: number;
  /** null when no counted entry for this model reported a price. */
  costUsd: number | null;
}

/** Per-model accumulator; `costRecords` decides whether costUsd can be shown. */
interface ModelAccumulator extends Omit<ModelTotals, 'costUsd'> {
  costUsd: number;
  costRecords: number;
}

/** Aggregated spend over a set of ledger entries. */
export interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  records: number;
  /** Sum of source-reported dollars; null when nothing reported one. */
  costUsd: number | null;
  /** Sum of source-reported totals; null when nothing reported one. */
  totalTokens: number | null;
  /** How many counted entries had a price, so a partial sum stays honest. */
  costCoverage: { reported: number; unknown: number };
  cacheHit: CacheHitRate;
  byModel: Record<string, ModelTotals>;
}

/** Newest native context occupancy observation for a session. */
export interface ContextOccupancy {
  contextTokens: number;
  maxContextTokens?: number;
  /** True when the provider itself reported the occupied value. */
  providerReported: boolean;
  observedAt: string;
  compactionEpoch?: number;
}

/** `UsageRecord.availability` markers. */
export const USAGE_COST_REPORTED = 'cost_reported';
export const USAGE_COST_UNAVAILABLE = 'cost_unavailable';

export interface UsageLedgerOptions {
  /**
   * Resolves a company session's Contract, for callers that cannot stamp
   * `contractId` on every observation. Consulted only when it is absent.
   */
  contractIdForSession?: (sessionId: string) => string | undefined;
}

export interface RecordResult {
  entry: UsageEntry;
  /** True when the same (nativeSessionId, nativeEntryId) was already recorded. */
  duplicate: boolean;
}

export class UsageLedger {
  readonly #entries = new Map<string, UsageEntry>();
  readonly #order: UsageEntry[] = [];
  /** Newest run epoch seen per session, or the one set by beginRun. */
  readonly #currentEpoch = new Map<string, number>();
  readonly #context = new Map<string, ContextOccupancy>();
  /** Tool calls that already have a direct child entry in the ledger. */
  readonly #childToolCalls = new Set<string>();
  readonly #contractIdForSession: (sessionId: string) => string | undefined;
  #sequence = 0;

  constructor(options: UsageLedgerOptions = {}) {
    this.#contractIdForSession = options.contractIdForSession ?? (() => undefined);
  }

  get size(): number {
    return this.#order.length;
  }

  /**
   * Record one native usage observation. Re-reporting the same native entry
   * returns the original entry and changes no total: OMP rewrites a session file
   * on resume and a bridge can deliver an event twice, and neither may inflate
   * spend.
   */
  record(observation: UsageObservation): RecordResult {
    const nativeSessionId = observation.nativeSessionId.trim();
    const nativeEntryId = observation.nativeEntryId.trim();
    if (!nativeSessionId || !nativeEntryId) {
      throw new CompanyError(
        'usage_entry_identity_missing',
        'A usage observation needs both nativeSessionId and nativeEntryId to be deduped.',
      );
    }
    const costUsd = observation.costUsd;
    const reportedCost =
      costUsd !== undefined && Number.isFinite(costUsd) && costUsd >= 0 ? costUsd : undefined;
    const contractId =
      observation.contractId ?? this.#contractIdForSession(observation.sessionId) ?? undefined;

    return this.#ingest({
      sessionId: observation.sessionId,
      nativeSessionId,
      nativeEntryId,
      role: observation.role,
      model: observation.model,
      provider: observation.provider,
      purpose: observation.purpose,
      input: observation.tokens.input,
      output: observation.tokens.output,
      cacheRead: observation.tokens.cacheRead,
      cacheWrite: observation.tokens.cacheWrite,
      ...(reportedCost === undefined ? {} : { costUsd: reportedCost }),
      timestamp: observation.timestamp,
      source: observation.source,
      availability: reportedCost === undefined ? USAGE_COST_UNAVAILABLE : USAGE_COST_REPORTED,
      provenance: observation.provenance,
      ...(observation.toolCallId === undefined ? {} : { toolCallId: observation.toolCallId }),
      runEpoch: observation.runEpoch,
      ...(observation.taskId === undefined ? {} : { taskId: observation.taskId }),
      ...(contractId === undefined ? {} : { contractId }),
      ...(observation.tokens.totalTokens === undefined
        ? {}
        : { totalTokens: observation.tokens.totalTokens }),
    });
  }

  /**
   * Rebuild a ledger from the persisted records, in the order given.
   *
   * Hydration is the same code path as recording, so a restored ledger has the
   * same child-suppression set and the same current run epoch as the one that
   * was running. Records that were already ingested are ignored, so hydrating
   * twice cannot double a total.
   */
  hydrate(records: Iterable<UsageRecord>): void {
    for (const record of records) this.#ingest(record);
  }

  /**
   * Rebuild from the store's per-session buckets. Session ids are visited in
   * sorted order so the insertion sequence is identical on every restore.
   */
  hydrateFromState(usageIndex: Readonly<Record<string, readonly UsageRecord[]>>): void {
    for (const sessionId of Object.keys(usageIndex).sort()) {
      this.hydrate(usageIndex[sessionId] ?? []);
    }
  }

  /**
   * Mark the run that is now live. Totals for "this run" are the newest epoch
   * for the session, so a restored ledger reports the epoch it last saw until
   * the coordinator announces a new one.
   */
  beginRun(sessionId: string, runEpoch: number): void {
    this.#currentEpoch.set(sessionId, runEpoch);
  }

  /** The epoch "this run" means right now, or null when nothing is known. */
  currentRunEpoch(sessionId: string): number | null {
    return this.#currentEpoch.get(sessionId) ?? null;
  }

  /** The newest native context snapshot; an older one never overrides it. */
  recordContext(sessionId: string, snapshot: ContextOccupancy): ContextOccupancy {
    const current = this.#context.get(sessionId);
    if (current && current.observedAt > snapshot.observedAt) return current;
    this.#context.set(sessionId, snapshot);
    return snapshot;
  }

  contextOccupancy(sessionId: string): ContextOccupancy | null {
    return this.#context.get(sessionId) ?? null;
  }

  /** Spend of the session's newest run epoch only. */
  runTotals(sessionId: string): UsageTotals {
    const epoch = this.#currentEpoch.get(sessionId);
    if (epoch === undefined) return this.totals([]);
    return this.totals(
      this.#order.filter(
        (entry) => entry.record.sessionId === sessionId && entry.record.runEpoch === epoch,
      ),
    );
  }

  sessionTotals(sessionId: string): UsageTotals {
    return this.totals(this.#order.filter((entry) => entry.record.sessionId === sessionId));
  }

  contractTotals(contractId: string): UsageTotals {
    return this.totals(this.#order.filter((entry) => entry.record.contractId === contractId));
  }

  companyTotals(): UsageTotals {
    return this.totals(this.#order);
  }

  /** Every entry in insertion order, child entries and rollups included. */
  entries(): readonly UsageEntry[] {
    return [...this.#order];
  }

  entriesForSession(sessionId: string): readonly UsageEntry[] {
    return this.#order.filter((entry) => entry.record.sessionId === sessionId);
  }

  /**
   * A parent's `task` rollup counts only while no child entry for the same tool
   * call exists. Order-independent: a child transcript read later replaces the
   * rollup rather than adding to it, and a restart rebuilds the same set.
   */
  #countsTowardTotals(entry: UsageEntry): boolean {
    const record = entry.record;
    if (record.provenance !== 'child_aggregate') return true;
    if (record.toolCallId === undefined) return true;
    return !this.#childToolCalls.has(`${record.sessionId} ${record.toolCallId}`);
  }

  #ingest(record: UsageRecord): RecordResult {
    const key = `${record.nativeSessionId} ${record.nativeEntryId}`;
    const existing = this.#entries.get(key);
    if (existing) return { entry: existing, duplicate: true };

    this.#sequence += 1;
    const entry: UsageEntry = { record, sequence: this.#sequence };
    this.#entries.set(key, entry);
    this.#order.push(entry);

    const knownEpoch = this.#currentEpoch.get(record.sessionId);
    if (knownEpoch === undefined || record.runEpoch > knownEpoch) {
      this.#currentEpoch.set(record.sessionId, record.runEpoch);
    }
    if (record.provenance === 'native_child' && record.toolCallId !== undefined) {
      this.#childToolCalls.add(`${record.sessionId} ${record.toolCallId}`);
    }
    return { entry, duplicate: false };
  }

  private totals(entries: readonly UsageEntry[]): UsageTotals {
    let input = 0;
    let output = 0;
    let cacheRead = 0;
    let cacheWrite = 0;
    let records = 0;
    let cost = 0;
    let costReported = 0;
    let costUnknown = 0;
    let totalTokens = 0;
    let totalReported = 0;
    const byModel = new Map<string, ModelAccumulator>();

    for (const entry of entries) {
      if (!this.#countsTowardTotals(entry)) continue;
      const { record } = entry;
      const costUsd = record.costUsd;
      input += record.input;
      output += record.output;
      cacheRead += record.cacheRead;
      cacheWrite += record.cacheWrite;
      records += 1;
      if (costUsd === undefined) {
        costUnknown += 1;
      } else {
        cost += costUsd;
        costReported += 1;
      }
      if (record.totalTokens !== undefined) {
        totalTokens += record.totalTokens;
        totalReported += 1;
      }

      const modelKey = `${record.provider}/${record.model}`;
      const bucket = byModel.get(modelKey) ?? {
        provider: record.provider,
        model: record.model,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        records: 0,
        costUsd: 0,
        costRecords: 0,
      };
      bucket.input += record.input;
      bucket.output += record.output;
      bucket.cacheRead += record.cacheRead;
      bucket.cacheWrite += record.cacheWrite;
      bucket.records += 1;
      if (costUsd !== undefined) {
        bucket.costUsd += costUsd;
        bucket.costRecords += 1;
      }
      byModel.set(modelKey, bucket);
    }

    const byModelTotals: Record<string, ModelTotals> = {};
    for (const [modelKey, bucket] of byModel) {
      byModelTotals[modelKey] = {
        provider: bucket.provider,
        model: bucket.model,
        input: bucket.input,
        output: bucket.output,
        cacheRead: bucket.cacheRead,
        cacheWrite: bucket.cacheWrite,
        records: bucket.records,
        costUsd: bucket.costRecords === 0 ? null : bucket.costUsd,
      };
    }

    return {
      input,
      output,
      cacheRead,
      cacheWrite,
      records,
      costUsd: costReported === 0 ? null : cost,
      totalTokens: totalReported === 0 ? null : totalTokens,
      costCoverage: { reported: costReported, unknown: costUnknown },
      cacheHit: cacheHitRate(input, cacheRead, cacheWrite),
      byModel: byModelTotals,
    };
  }
}

/**
 * Cache-hit ratio with an explicit denominator. A scope that reported no tokens
 * has no ratio at all: `null`, never `0`, so an empty panel cannot read as
 * "zero percent cache hit".
 */
export function cacheHitRate(input: number, cacheRead: number, cacheWrite: number): CacheHitRate {
  const denominator = input + cacheRead + cacheWrite;
  return {
    cacheRead,
    denominator,
    ratio: denominator > 0 ? cacheRead / denominator : null,
  };
}

// ── Incremental OMP session JSONL reader ──────────────────────

/**
 * A read position in an OMP session file: bytes already consumed, plus the
 * unterminated trailing line's raw bytes.
 *
 * `pending` is base64 so the cursor stays serializable (it can be persisted
 * alongside the session) and so a multi-byte character cut in half by an append
 * is carried as bytes and decoded once it is whole.
 */
export interface OmpSessionCursor {
  offset: number;
  pending: string;
}

export function emptyCursor(): OmpSessionCursor {
  return { offset: 0, pending: '' };
}

/** Context the reader stamps onto every observation it produces. */
export interface OmpUsageReadContext {
  /** Company session that owns the native session being read. */
  sessionId: string;
  role: CompanyRole;
  /** Native session id; OMP names its file `<timestamp>_<sessionId>.jsonl`. */
  nativeSessionId: string;
  /** Run epoch the read belongs to; scopes "this run" totals. */
  runEpoch: number;
  /** `own_turn` normally; `native_child` when reading a subagent transcript. */
  provenance?: UsageProvenance;
  taskId?: string;
  contractId?: string;
}

export interface OmpUsageReadResult {
  observations: UsageObservation[];
  /** Newest context occupancy seen in this read, if any. */
  context: ContextOccupancy | null;
  /** Session id from a header in this read, for reconciliation. */
  headerNativeSessionId?: string;
  /** Set when the header marks this file as a native subagent's transcript. */
  parentNativeSessionId?: string;
  cursor: OmpSessionCursor;
  /** Complete but unparseable lines; skipped, never guessed at. */
  malformedLines: number;
  /** True when the file shrank and the read restarted from zero. */
  restarted: boolean;
}

const READ_CHUNK_BYTES = 64 * 1024;

/**
 * Read the usage appended to an OMP session file since the last read.
 *
 * Reads forward from `cursor.offset` only. A line without its terminating
 * newline is held in `cursor.pending` as raw bytes and combined with the next
 * chunk, so a record split across two appends is parsed exactly once. A file
 * that shrank (rotation, truncation) restarts from zero rather than silently
 * reporting nothing.
 */
export async function readOmpSessionUsage(
  filePath: string,
  cursor: OmpSessionCursor,
  context: OmpUsageReadContext,
): Promise<OmpUsageReadResult> {
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const { size } = await handle.stat();
    let offset = cursor.offset;
    let pendingBytes = Buffer.from(cursor.pending, 'base64');
    let restarted = false;
    if (size < offset) {
      offset = 0;
      pendingBytes = Buffer.alloc(0);
      restarted = true;
    }

    const observations: UsageObservation[] = [];
    let newestContext: ContextOccupancy | null = null;
    let headerNativeSessionId: string | undefined;
    let parentNativeSessionId: string | undefined;
    let malformedLines = 0;

    const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    while (offset < size) {
      const wanted = Math.min(buffer.length, size - offset);
      const { bytesRead } = await handle.read(buffer, 0, wanted, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;

      const bytes =
        pendingBytes.length > 0
          ? Buffer.concat([pendingBytes, buffer.subarray(0, bytesRead)])
          : buffer.subarray(0, bytesRead);
      const lines = new TextDecoder('utf-8').decode(bytes).split('\n');
      pendingBytes = Buffer.from(lines.pop() ?? '', 'utf8');

      for (const line of lines) {
        if (line.trim().length === 0) continue;
        const parsed = parseOmpSessionLine(line, context);
        if (parsed === null) {
          malformedLines += 1;
          continue;
        }
        headerNativeSessionId = parsed.nativeSessionId ?? headerNativeSessionId;
        parentNativeSessionId = parsed.parentNativeSessionId ?? parentNativeSessionId;
        observations.push(...parsed.observations);
        if (
          parsed.context &&
          (!newestContext || parsed.context.observedAt >= newestContext.observedAt)
        ) {
          newestContext = parsed.context;
        }
      }
    }

    return {
      observations,
      context: newestContext,
      ...(headerNativeSessionId === undefined ? {} : { headerNativeSessionId }),
      ...(parentNativeSessionId === undefined ? {} : { parentNativeSessionId }),
      cursor: { offset, pending: pendingBytes.toString('base64') },
      malformedLines,
      restarted,
    };
  } finally {
    await handle.close();
  }
}

interface ParsedOmpLine {
  observations: UsageObservation[];
  context?: ContextOccupancy;
  nativeSessionId?: string;
  parentNativeSessionId?: string;
}

interface ObservationSeed {
  entryId: string;
  provider: string;
  model: string;
  purpose: string;
  usage: NativeUsageTokens & { costUsd?: number };
  timestamp: string;
  source: UsageSource;
  provenance: UsageProvenance;
  toolCallId?: string;
}

/**
 * Parse one OMP session entry. Returns null only for a line that is complete but
 * unusable (bad JSON, or a non-object payload); an entry of a type that simply
 * carries no usage returns an empty observation list, because that is not an
 * error and must not be counted as malformed.
 */
function parseOmpSessionLine(line: string, context: OmpUsageReadContext): ParsedOmpLine | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  const entry = asJsonObject(parsed);
  if (entry === undefined) return null;
  const type = ompStringField(entry, 'type');
  const timestamp = ompStringField(entry, 'timestamp');

  if (type === 'session') {
    const headerId = ompStringField(entry, 'id');
    const parent = ompStringField(entry, 'parentSession');
    return {
      observations: [],
      ...(headerId === '' ? {} : { nativeSessionId: headerId }),
      ...(parent === '' ? {} : { parentNativeSessionId: parent }),
    };
  }

  if (type === 'model_usage') {
    const usage = readNativeUsage(entry['usage']);
    if (usage === undefined) return { observations: [] };
    return {
      observations: [
        observationFrom(context, {
          entryId: ompStringField(entry, 'id'),
          provider: ompStringField(entry, 'provider'),
          model: ompStringField(entry, 'model'),
          purpose: ompStringField(entry, 'purpose') || 'model_usage',
          usage,
          timestamp,
          source: 'native_session',
          provenance: context.provenance ?? 'own_turn',
        }),
      ],
    };
  }

  if (type !== 'message') return { observations: [] };
  const message = asJsonObject(entry['message']);
  if (message === undefined) return { observations: [] };
  const role = ompStringField(message, 'role');

  if (role === 'assistant') {
    const usage = readNativeUsage(message['usage']);
    if (usage === undefined) return { observations: [] };
    return {
      observations: [
        observationFrom(context, {
          entryId: ompStringField(entry, 'id'),
          provider: ompStringField(message, 'provider'),
          model: ompStringField(message, 'model'),
          purpose: 'assistant_turn',
          usage,
          timestamp,
          source: 'provider',
          provenance: context.provenance ?? 'own_turn',
        }),
      ],
      ...(usage.context === undefined ? {} : { context: usage.context }),
    };
  }

  if (role !== 'toolResult' || ompStringField(message, 'toolName') !== 'task') {
    return { observations: [] };
  }
  const details = asJsonObject(message['details']);
  const usage = details === undefined ? undefined : readNativeUsage(details['usage']);
  if (usage === undefined) return { observations: [] };
  const toolCallId = ompStringField(message, 'toolCallId');
  return {
    observations: [
      observationFrom(context, {
        entryId: ompStringField(entry, 'id'),
        // The rollup names no model of its own; empty strings keep it out of the
        // per-model breakdown instead of inventing an attribution.
        provider: '',
        model: '',
        purpose: 'subagent_aggregate',
        usage,
        timestamp,
        source: 'native_session',
        provenance: 'child_aggregate',
        ...(toolCallId === '' ? {} : { toolCallId }),
      }),
    ],
  };
}

function observationFrom(context: OmpUsageReadContext, seed: ObservationSeed): UsageObservation {
  const costUsd = seed.usage.costUsd;
  return {
    sessionId: context.sessionId,
    nativeSessionId: context.nativeSessionId,
    nativeEntryId: seed.entryId,
    role: context.role,
    model: seed.model,
    provider: seed.provider,
    purpose: seed.purpose,
    tokens: {
      input: seed.usage.input,
      output: seed.usage.output,
      cacheRead: seed.usage.cacheRead,
      cacheWrite: seed.usage.cacheWrite,
      ...(seed.usage.totalTokens === undefined ? {} : { totalTokens: seed.usage.totalTokens }),
    },
    ...(costUsd === undefined ? {} : { costUsd }),
    timestamp: seed.timestamp,
    source: seed.source,
    provenance: seed.provenance,
    runEpoch: context.runEpoch,
    ...(seed.toolCallId === undefined ? {} : { toolCallId: seed.toolCallId }),
    ...(context.taskId === undefined ? {} : { taskId: context.taskId }),
    ...(context.contractId === undefined ? {} : { contractId: context.contractId }),
  };
}

interface NativeUsageRead extends NativeUsageTokens {
  costUsd?: number;
  context?: ContextOccupancy;
}

/**
 * Read OMP's `Usage` object. All four token buckets are required: an entry
 * missing one is a different shape and is not silently zero-filled.
 *
 * `cost.total` is the source-reported price; an absent `cost` leaves the cost
 * unknown. `contextTokens` is the provider's authoritative occupied context and
 * `contextSnapshot` is OMP's estimate -- both describe one moment and are never
 * summed.
 */
function readNativeUsage(value: unknown): NativeUsageRead | undefined {
  const usage = asJsonObject(value);
  if (usage === undefined) return undefined;
  const input = ompNumberField(usage, 'input');
  const output = ompNumberField(usage, 'output');
  const cacheRead = ompNumberField(usage, 'cacheRead');
  const cacheWrite = ompNumberField(usage, 'cacheWrite');
  if (
    input === undefined ||
    output === undefined ||
    cacheRead === undefined ||
    cacheWrite === undefined
  ) {
    return undefined;
  }
  const totalTokens = ompNumberField(usage, 'totalTokens');
  const cost = asJsonObject(ompJsonField(usage, 'cost'));
  const costTotal = cost === undefined ? undefined : ompNumberField(cost, 'total');
  const contextTokens = ompNumberField(usage, 'contextTokens');
  const snapshot = asJsonObject(ompJsonField(usage, 'contextSnapshot'));

  let context: ContextOccupancy | undefined;
  if (contextTokens !== undefined) {
    context = { contextTokens, providerReported: true, observedAt: new Date().toISOString() };
  } else if (snapshot !== undefined && ompNumberField(snapshot, 'promptTokens') !== undefined) {
    context = {
      contextTokens:
        (ompNumberField(snapshot, 'promptTokens') ?? 0) +
        (ompNumberField(snapshot, 'nonMessageTokens') ?? 0),
      providerReported: false,
      observedAt: new Date().toISOString(),
    };
  }

  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    ...(totalTokens === undefined ? {} : { totalTokens }),
    ...(costTotal === undefined ? {} : { costUsd: costTotal }),
    ...(context === undefined ? {} : { context }),
  };
}

// ── OMP JSON boundary ─────────────────────────────────────────

/** Narrow an unknown value to a JSON object; arrays and null are not objects. */
function asJsonObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/** Read a property as `unknown`; a non-object source reads as undefined. */
export function ompJsonField(source: unknown, key: string): unknown {
  const object = asJsonObject(source);
  return object === undefined ? undefined : object[key];
}

/** Read a string property; absent or non-string reads as the empty string. */
export function ompStringField(source: unknown, key: string): string {
  const value = ompJsonField(source, key);
  return typeof value === 'string' ? value : '';
}

/** Read a finite number property; absent or non-numeric reads as undefined. */
export function ompNumberField(source: unknown, key: string): number | undefined {
  const value = ompJsonField(source, key);
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Read an array property; anything else reads as an empty list. */
export function ompArrayField(source: unknown, key: string): unknown[] {
  const value = ompJsonField(source, key);
  return Array.isArray(value) ? value : [];
}

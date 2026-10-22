/**
 * Reads the tool-usage statistics that `~/.omp/scripts/tool-usage.py` writes: how often each
 * skill, MCP tool and built-in tool of omp, Claude and agy was called, and how often it failed;
 * plus the estimated Claude token usage per main session / subagent / skill / plugin and the
 * unused Claude skills still loaded in full.
 */

import * as fs from 'node:fs/promises';

import type {
  LedgerTokenUsage,
  LedgerTokenUsageRow,
  LedgerToolUsageMessage,
  LedgerToolUsageRow,
} from '../../../core/src/messages.js';

const TOKEN_KINDS: ReadonlySet<string> = new Set(['main', 'subagent', 'skill', 'plugin']);

const GENERATE_HINT = 'Chạy: python ~/.omp/scripts/tool-usage.py';

/** Never rejects: a missing or malformed file comes back as `ok: false` with the reason. */
export async function readToolUsage(
  requestId: string,
  filename: string,
): Promise<LedgerToolUsageMessage> {
  try {
    const data: unknown = JSON.parse(await fs.readFile(filename, 'utf8'));
    if (typeof data !== 'object' || data === null)
      throw new Error('Dữ liệu không phải JSON object.');
    const record = data as Record<string, unknown>;
    if (
      typeof record.generated_at !== 'string' ||
      typeof record.days !== 'number' ||
      !Array.isArray(record.rows)
    ) {
      throw new Error('Thiếu trường generated_at, days hoặc rows.');
    }
    return {
      type: 'ledgerToolUsage',
      requestId,
      ok: true,
      running: false,
      generatedAt: record.generated_at,
      days: record.days,
      transcripts: numberRecord(record.transcripts),
      rows: record.rows.map(usageRow).filter((row): row is LedgerToolUsageRow => row !== null),
      unusedSkills: stringListRecord(record.unused_skills),
      tokenUsage: tokenUsage(record.token_usage),
      nameOnlyCandidates: stringList(record.name_only_candidates),
      reason: '',
    };
  } catch (error) {
    const missing = error instanceof Error && 'code' in error && error.code === 'ENOENT';
    const detail = error instanceof Error ? error.message : String(error);
    return toolUsageFailure(
      requestId,
      missing
        ? `Không tìm thấy file tool-usage.json. ${GENERATE_HINT}`
        : `Không đọc được tool-usage.json: ${detail} ${GENERATE_HINT}`,
    );
  }
}

export function toolUsageFailure(requestId: string, reason: string): LedgerToolUsageMessage {
  return {
    type: 'ledgerToolUsage',
    requestId,
    ok: false,
    running: false,
    generatedAt: null,
    days: null,
    transcripts: {},
    rows: [],
    unusedSkills: {},
    tokenUsage: { totalUnits: 0, rows: [] },
    nameOnlyCandidates: [],
    reason,
  };
}

function usageRow(value: unknown): LedgerToolUsageRow | null {
  if (typeof value !== 'object' || value === null) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.cli !== 'string' || typeof row.kind !== 'string' || typeof row.name !== 'string') {
    return null;
  }
  return {
    cli: row.cli,
    kind: row.kind,
    name: row.name,
    calls: numberValue(row.calls),
    ok: numberValue(row.ok),
    err: numberValue(row.err),
    sessions: numberValue(row.sessions),
    last: typeof row.last === 'string' ? row.last : null,
    topErrors: Array.isArray(row.top_errors) ? row.top_errors.filter(isErrorCount) : [],
  };
}

/** Files written before token usage existed have no `token_usage`: an empty table, not a failure. */
function tokenUsage(value: unknown): LedgerTokenUsage {
  if (typeof value !== 'object' || value === null) return { totalUnits: 0, rows: [] };
  const record = value as Record<string, unknown>;
  return {
    totalUnits: numberValue(record.total_units),
    rows: Array.isArray(record.rows)
      ? record.rows.map(tokenRow).filter((row): row is LedgerTokenUsageRow => row !== null)
      : [],
  };
}

function tokenRow(value: unknown): LedgerTokenUsageRow | null {
  if (typeof value !== 'object' || value === null) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.kind !== 'string' || !TOKEN_KINDS.has(row.kind) || typeof row.name !== 'string') {
    return null;
  }
  return {
    kind: row.kind as LedgerTokenUsageRow['kind'],
    name: row.name,
    input: numberValue(row.input),
    cacheWrite: numberValue(row.cache_write),
    cacheRead: numberValue(row.cache_read),
    output: numberValue(row.output),
    messages: numberValue(row.messages),
    units: numberValue(row.units),
    share: numberValue(row.share),
    models: stringList(row.models),
  };
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function isErrorCount(value: unknown): value is [string, number] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === 'string' &&
    typeof value[1] === 'number'
  );
}

function numberValue(value: unknown): number {
  return typeof value === 'number' ? value : 0;
}

function numberRecord(value: unknown): Record<string, number> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, number] => typeof entry[1] === 'number',
    ),
  );
}

function stringListRecord(value: unknown): Record<string, string[]> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).map(([key, entries]) => [
      key,
      Array.isArray(entries)
        ? entries.filter((entry): entry is string => typeof entry === 'string')
        : [],
    ]),
  );
}

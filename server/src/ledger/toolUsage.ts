/**
 * Reads the tool-usage statistics that `~/.omp/scripts/tool-usage.py` writes: how often each
 * skill, MCP tool and built-in tool of omp, Claude and agy was called, and how often it failed.
 */

import * as fs from 'node:fs/promises';

import type { LedgerToolUsageMessage, LedgerToolUsageRow } from '../../../core/src/messages.js';

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

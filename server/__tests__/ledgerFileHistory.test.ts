import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { openLedgerSource, type SqliteDatabase } from '../src/ledger/ledgerDb.js';

let directory: string | null = null;

afterEach(() => {
  if (directory !== null) fs.rmSync(directory, { recursive: true, force: true });
  directory = null;
});

describe('ledger file history query', () => {
  it('filters by normalized path key, applies the seven-day cutoff, and caps at 200 newest touches', () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-ledger-history-'));
    const dbPath = path.join(directory, 'activity.db');
    fs.writeFileSync(dbPath, '');
    let sql = '';
    let params: (string | number)[] = [];
    const database: SqliteDatabase = {
      prepare: (query) => {
        sql = query;
        return {
          all: (...values) => {
            params = values;
            return [{
              ts: '2026-10-21 11:00:00',
              session_id: 'session-a',
              agent_kind: 'codex',
              agent_name: 'Worker',
              branch: 'feat/a',
              checkout: 'D:/repo-wt',
              tool: 'apply_patch',
              intent: 'Sửa màn hình',
            }];
          },
        };
      },
      close: () => {},
    };
    const source = openLedgerSource(dbPath, () => database);

    expect(source.fileHistory('d:/repo/src/a.ts', '2026-10-14 11:00:00')).toEqual([{
      ts: '2026-10-21 11:00:00',
      sessionId: 'session-a',
      agentKind: 'codex',
      agentName: 'Worker',
      branch: 'feat/a',
      checkout: 'D:/repo-wt',
      tool: 'apply_patch',
      intent: 'Sửa màn hình',
    }]);
    expect(sql).toContain('e.path_key = ?');
    expect(sql).toContain('e.ts >= ?');
    expect(sql).toContain('ORDER BY e.ts DESC, e.id DESC LIMIT ?');
    expect(params).toEqual(['d:/repo/src/a.ts', '2026-10-14 11:00:00', 200]);
    source.close();
  });
});

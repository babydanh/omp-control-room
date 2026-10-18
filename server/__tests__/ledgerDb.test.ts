import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openLedgerSource, type SqliteDatabase } from '../src/ledger/ledgerDb.js';

const SINCE = '2026-04-09 12:00:00';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-ledger-db-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A database whose queries return `rows`, or throw `queryError` when given. */
function fakeDb(onClose: () => void, rows: unknown[] = [], queryError?: string): SqliteDatabase {
  return {
    prepare: () => ({
      all: () => {
        if (queryError !== undefined) throw new Error(queryError);
        return rows;
      },
    }),
    close: onClose,
  };
}

/** Creates an empty file at the database path, so the existence check passes. */
function existingDatabase(): string {
  const file = path.join(dir, 'activity.db');
  fs.writeFileSync(file, '');
  return file;
}

describe('openLedgerSource: missing database', () => {
  it('reports a missing database as empty and never tries to open it', () => {
    let opened = 0;
    const source = openLedgerSource(path.join(dir, 'activity.db'), () => {
      opened += 1;
      return fakeDb(() => {});
    });

    expect(source.sessionRows()).toEqual([]);
    expect(source.status()).toEqual({ state: 'missing' });
    expect(opened).toBe(0);
  });
});

describe('openLedgerSource: existing database', () => {
  it('reports an unreadable database with the opener error', () => {
    const source = openLedgerSource(existingDatabase(), () => {
      throw new Error('database is locked');
    });

    expect(source.sessionRows()).toEqual([]);
    expect(source.status()).toEqual({ state: 'unreadable', error: 'database is locked' });
  });

  it('reads through the opened handle, reports ok, and closes the handle on close()', () => {
    let closed = 0;
    const source = openLedgerSource(existingDatabase(), () =>
      fakeDb(() => {
        closed += 1;
      }),
    );

    expect(source.eventRows(SINCE)).toEqual([]);
    expect(source.status()).toEqual({ state: 'ok' });

    source.close();
    expect(closed).toBe(1);
  });

  it('drops the handle after a failing query and reopens it on the next read', () => {
    let opened = 0;
    const source = openLedgerSource(existingDatabase(), () => {
      opened += 1;
      return fakeDb(() => {}, [], 'disk I/O error');
    });

    expect(source.eventRows(SINCE)).toEqual([]);
    expect(source.status()).toEqual({ state: 'unreadable', error: 'disk I/O error' });
    expect(opened).toBe(1);

    source.sessionRows();
    expect(opened).toBe(2);
  });
});

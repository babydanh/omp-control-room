/**
 * Read-only access to the activity ledger (~/.omp/agent/activity.db). The
 * extension writes it concurrently, so every query is a short read-only
 * statement, and a failed read reports `unreadable` instead of throwing.
 * node:sqlite is loaded lazily: it is absent on older Node runtimes (the
 * package still supports Node 20), and the board must degrade, not crash.
 */

import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';

import type { LedgerDatabaseStatus } from '../../../core/src/messages.js';
import {
  LEDGER_MAIN_WRITES_MAX,
  LEDGER_NOTICES_MAX,
  LEDGER_PENDING_MAX,
  LEDGER_SESSIONS_MAX,
  LEDGER_SQLITE_BUSY_TIMEOUT_MS,
} from './constants.js';

export interface SessionRow {
  readonly sessionId: string;
  readonly pid: number | null;
  readonly cwd: string | null;
  readonly agentKind: string | null;
  readonly agentName: string | null;
  readonly parentId: string | null;
  readonly startedAt: string | null;
  readonly lastSeen: string | null;
  readonly endedAt: string | null;
  readonly state: string | null;
  readonly heartbeat: string | null;
}

export interface EventRow {
  readonly id: number;
  readonly ts: string;
  readonly sessionId: string;
  readonly kind: string;
  readonly tool: string | null;
  readonly path: string | null;
  readonly pathKey: string | null;
  readonly repo: string | null;
  readonly checkout: string | null;
  readonly isMainCheckout: boolean;
  readonly branch: string | null;
  readonly intent: string | null;
}

export interface PendingRow {
  readonly checkout: string;
  readonly sessionId: string | null;
  readonly branch: string | null;
  readonly dirty: number;
  readonly unpushed: number;
  readonly notInMain: number;
  readonly hasRemote: boolean;
  readonly ts: string;
}

export interface NoticeRow {
  readonly id: number;
  readonly ts: string;
  readonly toSession: string;
  readonly fromSession: string | null;
  readonly relKey: string | null;
  readonly content: string;
  readonly delivered: number;
}

export interface LedgerSource {
  status(): LedgerDatabaseStatus;
  sessionRows(): SessionRow[];
  eventRows(sinceTs: string): EventRow[];
  pendingRows(): PendingRow[];
  noticeRows(): NoticeRow[];
  mainWriteRows(sinceTs: string): EventRow[];
  close(): void;
}

/** The slice of node:sqlite this module uses. Structural, so tests can fake it. */
export interface SqliteStatement {
  all(...params: (string | number)[]): unknown[];
}

export interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
  close(): void;
}

export type SqliteOpener = (dbPath: string) => SqliteDatabase;

interface SqliteModule {
  DatabaseSync: new (
    file: string,
    options: { readOnly: boolean; timeout: number },
  ) => SqliteDatabase;
}

export function openLedgerSource(
  dbPath: string,
  openDatabase: SqliteOpener = openReadOnlySqlite,
): LedgerSource {
  return new SqliteLedgerSource(dbPath, openDatabase);
}

function openReadOnlySqlite(dbPath: string): SqliteDatabase {
  // Resolved from the database's own directory; the Node build provides node:sqlite.
  const requireBuiltin = createRequire(path.resolve(dbPath));
  const sqlite = requireBuiltin('node:sqlite') as SqliteModule;
  return new sqlite.DatabaseSync(dbPath, {
    readOnly: true,
    timeout: LEDGER_SQLITE_BUSY_TIMEOUT_MS,
  });
}

const SESSIONS_SQL =
  'SELECT session_id, pid, cwd, agent_kind, agent_name, parent_id, started_at, last_seen, ' +
  'ended_at, state, heartbeat FROM sessions ' +
  'ORDER BY (ended_at IS NULL) DESC, COALESCE(heartbeat, last_seen) DESC LIMIT ?';

const EVENTS_SQL =
  'SELECT id, ts, session_id, kind, tool, path, path_key, repo, checkout, is_main_checkout, ' +
  'branch, intent FROM events WHERE ts >= ? ORDER BY ts, id';

const MAIN_WRITES_SQL =
  'SELECT id, ts, session_id, kind, tool, path, path_key, repo, checkout, is_main_checkout, ' +
  "branch, intent FROM events WHERE is_main_checkout = 1 AND kind IN ('edit', 'write') " +
  'AND ts >= ? ORDER BY ts DESC, id DESC LIMIT ?';

const PENDING_SQL =
  'SELECT checkout, session_id, branch, dirty, unpushed, not_in_main, has_remote, ts ' +
  'FROM pending ORDER BY ts DESC LIMIT ?';

const NOTICES_SQL =
  'SELECT id, ts, to_session, from_session, rel_key, content, delivered FROM notices ' +
  'WHERE delivered = 0 ORDER BY ts DESC, id DESC LIMIT ?';

type SqlRow = Record<string, unknown>;

class SqliteLedgerSource implements LedgerSource {
  private db: SqliteDatabase | null = null;
  private state: LedgerDatabaseStatus = { state: 'missing' };

  constructor(
    private readonly dbPath: string,
    private readonly openDatabase: SqliteOpener,
  ) {}

  status(): LedgerDatabaseStatus {
    return { ...this.state };
  }

  sessionRows(): SessionRow[] {
    return this.read([], (db) =>
      rowsOf(db.prepare(SESSIONS_SQL).all(LEDGER_SESSIONS_MAX)).map(sessionRowOf),
    );
  }

  eventRows(sinceTs: string): EventRow[] {
    return this.read([], (db) => rowsOf(db.prepare(EVENTS_SQL).all(sinceTs)).map(eventRowOf));
  }

  pendingRows(): PendingRow[] {
    return this.read([], (db) =>
      rowsOf(db.prepare(PENDING_SQL).all(LEDGER_PENDING_MAX)).map(pendingRowOf),
    );
  }

  noticeRows(): NoticeRow[] {
    return this.read([], (db) =>
      rowsOf(db.prepare(NOTICES_SQL).all(LEDGER_NOTICES_MAX)).map(noticeRowOf),
    );
  }

  mainWriteRows(sinceTs: string): EventRow[] {
    return this.read([], (db) =>
      rowsOf(db.prepare(MAIN_WRITES_SQL).all(sinceTs, LEDGER_MAIN_WRITES_MAX)).map(eventRowOf),
    );
  }

  close(): void {
    this.disconnect();
  }

  /** Runs one query; a failure closes the handle so the next call reopens it. */
  private read<T>(fallback: T[], query: (db: SqliteDatabase) => T[]): T[] {
    const db = this.connect();
    if (db === null) return fallback;
    try {
      const rows = query(db);
      this.state = { state: 'ok' };
      return rows;
    } catch (error) {
      this.disconnect();
      this.state = {
        state: 'unreadable',
        error: error instanceof Error ? error.message : String(error),
      };
      return fallback;
    }
  }

  private connect(): SqliteDatabase | null {
    if (this.db !== null) return this.db;
    if (!fs.existsSync(this.dbPath)) {
      this.state = { state: 'missing' };
      return null;
    }
    try {
      this.db = this.openDatabase(this.dbPath);
      this.state = { state: 'ok' };
      return this.db;
    } catch (error) {
      this.state = {
        state: 'unreadable',
        error: error instanceof Error ? error.message : String(error),
      };
      return null;
    }
  }

  private disconnect(): void {
    if (this.db === null) return;
    try {
      this.db.close();
    } catch {
      // The handle is already unusable; dropping it is the recovery.
    }
    this.db = null;
  }
}

function rowsOf(raw: unknown[]): SqlRow[] {
  return raw.filter((row): row is SqlRow => typeof row === 'object' && row !== null);
}

function textOf(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function requiredText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function numberOf(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  return 0;
}

function sessionRowOf(row: SqlRow): SessionRow {
  return {
    sessionId: requiredText(row.session_id),
    pid: typeof row.pid === 'number' ? row.pid : null,
    cwd: textOf(row.cwd),
    agentKind: textOf(row.agent_kind),
    agentName: textOf(row.agent_name),
    parentId: textOf(row.parent_id),
    startedAt: textOf(row.started_at),
    lastSeen: textOf(row.last_seen),
    endedAt: textOf(row.ended_at),
    state: textOf(row.state),
    heartbeat: textOf(row.heartbeat),
  };
}

function eventRowOf(row: SqlRow): EventRow {
  return {
    id: numberOf(row.id),
    ts: requiredText(row.ts),
    sessionId: requiredText(row.session_id),
    kind: requiredText(row.kind),
    tool: textOf(row.tool),
    path: textOf(row.path),
    pathKey: textOf(row.path_key),
    repo: textOf(row.repo),
    checkout: textOf(row.checkout),
    isMainCheckout: numberOf(row.is_main_checkout) === 1,
    branch: textOf(row.branch),
    intent: textOf(row.intent),
  };
}

function pendingRowOf(row: SqlRow): PendingRow {
  return {
    checkout: requiredText(row.checkout),
    sessionId: textOf(row.session_id),
    branch: textOf(row.branch),
    dirty: numberOf(row.dirty),
    unpushed: numberOf(row.unpushed),
    notInMain: numberOf(row.not_in_main),
    hasRemote: numberOf(row.has_remote) !== 0,
    ts: requiredText(row.ts),
  };
}

function noticeRowOf(row: SqlRow): NoticeRow {
  return {
    id: numberOf(row.id),
    ts: requiredText(row.ts),
    toSession: requiredText(row.to_session),
    fromSession: textOf(row.from_session),
    relKey: textOf(row.rel_key),
    content: requiredText(row.content),
    delivered: numberOf(row.delivered),
  };
}

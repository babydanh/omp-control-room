/**
 * Pure display helpers for the ledger view: Vietnamese labels, relative times, short
 * ids and the message-length rule. Ledger timestamps are local `YYYY-MM-DD HH:MM:SS`
 * strings; they parse as local time, so every clock value shown matches the time the
 * server recorded.
 */

import type {
  LedgerDatabaseStatus,
  LedgerOverlapScan,
  LedgerPending,
  LedgerSession,
} from '../../../../core/src/messages.js';

/** The timeline windows the server answers, in minutes. */
export type LedgerWindow = 15 | 60 | 360 | 1440;

export const LEDGER_WINDOWS: readonly LedgerWindow[] = [15, 60, 360, 1440];

/** The four activity categories a timeline bucket counts. */
export type LedgerCategory = 'edit' | 'bash' | 'read' | 'other';

export const LEDGER_CATEGORIES: readonly LedgerCategory[] = ['edit', 'bash', 'read', 'other'];

/** A message to an agent is at most this many characters. */
export const LEDGER_MESSAGE_MAX_LENGTH = 4000;

/** Milliseconds for a ledger timestamp, or null when absent or unreadable. */
export function parseLedgerTimestamp(ts: string | null): number | null {
  if (ts === null) return null;
  const ms = Date.parse(ts.replace(' ', 'T'));
  return Number.isNaN(ms) ? null : ms;
}

/** `HH:MM` in local time. */
export function formatClock(ms: number): string {
  const date = new Date(ms);
  const hours = date.getHours().toString().padStart(2, '0');
  const minutes = date.getMinutes().toString().padStart(2, '0');
  return `${hours}:${minutes}`;
}

/** `DD/MM HH:MM` in local time, for a ledger timestamp or an ISO one; `—` when there is none. */
export function formatLedgerStamp(ts: string | null): string {
  const ms = parseLedgerTimestamp(ts);
  if (ms === null) return '—';
  const date = new Date(ms);
  const day = date.getDate().toString().padStart(2, '0');
  const month = (date.getMonth() + 1).toString().padStart(2, '0');
  return `${day}/${month} ${formatClock(ms)}`;
}

/** Vietnamese age of `ts` measured against `reference` (both ledger timestamps). */
export function formatRelativeTime(ts: string | null, reference: string): string {
  if (ts === null) return 'chưa có';
  const at = parseLedgerTimestamp(ts);
  const now = parseLedgerTimestamp(reference);
  if (at === null || now === null) return ts;
  const seconds = Math.round((now - at) / 1000);
  if (seconds < 60) return 'vừa xong';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} phút trước`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} giờ trước`;
  return `${Math.floor(hours / 24)} ngày trước`;
}

/** The last eight characters of a session id: the form who.py and the board show. */
export function shortSessionId(sessionId: string): string {
  return sessionId.length <= 8 ? sessionId : sessionId.slice(-8);
}

/** Agent name, or its short id when the name is blank. */
export function sessionTitle(session: LedgerSession): string {
  return session.agentName.trim() !== ''
    ? session.agentName.trim()
    : shortSessionId(session.sessionId);
}

/** Last path segment, for both `/` and `\` separators. */
export function fileName(path: string): string {
  const segments = path.split(/[\\/]/).filter((segment) => segment !== '');
  return segments[segments.length - 1] ?? path;
}

const CATEGORY_LABELS: Record<LedgerCategory, string> = {
  edit: 'sửa',
  bash: 'lệnh',
  read: 'đọc',
  other: 'khác',
};

export function categoryLabel(category: LedgerCategory): string {
  return CATEGORY_LABELS[category];
}

const WINDOW_LABELS: Record<LedgerWindow, string> = {
  15: '15 phút',
  60: '1 giờ',
  360: '6 giờ',
  1440: '24 giờ',
};

export function windowLabel(windowMinutes: LedgerWindow): string {
  return WINDOW_LABELS[windowMinutes];
}

const DATABASE_LABELS: Record<LedgerDatabaseStatus['state'], string> = {
  ok: 'Đã đọc CSDL hoạt động',
  missing: 'Chưa có CSDL hoạt động',
  unreadable: 'Không đọc được CSDL',
};

export function databaseLabel(database: LedgerDatabaseStatus): string {
  return DATABASE_LABELS[database.state];
}

const SCAN_LABELS: Record<LedgerOverlapScan['state'], string> = {
  idle: 'Chưa quét',
  running: 'Đang quét…',
  done: 'Đã quét xong',
  // Partial means some lanes were not compared. It must never read as "clean".
  partial: 'Chưa quét hết',
  error: 'Quét lỗi',
};

export function scanLabel(scan: LedgerOverlapScan | null): string {
  return scan === null ? 'Chưa quét' : SCAN_LABELS[scan.state];
}

export function presenceLabel(session: LedgerSession): string {
  if (session.live) return 'đang chạy';
  return session.open ? 'đang mở' : 'đã đóng';
}

/** "+3 commit chưa gộp": commits on the branch that main does not have yet. */
export function aheadLabel(ahead: number): string {
  return `+${ahead} commit chưa gộp`;
}

/** "2 commit mới trên main": commits on main that the branch does not have. */
export function behindLabel(behind: number): string {
  return `${behind} commit mới trên main`;
}

/** The "N sửa" badge: uncommitted files in a checkout. */
export function dirtyLabel(dirtyCount: number): string {
  return `${dirtyCount} sửa`;
}

/** The warning chips for a checkout that holds work nobody has integrated. */
export function pendingFlags(pending: LedgerPending): string[] {
  const flags: string[] = [];
  if (pending.dirty > 0) flags.push(`${pending.dirty} sửa chưa commit`);
  if (pending.unpushed > 0) flags.push(`${pending.unpushed} chưa push`);
  if (pending.notInMain > 0) flags.push(`${pending.notInMain} chưa vào main`);
  if (!pending.hasRemote) flags.push('chưa có remote');
  return flags;
}

/** Why a message cannot be sent, or null when it can. The text is sent trimmed. */
export function ledgerMessageProblem(text: string): string | null {
  if (text.trim() === '') return 'Nhập nội dung trước khi gửi.';
  if (Array.from(text).length > LEDGER_MESSAGE_MAX_LENGTH) {
    return `Nội dung tối đa ${LEDGER_MESSAGE_MAX_LENGTH} ký tự.`;
  }
  return null;
}

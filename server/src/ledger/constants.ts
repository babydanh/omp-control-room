/**
 * Ledger constants: every number, path segment and user-visible string the
 * activity-ledger board uses. Pure: nothing here reads the disk or the clock.
 */

import type { LedgerSpamRule } from '../../../core/src/messages.js';

// ── Locations, relative to the operator's home directory ──

/** The activity-ledger SQLite file. The extension writes it; the board only reads it. */
export const LEDGER_DB_SEGMENTS: readonly string[] = ['.omp', 'agent', 'activity.db'];
/** who.py. The server runs exactly one subcommand from it: `send`. */
export const LEDGER_WHO_SCRIPT_SEGMENTS: readonly string[] = ['.omp', 'scripts', 'who.py'];
/** overlap.py. Always run without `--notify`, which would write into activity.db. */
export const LEDGER_OVERLAP_SCRIPT_SEGMENTS: readonly string[] = ['.omp', 'scripts', 'overlap.py'];
export const LEDGER_TOOL_USAGE_SCRIPT_SEGMENTS: readonly string[] = [
  '.omp',
  'scripts',
  'tool-usage.py',
];
export const LEDGER_TOOL_USAGE_FILE_SEGMENTS: readonly string[] = [
  '.omp',
  'agent',
  'tool-usage.json',
];
export const LEDGER_TOOL_USAGE_TIMEOUT_MS = 180_000;
export const LEDGER_PYTHON_COMMAND = 'python';
export const LEDGER_GIT_COMMAND = 'git';
export const LEDGER_SQLITE_BUSY_TIMEOUT_MS = 5_000;
/** Default agent kind when a session row carries none. */
export const LEDGER_DEFAULT_AGENT_KIND = 'main';

// ── Polling, caching and time windows ──

export const LEDGER_POLL_INTERVAL_MS = 10_000;
/** A privileged request keeps the poll alive for this long after it arrives. */
export const LEDGER_ACTIVITY_WINDOW_MS = 2 * 60_000;
export const LEDGER_DAY_MS = 24 * 60 * 60_000;
/** A session is live when its heartbeat is at most this old and it has not ended. */
export const LEDGER_SESSION_LIVE_MS = 60_000;
export const LEDGER_CALLS_SHORT_MS = 5 * 60_000;
export const LEDGER_CALLS_LONG_MS = 30 * 60_000;

// ── Git ──

export const LEDGER_GIT_REFRESH_MS = 60_000;
export const LEDGER_GIT_TIMEOUT_MS = 15_000;
export const LEDGER_GIT_MAX_BYTES = 4 * 1024 * 1024;
export const LEDGER_REPO_CAP = 24;
export const LEDGER_SHORT_SHA_LENGTH = 8;
export const LEDGER_SHORT_ID_LENGTH = 8;

// ── Overlap scans ──

export const LEDGER_OVERLAP_INTERVAL_MS = 5 * 60_000;
export const LEDGER_OVERLAP_BASE = 'origin/main';
export const LEDGER_OVERLAP_BUDGET_SECONDS = 60;
/** Budget plus slack: the script stops itself at the budget; this only bounds a hang. */
export const LEDGER_OVERLAP_TIMEOUT_MS = (LEDGER_OVERLAP_BUDGET_SECONDS + 30) * 1000;
export const LEDGER_OVERLAP_MAX_BYTES = 8 * 1024 * 1024;

// ── Spam rule (documented in CLAUDE.md) ──

export const LEDGER_SPAM_RULE: Readonly<LedgerSpamRule> = {
  windowMinutes: 5,
  callsPerWindow: 60,
  sameIntentPerWindow: 12,
  lookbackMinutes: 30,
};

// ── Timeline ──

export const LEDGER_TIMELINE_WINDOWS: readonly number[] = [15, 60, 360, 1440];
export const LEDGER_TIMELINE_BUCKETS = 60;
export const LEDGER_TIMELINE_MAX_LANES = 150;
export const LEDGER_TIMELINE_MAX_SHARED = 200;
/** Per-bucket cap on distinct intents and files, so one busy bucket stays bounded. */
export const LEDGER_TIMELINE_LIST_MAX = 20;

// ── Payload caps ──

export const LEDGER_SESSIONS_MAX = 400;
export const LEDGER_PENDING_MAX = 200;
export const LEDGER_NOTICES_MAX = 50;
export const LEDGER_NOTICE_CONTENT_MAX = 400;
export const LEDGER_MAIN_WRITES_MAX = 50;

// ── Commands ──

export const LEDGER_SESSION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
export const LEDGER_SEND_TEXT_MAX = 4000;
export const LEDGER_SEND_TIMEOUT_MS = 15_000;
export const LEDGER_SEND_OUTPUT_MAX_BYTES = 16 * 1024;
export const LEDGER_SEND_REASON_MAX = 300;
export const LEDGER_PATH_MAX = 1024;
export const LEDGER_DIFF_TIMEOUT_MS = 10_000;
export const LEDGER_DIFF_MAX_BYTES = 200_000;
export const LEDGER_DEV_NULL = '/dev/null';

// ── User-visible text (Vietnamese) ──

export const LEDGER_REASON_READ_ONLY = 'Kết nối này chỉ xem được; không gửi được lệnh cây git.';
export const LEDGER_REASON_UNAVAILABLE = 'Máy chủ này chưa bật cây git.';
export const LEDGER_REASON_BAD_WINDOW = 'Khoảng thời gian không hợp lệ.';
export const LEDGER_REASON_COMMAND_FAILED = 'Không thực hiện được lệnh cây git.';
export const LEDGER_REASON_BAD_SESSION = 'Mã session không hợp lệ.';
export const LEDGER_REASON_EMPTY_TEXT = 'Tin nhắn đang trống.';
export const LEDGER_REASON_TEXT_TOO_LONG = 'Tin nhắn quá dài (tối đa 4000 ký tự).';
export const LEDGER_REASON_TEXT_NUL = 'Tin nhắn chứa ký tự không hợp lệ.';
export const LEDGER_REASON_SEND_TIMEOUT = 'Gửi quá lâu; chưa rõ đã gửi hay chưa.';
export const LEDGER_REASON_SEND_FAILED = 'Không gửi được tin nhắn.';
export const LEDGER_REASON_WORKTREE_UNKNOWN = 'Worktree không nằm trong danh sách đang theo dõi.';
export const LEDGER_REASON_PATH_INVALID = 'Đường dẫn không hợp lệ.';
export const LEDGER_REASON_DIFF_EMPTY = 'Không có thay đổi so với HEAD.';
export const LEDGER_REASON_DIFF_TIMEOUT = 'Lấy diff quá lâu; thử lại sau.';
export const LEDGER_REASON_DIFF_FAILED = 'Không lấy được diff của file này.';
export const LEDGER_GIT_ERROR_PREFIX = 'Git không đọc được:';
export const LEDGER_GIT_PROBLEM_STATUS = 'trạng thái';
export const LEDGER_GIT_PROBLEM_BASE = 'so với origin/main';
export const LEDGER_GIT_PROBLEM_LAST_COMMIT = 'commit cuối';
export const LEDGER_GIT_PROBLEM_UPSTREAM = 'commit chưa đẩy';
export const LEDGER_REASON_OVERLAP_TIMEOUT = 'Quét quá lâu; chưa rõ kết quả.';
export const LEDGER_REASON_OVERLAP_TOO_LARGE = 'Kết quả quét quá lớn.';
export const LEDGER_REASON_OVERLAP_UNREADABLE = 'Không đọc được kết quả quét.';
export const LEDGER_REASON_OVERLAP_FORMAT = 'Kết quả quét không đúng định dạng.';
export const LEDGER_REASON_OVERLAP_FAILED = 'Không chạy được overlap.py.';

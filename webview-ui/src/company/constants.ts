/**
 * Company UI constants.
 *
 * These live beside the company surface rather than in the app-wide constants
 * file because they are the limits the BOARD obeys, and several of them mirror
 * the server's protocol limits (server/src/company/constants.ts) so the client
 * can refuse an oversized payload before paying for a round trip. The server
 * still enforces every one of them; matching here is a courtesy, not the rule.
 *
 * No color literals: the board is chrome, and chrome uses the CSS pixel tokens.
 */

/** Board lanes, in the order they are drawn. */
export const COMPANY_LANE_ORDER = [
  'planned',
  'ready',
  'running',
  'needs_input',
  'review',
  'done',
  'failed',
] as const;

export type CompanyLaneId = (typeof COMPANY_LANE_ORDER)[number];

export const COMPANY_LANE_LABELS: Record<CompanyLaneId, string> = {
  planned: 'Kế hoạch',
  ready: 'Sẵn sàng',
  running: 'Đang làm',
  needs_input: 'Chờ bạn',
  review: 'Kiểm',
  done: 'Xong',
  failed: 'Lỗi',
};

/** Who holds a card in each lane: the owner line printed under the lane label. */
export const COMPANY_LANE_OWNERS: Record<CompanyLaneId, string> = {
  planned: 'Giám đốc',
  ready: 'đã duyệt',
  running: 'Nhân viên',
  needs_input: 'bạn trả lời',
  review: 'QA → Trọng tài',
  done: 'exit 0 · pass',
  failed: 'hết lượt thử',
};

/** The mark printed before each lane's label, so a column reads at a glance. */
export const COMPANY_LANE_ICONS: Record<CompanyLaneId, string> = {
  planned: '📝',
  ready: '✅',
  running: '🔨',
  needs_input: '🙋',
  review: '🔍',
  done: '🎉',
  failed: '⛔',
};

/** Excerpt length for the public assistant text shown in a bubble. */
export const COMPANY_TEXT_EXCERPT_GRAPHEMES = 160;

/**
 * Characters of live text kept per session. A bubble shows an excerpt, not a
 * transcript: the full output lives in an artifact the user opens deliberately.
 */
export const COMPANY_TEXT_STREAM_MAX_CHARS = 8000;

/** Text deltas coalesce for this long before React re-renders. */
export const COMPANY_TEXT_BATCH_MS = 100;

/** Mirrors COMPANY_ARTIFACT_PAGE_BYTES / COMPANY_FILE_DEFAULT_PAGE_BYTES. */
export const COMPANY_ARTIFACT_PAGE_BYTES = 64 * 1024;
export const COMPANY_FILE_PAGE_BYTES = 64 * 1024;

/** Mirrors COMPANY_MAX_PROMPT_BYTES. */
export const COMPANY_MAX_PROMPT_BYTES = 2 * 1024 * 1024;

/** Mirrors COMPANY_TERMINAL_INPUT_MAX_BYTES and the default PTY geometry. */
export const COMPANY_TERMINAL_INPUT_CHUNK_BYTES = 8 * 1024;
export const COMPANY_TERMINAL_DEFAULT_COLS = 120;
export const COMPANY_TERMINAL_DEFAULT_ROWS = 32;

/**
 * Frames buffered for a mounted terminal before the client asks the server for
 * a fresh screen. A consumer that falls this far behind is not going to catch
 * up frame by frame, and an unbounded queue is a memory leak with a scrollbar.
 */
export const COMPANY_TERMINAL_FRAME_QUEUE_MAX = 512;

/** Session log entries kept per session; the oldest fall off first. */
export const COMPANY_SESSION_LOG_MAX_ENTRIES = 1000;

/** Sidebar width bounds and default, in CSS pixels. */
export const COMPANY_SIDEBAR_MIN_WIDTH_PX = 240;
export const COMPANY_SIDEBAR_MAX_WIDTH_PX = 480;
export const COMPANY_SIDEBAR_DEFAULT_WIDTH_PX = 300;

/** At or below this viewport width the sidebar floats over the board instead of pushing it. */
export const COMPANY_SIDEBAR_OVERLAY_MAX_PX = 1023;

/** Herdr screen lines requested per read. */
export const HERDR_SCREEN_LINES = 200;

/** How often an open herdr screen is re-read while its agent is working. */
export const HERDR_SCREEN_POLL_MS = 2000;

/** Slide time of the detail drawer, matching the approved mockup. */
export const COMPANY_DRAWER_SLIDE_MS = 320;

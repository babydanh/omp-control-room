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
  planned: 'Đã lên kế hoạch',
  ready: 'Sẵn sàng',
  running: 'Đang chạy',
  needs_input: 'Chờ phản hồi',
  review: 'Đang xem xét',
  done: 'Hoàn thành',
  failed: 'Thất bại',
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

/** Below this viewport width the office and the board become tabs. */
export const COMPANY_SPLIT_MIN_WIDTH_PX = 1100;

/** Width of the company pane when the office and board sit side by side. */
export const COMPANY_PANEL_WIDTH_PX = 480;

/**
 * First office character id a company session is given.
 *
 * Company characters live in their own id range, far from both other id
 * spaces: Claude agents are positive, OfficeState's sub-agent counter starts at
 * -1 and counts down, and the Intro greeter holds -1_000_000_000. Nothing in
 * the office allocates a number anywhere near this base, so a company
 * character can never be mistaken for (or overwrite) a real agent.
 */
export const COMPANY_CHARACTER_ID_BASE = -2_000_000_000;

/** How long a public output bubble stays up after the last delta. */
export const COMPANY_BUBBLE_FADE_MS = 5000;

/** World-space lift of a company bubble above the character's head. */
export const COMPANY_BUBBLE_RISE_WORLD = 26;

/**
 * Vertical step applied per already-placed bubble so two company characters
 * standing next to each other stack instead of overlapping. Applied by
 * character id order, so the same office always stacks the same way.
 */
export const COMPANY_BUBBLE_STACK_STEP_PX = 26;

export const COMPANY_BUBBLE_MAX_WIDTH_PX = 360;

/**
 * Above the agent overlay (41/42), below the Intro greeter (45): a company
 * bubble belongs to its character, and the first-run tour owns the screen
 * until it has been answered.
 */
export const COMPANY_BUBBLE_Z_INDEX = 43;

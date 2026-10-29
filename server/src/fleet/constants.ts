export const FLEET_CONFIG_PATH_SEGMENTS = ['.pixel-agents', 'fleet.json'] as const;
export const FLEET_FETCH_TIMEOUT_MS = 10_000;
export const FLEET_CACHE_MS = 15_000;
export const FLEET_STALE_AFTER_MS = 10 * 60_000;

export const FLEET_REASON_READ_ONLY = 'Kết nối chỉ đọc không được phép xem Cloud.';
export const FLEET_REASON_UNAVAILABLE = 'Cloud chưa được cấu hình hoặc hiện không khả dụng.';
export const FLEET_REASON_COMMAND_FAILED = 'Không thể tải dữ liệu Cloud từ hub.';

/** Same patterns as the AsyncAPI schema; checked again server-side before anything reaches a command line. */
export const FLEET_MACHINE_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const FLEET_SESSION_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const FLEET_TASK_SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const FLEET_TASK_REPOS = ['backend', 'web', 'app'] as const;
export const FLEET_PROMPT_MAX = 20_000;
/** Board-side PTY ids for cloud terminals: far above local agent ids so the two never collide. */
export const FLEET_TERMINAL_ID_BASE = 900_000_000;
/** Which InstaBox account owns which machine, re-read at most this often. */
export const FLEET_ACCOUNT_CACHE_MS = 10 * 60_000;
export const FLEET_INSTABOX_TIMEOUT_MS = 120_000;

export const FLEET_REASON_BAD_INPUT = 'Tên máy, tên phiên hoặc nội dung việc không hợp lệ.';
export const FLEET_REASON_NO_TERMINAL = 'Board không có terminal (chạy với --no-terminal hoặc thiếu node-pty).';
export const FLEET_REASON_NO_MACHINE = 'Không tìm thấy máy này trong các tài khoản InstaBox đã đăng nhập.';

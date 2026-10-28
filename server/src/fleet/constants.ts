export const FLEET_CONFIG_PATH_SEGMENTS = ['.pixel-agents', 'fleet.json'] as const;
export const FLEET_FETCH_TIMEOUT_MS = 10_000;
export const FLEET_CACHE_MS = 15_000;
export const FLEET_STALE_AFTER_MS = 10 * 60_000;

export const FLEET_REASON_READ_ONLY = 'Kết nối chỉ đọc không được phép xem Cloud.';
export const FLEET_REASON_UNAVAILABLE = 'Cloud chưa được cấu hình hoặc hiện không khả dụng.';
export const FLEET_REASON_COMMAND_FAILED = 'Không thể tải dữ liệu Cloud từ hub.';

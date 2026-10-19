/**
 * usageFormat: the usage page's numbers, dates and durations as text.
 *
 * Deterministic and locale-free on purpose: `Intl` output depends on the machine's locale,
 * so the Vietnamese separators (`,` for decimals, `.` for thousands) are written out here.
 * A missing or non-finite number renders as MISSING_TEXT, never as zero.
 */

/** What a missing or non-finite number shows as. */
export const MISSING_TEXT = '—';

const MINUTE_MS = 60_000;
const MINUTES_PER_HOUR = 60;

/** Token magnitudes from largest to smallest, with their Vietnamese names. */
const TOKEN_SCALES = [
  { size: 1_000_000_000, label: 'tỷ' },
  { size: 1_000_000, label: 'triệu' },
  { size: 1_000, label: 'nghìn' },
] as const;

/**
 * Added before flooring so a value at exactly .5 rounds up. It absorbs binary float error
 * (0.285 * 100 is 28.499999999999996), so a decimal half rounds the way a person writes it.
 */
const ROUNDING_EPSILON = 1e-9;

/** Round half up. Callers pass a non-negative value and apply the sign themselves. */
function roundHalfUp(value: number): number {
  return Math.floor(value + 0.5 + ROUNDING_EPSILON);
}

/** Groups the digits of a whole number in threes: `1234567` becomes `1.234.567`. */
function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** A whole count with Vietnamese thousands separators, e.g. `1.234.567`. Fractions round half up. */
export function formatCount(count: number): string {
  if (!Number.isFinite(count)) return MISSING_TEXT;
  const rounded = roundHalfUp(Math.abs(count));
  const sign = count < 0 && rounded !== 0 ? '-' : '';
  return `${sign}${groupThousands(rounded.toFixed(0))}`;
}

/**
 * A token count scaled to nghìn, triệu or tỷ with one decimal, e.g. `1,2 triệu`. Counts under
 * a thousand are shown whole. A count that rounds up to 1000 of one scale reads in the next.
 */
export function formatTokens(count: number): string {
  if (!Number.isFinite(count)) return MISSING_TEXT;
  const magnitude = Math.abs(count);
  if (magnitude < TOKEN_SCALES[TOKEN_SCALES.length - 1].size) return formatCount(count);
  const sign = count < 0 ? '-' : '';
  let scale = TOKEN_SCALES.findIndex((entry) => magnitude >= entry.size);
  let tenths = roundHalfUp((magnitude / TOKEN_SCALES[scale].size) * 10);
  // 999 999 rounds to 1000 nghìn; the larger scale reads it as 1 triệu.
  if (tenths >= 10_000 && scale > 0) {
    scale -= 1;
    tenths = roundHalfUp((magnitude / TOKEN_SCALES[scale].size) * 10);
  }
  const whole = groupThousands(String(Math.floor(tenths / 10)));
  const fraction = tenths % 10;
  const digits = fraction === 0 ? whole : `${whole},${fraction}`;
  return `${sign}${digits} ${TOKEN_SCALES[scale].label}`;
}

/**
 * A dollar amount with two decimals and Vietnamese separators, e.g. `$1.234,56`. A positive
 * amount under half a cent reads `< $0,01` rather than a misleading `$0,00`.
 */
export function formatUsd(amount: number): string {
  if (!Number.isFinite(amount)) return MISSING_TEXT;
  const cents = roundHalfUp(Math.abs(amount) * 100);
  if (cents === 0) return amount > 0 ? '< $0,01' : '$0,00';
  const sign = amount < 0 ? '-' : '';
  const whole = groupThousands(String(Math.floor(cents / 100)));
  return `${sign}$${whole},${pad2(cents % 100)}`;
}

/** A share (0.57) as a whole percent (`57%`), rounded half up. Above 1 is allowed: it shows overuse. */
export function formatPercent(fraction: number): string {
  if (!Number.isFinite(fraction)) return MISSING_TEXT;
  const percent = roundHalfUp(Math.abs(fraction) * 100);
  const sign = fraction < 0 && percent !== 0 ? '-' : '';
  return `${sign}${percent}%`;
}

/**
 * Time left until a window resets, as a limit row shows it: `còn 4g 30p`, `còn 45p`, `còn 2n 3g`.
 * Under a minute it reads `còn dưới 1p`, and a reset already passed reads `đã đặt lại`. Empty when
 * either time is unknown, so no countdown is invented.
 */
export function formatResetIn(resetAtMs: number, nowMs: number): string {
  if (!Number.isFinite(resetAtMs) || !Number.isFinite(nowMs)) return '';
  const remaining = resetAtMs - nowMs;
  if (remaining <= 0) return 'đã đặt lại';
  const minutes = Math.floor(remaining / MINUTE_MS);
  if (minutes === 0) return 'còn dưới 1p';
  if (minutes < MINUTES_PER_HOUR) return `còn ${minutes}p`;
  const hours = Math.floor(minutes / MINUTES_PER_HOUR);
  const restMinutes = minutes % MINUTES_PER_HOUR;
  if (hours < 24) return restMinutes === 0 ? `còn ${hours}g` : `còn ${hours}g ${restMinutes}p`;
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours === 0 ? `còn ${days}n` : `còn ${days}n ${restHours}g`;
}

/** A span as a clock for the refresh countdown: `1:42`, or `1:02:03` past an hour. */
export function formatCountdownClock(ms: number): string {
  if (!Number.isFinite(ms)) return MISSING_TEXT;
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  return hours > 0 ? `${hours}:${pad2(minutes)}:${pad2(rest)}` : `${minutes}:${pad2(rest)}`;
}

/** A local-time clock reading, `HH:mm`. Local on purpose: the page shows the user's own time. */
export function formatClock(ms: number): string {
  const date = new Date(ms);
  if (!Number.isFinite(date.getTime())) return MISSING_TEXT;
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/**
 * A folder key as omp writes it: a drive letter between the first two slashes, then the path
 * segments, for example `/D//a/b`, `/D/tmp/` or `/V/project/`. Shown as a Windows path, `D:\a\b`;
 * the drive root `/D//` shows as `D:\`. Any other key is returned unchanged.
 */
const FOLDER_KEY = /^\/([A-Za-z])\/(.*)$/;

export function prettyFolder(folder: string): string {
  const match = FOLDER_KEY.exec(folder);
  if (match === null) return folder;
  const [, drive, rest] = match;
  const segments = rest.split('/').filter((segment) => segment !== '');
  return `${drive}:\\${segments.join('\\')}`;
}

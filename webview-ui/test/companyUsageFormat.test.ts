import { describe, expect, it } from 'vitest';

import {
  formatClock,
  formatCount,
  formatCountdown,
  formatDuration,
  formatPercent,
  formatTokens,
  formatUsd,
  prettyFolder,
} from '../src/company/usage/usageFormat.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe('formatPercent', () => {
  it('rounds a share to a whole percent', () => {
    expect(formatPercent(0.57)).toBe('57%');
    expect(formatPercent(0)).toBe('0%');
  });

  it('rounds an exact half up', () => {
    expect(formatPercent(0.5)).toBe('50%');
    expect(formatPercent(0.575)).toBe('58%');
    expect(formatPercent(0.285)).toBe('29%');
    expect(formatPercent(0.005)).toBe('1%');
  });

  it('keeps a share above one hundred percent so overuse shows', () => {
    expect(formatPercent(1.2)).toBe('120%');
  });

  it('shows a dash for a missing share, never zero', () => {
    expect(formatPercent(Number.NaN)).toBe('—');
    expect(formatPercent(Number.POSITIVE_INFINITY)).toBe('—');
  });
});

describe('formatUsd', () => {
  it('formats with a dot for thousands and a comma for cents', () => {
    expect(formatUsd(1234.56)).toBe('$1.234,56');
    expect(formatUsd(1234567.891)).toBe('$1.234.567,89');
  });

  it('rounds the float sum 0.1 + 0.2 to cents', () => {
    expect(formatUsd(0.1 + 0.2)).toBe('$0,30');
  });

  it('shows zero plainly', () => {
    expect(formatUsd(0)).toBe('$0,00');
  });

  it('shows a positive amount under half a cent as less than one cent', () => {
    expect(formatUsd(0.004)).toBe('< $0,01');
    expect(formatUsd(0.005)).toBe('$0,01');
  });

  it('puts the sign before the dollar sign', () => {
    expect(formatUsd(-5)).toBe('-$5,00');
  });

  it('shows a dash for a missing amount, never zero', () => {
    expect(formatUsd(Number.NaN)).toBe('—');
  });
});

describe('formatCount', () => {
  it('groups thousands with dots', () => {
    expect(formatCount(1234567)).toBe('1.234.567');
    expect(formatCount(999)).toBe('999');
  });

  it('rounds a fraction half up and keeps the sign', () => {
    expect(formatCount(2.5)).toBe('3');
    expect(formatCount(0.4)).toBe('0');
    expect(formatCount(-1234)).toBe('-1.234');
  });

  it('shows a dash for a missing count', () => {
    expect(formatCount(Number.NaN)).toBe('—');
  });
});

describe('formatTokens', () => {
  it('keeps small counts exact', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(999)).toBe('999');
  });

  it('abbreviates thousands, millions and billions with one decimal', () => {
    expect(formatTokens(1000)).toBe('1 nghìn');
    expect(formatTokens(1234)).toBe('1,2 nghìn');
    expect(formatTokens(12345)).toBe('12,3 nghìn');
    expect(formatTokens(1234567)).toBe('1,2 triệu');
    expect(formatTokens(1500000000)).toBe('1,5 tỷ');
  });

  it('carries a rounded-up value into the next unit', () => {
    expect(formatTokens(999999)).toBe('1 triệu');
  });

  it('groups a very large value in the largest unit', () => {
    expect(formatTokens(1234000000000)).toBe('1.234 tỷ');
  });

  it('keeps the sign', () => {
    expect(formatTokens(-2000)).toBe('-2 nghìn');
  });

  it('shows a dash for a missing count', () => {
    expect(formatTokens(Number.NaN)).toBe('—');
  });
});

describe('formatDuration', () => {
  it('reads zero and negative spans as zero minutes', () => {
    expect(formatDuration(0)).toBe('0 phút');
    expect(formatDuration(-MINUTE)).toBe('0 phút');
  });

  it('reads a span under one minute as such', () => {
    expect(formatDuration(30 * 1000)).toBe('dưới 1 phút');
  });

  it('shows minutes under an hour', () => {
    expect(formatDuration(45 * MINUTE)).toBe('45 phút');
  });

  it('shows hours and minutes, dropping zero minutes', () => {
    expect(formatDuration(2 * HOUR + 16 * MINUTE)).toBe('2 giờ 16 phút');
    expect(formatDuration(2 * HOUR)).toBe('2 giờ');
  });

  it('shows days and hours, dropping zero hours', () => {
    expect(formatDuration(3 * DAY + 4 * HOUR)).toBe('3 ngày 4 giờ');
    expect(formatDuration(DAY)).toBe('1 ngày');
  });

  it('shows a dash for a missing span', () => {
    expect(formatDuration(Number.NaN)).toBe('—');
  });
});

describe('formatCountdown', () => {
  const now = 1_000_000_000_000;

  it('counts down to a future reset', () => {
    expect(formatCountdown(now + 2 * HOUR + 16 * MINUTE, now)).toBe('đặt lại sau 2 giờ 16 phút');
    expect(formatCountdown(now + 3 * DAY + 4 * HOUR, now)).toBe('đặt lại sau 3 ngày 4 giờ');
    expect(formatCountdown(now + 45 * MINUTE, now)).toBe('đặt lại sau 45 phút');
    expect(formatCountdown(now + 30 * 1000, now)).toBe('đặt lại sau dưới 1 phút');
  });

  it('reads a reset that is now or past as already reset', () => {
    expect(formatCountdown(now, now)).toBe('đã đặt lại');
    expect(formatCountdown(now - MINUTE, now)).toBe('đã đặt lại');
  });

  it('shows nothing when the time cannot be read', () => {
    expect(formatCountdown(Number.NaN, now)).toBe('');
    expect(formatCountdown(Number.POSITIVE_INFINITY, now)).toBe('');
    expect(formatCountdown(now + HOUR, Number.NaN)).toBe('');
  });
});

describe('formatClock', () => {
  it('shows the local time as hours and minutes', () => {
    expect(formatClock(new Date(2026, 9, 19, 9, 5).getTime())).toBe('09:05');
    expect(formatClock(new Date(2026, 9, 19, 21, 30).getTime())).toBe('21:30');
  });

  it('shows a dash for a missing time', () => {
    expect(formatClock(Number.NaN)).toBe('—');
  });
});

describe('prettyFolder', () => {
  it('turns a drive marker path into a Windows drive path', () => {
    expect(prettyFolder('/D//')).toBe('D:\\');
    expect(prettyFolder('/D//a/b')).toBe('D:\\a\\b');
    expect(prettyFolder('/D/tmp/')).toBe('D:\\tmp');
    expect(prettyFolder('/V/Duancanhan-Project_QuanLyGiaiDau/')).toBe(
      'V:\\Duancanhan-Project_QuanLyGiaiDau',
    );
  });

  it('leaves other paths unchanged', () => {
    expect(prettyFolder('/home/user')).toBe('/home/user');
    expect(prettyFolder('D:\\x')).toBe('D:\\x');
  });
});

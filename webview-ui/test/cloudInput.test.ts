import { afterEach, describe, expect, it, vi } from 'vitest';

import { CLOUD_ENTER_DELAY_MS, registerCloudInput, sendCloudLine } from '../src/company/fleet/cloudInput.js';

afterEach(() => vi.useRealTimers());

describe('sendCloudLine', () => {
  it('types the line into the terminal as one paste, then presses Enter after a short pause', () => {
    vi.useFakeTimers();
    const written: string[] = [];
    registerCloudInput(7, (data) => (written.push(data), true));
    expect(sendCloudLine(7, '  sửa lỗi xếp sân\ndòng hai  ')).toBe(true);
    expect(written).toEqual(['\u001b[200~sửa lỗi xếp sân\ndòng hai\u001b[201~']);
    vi.advanceTimersByTime(CLOUD_ENTER_DELAY_MS);
    expect(written).toEqual(['\u001b[200~sửa lỗi xếp sân\ndòng hai\u001b[201~', '\r']);
  });

  it('refuses a terminal that is not connected, and an empty line, without writing anything', () => {
    const written: string[] = [];
    registerCloudInput(8, (data) => (written.push(data), true));
    expect(sendCloudLine(99, 'xin chào')).toBe(false);
    expect(sendCloudLine(8, '   ')).toBe(false);
    expect(written).toEqual([]);
  });

  it('reports a failed write and does not press Enter', () => {
    vi.useFakeTimers();
    const written: string[] = [];
    registerCloudInput(9, (data) => (written.push(data), false));
    expect(sendCloudLine(9, 'xin chào')).toBe(false);
    vi.advanceTimersByTime(CLOUD_ENTER_DELAY_MS * 2);
    expect(written).toHaveLength(1);
  });

  it('forgets a terminal once it is unregistered', () => {
    const off = registerCloudInput(10, () => true);
    off();
    expect(sendCloudLine(10, 'xin chào')).toBe(false);
  });

  it('does not let a stale unregister remove a newer registration of the same terminal', () => {
    const first = registerCloudInput(11, () => true);
    registerCloudInput(11, () => true);
    first();
    expect(sendCloudLine(11, 'xin chào')).toBe(true);
  });
});

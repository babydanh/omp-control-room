import { describe, expect, it } from 'vitest';

import {
  capacityWindowName,
  spanName,
  spanNameFromText,
  tierName,
  windowName,
  windowSpanName,
} from '../src/company/usage/usageLabels.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe('spanName', () => {
  it('names a whole span in days, hours or minutes', () => {
    expect(spanName(5 * HOUR)).toBe('5 giờ');
    expect(spanName(7 * DAY)).toBe('7 ngày');
    expect(spanName(90 * MINUTE)).toBe('90 phút');
  });

  it('names no span that is missing, not positive, or not a whole minute', () => {
    expect(spanName(undefined)).toBeNull();
    expect(spanName(0)).toBeNull();
    expect(spanName(90_000)).toBeNull();
    expect(spanName(Number.NaN)).toBeNull();
  });
});

describe('spanNameFromText', () => {
  it('reads the span a label names', () => {
    expect(spanNameFromText('5-hour limit')).toBe('5 giờ');
    expect(spanNameFromText('Claude 5 Hour')).toBe('5 giờ');
    expect(spanNameFromText('Claude 7 Day (Fable)')).toBe('7 ngày');
    expect(spanNameFromText('2 giờ')).toBe('2 giờ');
    expect(spanNameFromText('90 minutes')).toBe('90 phút');
  });

  it('reads weekly and daily windows by name', () => {
    expect(spanNameFromText('Weekly')).toBe('Tuần');
    expect(spanNameFromText('daily quota')).toBe('Ngày');
  });

  it('names no span in a label that has none', () => {
    expect(spanNameFromText('Credit balance')).toBeNull();
    expect(spanNameFromText('GPT-5 High')).toBeNull();
    expect(spanNameFromText('Gemini 3.1 Flash')).toBeNull();
  });
});

describe('tierName', () => {
  it('capitalises a model tier', () => {
    expect(tierName('fable')).toBe('Fable');
  });
});

describe('windowSpanName', () => {
  it('shows the span once when the label and window label both name it', () => {
    expect(windowSpanName({ id: 'five', label: '5-hour limit', windowLabel: '5-hour' })).toBe(
      '5 giờ',
    );
  });

  it('prefers the duration to the label text', () => {
    expect(windowSpanName({ id: 'w', label: 'Session', durationMs: 5 * HOUR })).toBe('5 giờ');
  });

  it('keeps the provider label, once, when no span is known', () => {
    expect(
      windowSpanName({ id: 'credits', label: 'Credit balance', windowLabel: 'Credit balance' }),
    ).toBe('Credit balance');
    expect(windowSpanName({ id: 'bal', label: 'Credit balance', windowLabel: 'Balance' })).toBe(
      'Credit balance · Balance',
    );
  });

  it('falls back to the id when there is no label at all', () => {
    expect(windowSpanName({ id: 'x', label: '' })).toBe('x');
  });
});

describe('windowName', () => {
  it("adds one model tier's own window's tier after the span", () => {
    expect(
      windowName({ id: 'seven', label: 'Claude 7 Day (Fable)', tier: 'fable', shared: false }),
    ).toBe('7 ngày · Fable');
  });

  it('leaves a shared window with no tier', () => {
    expect(
      windowName({
        id: 'seven',
        label: 'Claude 7 Day',
        durationMs: 7 * DAY,
        shared: true,
        tier: 'fable',
      }),
    ).toBe('7 ngày');
  });

  it('does not repeat a tier the name already carries', () => {
    expect(windowName({ id: 'c', label: 'Opus credits', tier: 'opus', shared: false })).toBe(
      'Opus credits',
    );
  });
});

describe('capacityWindowName', () => {
  it('names a capacity row by its span and meter', () => {
    expect(capacityWindowName({ window: '5 hours', durationMs: 5 * HOUR, meter: 'fable' })).toBe(
      '5 giờ · Fable',
    );
  });

  it('reads the span from the window text when no duration is known', () => {
    expect(capacityWindowName({ window: 'weekly', durationMs: 0 })).toBe('Tuần');
  });

  it('keeps unrecognised window text, and names a blank one', () => {
    expect(capacityWindowName({ window: 'burst', durationMs: 0 })).toBe('burst');
    expect(capacityWindowName({ window: '  ', durationMs: 0 })).toBe('Cửa sổ');
  });
});

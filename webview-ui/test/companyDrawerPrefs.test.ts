import { describe, expect, it } from 'vitest';

import {
  clampDrawerWidth,
  DEFAULT_DRAWER_PREFS,
  DRAWER_PREFS_KEY,
  type DrawerStorage,
  drawerWidthForKey,
  drawerWidthLimit,
  readDrawerPrefs,
  writeDrawerPrefs,
} from '../src/company/drawerPrefs.js';

/** An in-memory store, optionally already holding a raw value under the drawer key. */
function memoryStorage(
  initial: string | null = null,
): DrawerStorage & { cells: Map<string, string> } {
  const cells = new Map<string, string>();
  if (initial !== null) cells.set(DRAWER_PREFS_KEY, initial);
  return {
    cells,
    getItem: (key) => cells.get(key) ?? null,
    setItem: (key, value) => {
      cells.set(key, value);
    },
  };
}

describe('drawerWidthLimit', () => {
  it('lets the drawer take 90% of the viewport', () => {
    expect(drawerWidthLimit(1920)).toBe(1728);
  });

  it('never goes below the minimum width', () => {
    expect(drawerWidthLimit(300)).toBe(320);
  });

  it('gives the minimum for a viewport that is not a number', () => {
    expect(drawerWidthLimit(Number.NaN)).toBe(320);
  });
});

describe('clampDrawerWidth', () => {
  it('keeps a width in range, rounded to whole pixels', () => {
    expect(clampDrawerWidth(400.4, 1920)).toBe(400);
  });

  it('raises a width below the minimum', () => {
    expect(clampDrawerWidth(100, 1920)).toBe(320);
  });

  it('caps a width at the viewport limit', () => {
    expect(clampDrawerWidth(2000, 1000)).toBe(900);
  });

  it('takes the default width for a width that is not finite', () => {
    expect(clampDrawerWidth(Number.NaN, 1920)).toBe(560);
    expect(clampDrawerWidth(Number.POSITIVE_INFINITY, 1920)).toBe(560);
  });

  it('still allows the minimum in a narrow viewport', () => {
    expect(clampDrawerWidth(560, 300)).toBe(320);
  });
});

describe('drawerWidthForKey', () => {
  it('widens the drawer on Left, since the handle sits on its left edge', () => {
    expect(drawerWidthForKey(400, 'ArrowLeft', false, 1920)).toBe(416);
  });

  it('narrows the drawer on Right', () => {
    expect(drawerWidthForKey(400, 'ArrowRight', false, 1920)).toBe(384);
  });

  it('moves by the large step while Shift is held', () => {
    expect(drawerWidthForKey(400, 'ArrowLeft', true, 1920)).toBe(464);
    expect(drawerWidthForKey(400, 'ArrowRight', true, 1920)).toBe(336);
  });

  it('stops at the minimum and at the viewport limit', () => {
    expect(drawerWidthForKey(330, 'ArrowRight', true, 1920)).toBe(320);
    expect(drawerWidthForKey(1700, 'ArrowLeft', true, 1920)).toBe(1728);
  });

  it('jumps to the minimum on Home and to the limit on End', () => {
    expect(drawerWidthForKey(600, 'Home', false, 1920)).toBe(320);
    expect(drawerWidthForKey(600, 'End', false, 1920)).toBe(1728);
  });

  it('answers no other key', () => {
    expect(drawerWidthForKey(400, 'a', false, 1920)).toBeNull();
    expect(drawerWidthForKey(400, 'Enter', false, 1920)).toBeNull();
  });
});

describe('readDrawerPrefs', () => {
  it('gives the defaults with no storage at all', () => {
    expect(readDrawerPrefs(null)).toEqual(DEFAULT_DRAWER_PREFS);
  });

  it('gives the defaults when nothing is stored yet', () => {
    expect(readDrawerPrefs(memoryStorage())).toEqual(DEFAULT_DRAWER_PREFS);
  });

  it.each(['not json', '[]', 'null', '42', '"wide"'])(
    'gives the defaults for a stored value that is not an object (%s)',
    (raw) => {
      expect(readDrawerPrefs(memoryStorage(raw))).toEqual(DEFAULT_DRAWER_PREFS);
    },
  );

  it('falls back field by field when a value has the wrong type', () => {
    expect(readDrawerPrefs(memoryStorage('{"width":"wide","maximized":"yes"}'))).toEqual({
      width: 560,
      maximized: false,
    });
  });

  it('takes the default width for an infinite stored width', () => {
    expect(readDrawerPrefs(memoryStorage('{"width":1e400}'))).toEqual(DEFAULT_DRAWER_PREFS);
  });

  it('raises a stored width below the minimum and keeps a stored maximize', () => {
    expect(readDrawerPrefs(memoryStorage('{"width":100,"maximized":true}'))).toEqual({
      width: 320,
      maximized: true,
    });
  });

  it('rounds a stored fractional width to whole pixels', () => {
    expect(readDrawerPrefs(memoryStorage('{"width":420.6,"maximized":false}'))).toEqual({
      width: 421,
      maximized: false,
    });
  });
});

describe('writeDrawerPrefs', () => {
  it('stores the prefs under the drawer key, and reads them back', () => {
    const storage = memoryStorage();
    writeDrawerPrefs(storage, { width: 612.7, maximized: true });

    expect(JSON.parse(storage.cells.get(DRAWER_PREFS_KEY) ?? 'null')).toEqual({
      width: 613,
      maximized: true,
    });
    expect(readDrawerPrefs(storage)).toEqual({ width: 613, maximized: true });
  });

  it('never stores a width below the minimum', () => {
    const storage = memoryStorage();
    writeDrawerPrefs(storage, { width: 10, maximized: false });

    expect(readDrawerPrefs(storage).width).toBe(320);
  });

  it('does nothing without storage', () => {
    expect(() => writeDrawerPrefs(null, DEFAULT_DRAWER_PREFS)).not.toThrow();
  });
});

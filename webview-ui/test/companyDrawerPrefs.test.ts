import { describe, expect, it } from 'vitest';

import {
  clampDrawerWidth,
  DEFAULT_DRAWER_PREFS,
  DRAWER_PREFS_KEY,
  type DrawerStorage,
  drawerWidthForKey,
  drawerWidthLimit,
  effectiveDrawerWidth,
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
  it('leaves the visible lanes their room beside the drawer', () => {
    expect(drawerWidthLimit(1920)).toBe(1376);
  });

  it('never goes below the minimum width', () => {
    expect(drawerWidthLimit(300)).toBe(280);
  });

  it('gives the minimum for a viewport that is not a number', () => {
    expect(drawerWidthLimit(Number.NaN)).toBe(280);
  });
});

describe('clampDrawerWidth', () => {
  it('keeps a width in range, rounded to whole pixels', () => {
    expect(clampDrawerWidth(400.4, 1920)).toBe(400);
  });

  it('raises a width below the minimum', () => {
    expect(clampDrawerWidth(100, 1920)).toBe(280);
  });

  it('caps a width at the room the board leaves', () => {
    expect(clampDrawerWidth(2000, 1000)).toBe(456);
  });

  it('takes the default width for a width that is not finite', () => {
    expect(clampDrawerWidth(Number.NaN, 1920)).toBe(560);
    expect(clampDrawerWidth(Number.POSITIVE_INFINITY, 1920)).toBe(560);
  });

  it('still allows the minimum in a narrow viewport', () => {
    expect(clampDrawerWidth(560, 300)).toBe(280);
  });
});

describe('effectiveDrawerWidth', () => {
  it('takes 40% of the board until the user has resized the drawer', () => {
    expect(effectiveDrawerWidth(null, 1268)).toBe(507);
  });

  it('never takes more than the default width until the user resizes it', () => {
    expect(effectiveDrawerWidth(null, 2000)).toBe(560);
  });

  it('keeps the minimum when two lanes leave no room on a 1024 viewport', () => {
    expect(effectiveDrawerWidth(null, 724)).toBe(280);
  });

  it('keeps a width the user dragged to, within the room the board leaves', () => {
    expect(effectiveDrawerWidth(700, 1268)).toBe(700);
    expect(effectiveDrawerWidth(900, 1268)).toBe(724);
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

  it('stops at the minimum and at the room the board leaves', () => {
    expect(drawerWidthForKey(330, 'ArrowRight', true, 1920)).toBe(280);
    expect(drawerWidthForKey(1700, 'ArrowLeft', true, 1920)).toBe(1376);
  });

  it('jumps to the minimum on Home and to the limit on End', () => {
    expect(drawerWidthForKey(600, 'Home', false, 1920)).toBe(280);
    expect(drawerWidthForKey(600, 'End', false, 1920)).toBe(1376);
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
      width: null,
      maximized: false,
      wrapLines: true,
    });
  });

  it('takes the default width for an infinite stored width', () => {
    expect(readDrawerPrefs(memoryStorage('{"width":1e400}'))).toEqual(DEFAULT_DRAWER_PREFS);
  });

  it('raises a stored width below the minimum and keeps a stored maximize', () => {
    expect(readDrawerPrefs(memoryStorage('{"width":100,"maximized":true}'))).toEqual({
      width: 280,
      maximized: true,
      wrapLines: true,
    });
  });

  it('rounds a stored fractional width to whole pixels', () => {
    expect(readDrawerPrefs(memoryStorage('{"width":420.6,"maximized":false}'))).toEqual({
      width: 421,
      maximized: false,
      wrapLines: true,
    });
  });

  it('turns wrapping off only when the stored pref says so', () => {
    expect(readDrawerPrefs(memoryStorage('{"wrapLines":false}')).wrapLines).toBe(false);
    expect(readDrawerPrefs(memoryStorage('{"wrapLines":"no"}')).wrapLines).toBe(true);
  });
});

describe('writeDrawerPrefs', () => {
  it('stores the prefs under the drawer key, and reads them back', () => {
    const storage = memoryStorage();
    writeDrawerPrefs(storage, { width: 612.7, maximized: true, wrapLines: false });

    expect(JSON.parse(storage.cells.get(DRAWER_PREFS_KEY) ?? 'null')).toEqual({
      width: 613,
      maximized: true,
      wrapLines: false,
    });
    expect(readDrawerPrefs(storage)).toEqual({ width: 613, maximized: true, wrapLines: false });
  });

  it('never stores a width below the minimum', () => {
    const storage = memoryStorage();
    writeDrawerPrefs(storage, { width: 10, maximized: false, wrapLines: true });

    expect(readDrawerPrefs(storage).width).toBe(280);
  });

  it('does nothing without storage', () => {
    expect(() => writeDrawerPrefs(null, DEFAULT_DRAWER_PREFS)).not.toThrow();
  });
});

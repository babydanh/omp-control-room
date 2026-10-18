import { describe, expect, it } from 'vitest';

import {
  COMPANY_SIDEBAR_DEFAULT_WIDTH_PX,
  COMPANY_SIDEBAR_MAX_WIDTH_PX,
  COMPANY_SIDEBAR_MIN_WIDTH_PX,
} from '../src/company/constants.js';
import {
  clampSidebarWidth,
  isSidebarToggleKey,
  isTypingTarget,
  readSidebarPrefs,
  SIDEBAR_PREFS_KEY,
  type SidebarStorage,
  type TypingTarget,
  writeSidebarPrefs,
} from '../src/company/sidebarPrefs.js';

class MemoryStorage implements SidebarStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

const DEFAULTS = { collapsed: false, width: COMPANY_SIDEBAR_DEFAULT_WIDTH_PX };

describe('clampSidebarWidth', () => {
  it('keeps the width inside the grip range', () => {
    expect(clampSidebarWidth(10)).toBe(COMPANY_SIDEBAR_MIN_WIDTH_PX);
    expect(clampSidebarWidth(99_999)).toBe(COMPANY_SIDEBAR_MAX_WIDTH_PX);
    expect(clampSidebarWidth(300.4)).toBe(300);
  });

  it('gives the default width for anything that is not a finite number', () => {
    expect(clampSidebarWidth(Number.NaN)).toBe(COMPANY_SIDEBAR_DEFAULT_WIDTH_PX);
    expect(clampSidebarWidth(Number.POSITIVE_INFINITY)).toBe(COMPANY_SIDEBAR_DEFAULT_WIDTH_PX);
  });
});

describe('readSidebarPrefs', () => {
  it('uses the defaults when there is no storage or nothing stored', () => {
    expect(readSidebarPrefs(null)).toEqual(DEFAULTS);
    expect(readSidebarPrefs(new MemoryStorage())).toEqual(DEFAULTS);
  });

  it('falls back to the defaults for a damaged value instead of failing', () => {
    for (const damaged of ['{not json', 'null', '"text"', '42']) {
      const storage = new MemoryStorage();
      storage.setItem(SIDEBAR_PREFS_KEY, damaged);
      expect(readSidebarPrefs(storage)).toEqual(DEFAULTS);
    }
  });

  it('keeps a valid collapsed flag and defaults a width that is not a number', () => {
    const storage = new MemoryStorage();
    storage.setItem(SIDEBAR_PREFS_KEY, JSON.stringify({ collapsed: true, width: 'wide' }));

    expect(readSidebarPrefs(storage)).toEqual({
      collapsed: true,
      width: COMPANY_SIDEBAR_DEFAULT_WIDTH_PX,
    });
  });

  it('reads back what was written, with the width clamped', () => {
    const storage = new MemoryStorage();
    writeSidebarPrefs(storage, { collapsed: true, width: 99_999 });

    expect(readSidebarPrefs(storage)).toEqual({
      collapsed: true,
      width: COMPANY_SIDEBAR_MAX_WIDTH_PX,
    });
  });

  it('writes nothing when there is no storage', () => {
    expect(() => writeSidebarPrefs(null, DEFAULTS)).not.toThrow();
  });
});

describe('isSidebarToggleKey', () => {
  it('accepts Ctrl+B and Cmd+B, in either case', () => {
    expect(
      isSidebarToggleKey({
        key: 'b',
        ctrlKey: true,
        metaKey: false,
        shiftKey: false,
        altKey: false,
      }),
    ).toBe(true);
    expect(
      isSidebarToggleKey({
        key: 'B',
        ctrlKey: false,
        metaKey: true,
        shiftKey: false,
        altKey: false,
      }),
    ).toBe(true);
  });

  it('refuses the same key with Shift or Alt, a different key, or no modifier', () => {
    expect(
      isSidebarToggleKey({
        key: 'b',
        ctrlKey: true,
        metaKey: false,
        shiftKey: true,
        altKey: false,
      }),
    ).toBe(false);
    expect(
      isSidebarToggleKey({
        key: 'b',
        ctrlKey: true,
        metaKey: false,
        shiftKey: false,
        altKey: true,
      }),
    ).toBe(false);
    expect(
      isSidebarToggleKey({
        key: 'n',
        ctrlKey: true,
        metaKey: false,
        shiftKey: false,
        altKey: false,
      }),
    ).toBe(false);
    expect(
      isSidebarToggleKey({
        key: 'b',
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
        altKey: false,
      }),
    ).toBe(false);
  });
});

describe('isTypingTarget', () => {
  const plain: TypingTarget = {
    isContentEditable: false,
    closest: () => null,
    matches: () => false,
  };

  it('lets a key press through when there is no element', () => {
    expect(isTypingTarget(null)).toBe(false);
  });

  it('lets a press through on a plain element', () => {
    expect(isTypingTarget(plain)).toBe(false);
  });

  it('claims a press in a text field, a select, or an editable area', () => {
    expect(isTypingTarget({ ...plain, matches: () => true })).toBe(true);
    expect(isTypingTarget({ ...plain, isContentEditable: true })).toBe(true);
  });

  it('claims a press inside a terminal, where Ctrl+B is a shell key', () => {
    expect(isTypingTarget({ ...plain, closest: () => ({}) })).toBe(true);
  });
});

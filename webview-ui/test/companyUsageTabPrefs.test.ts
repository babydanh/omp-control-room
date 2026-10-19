import { describe, expect, it } from 'vitest';

import {
  readRememberedUsageTab,
  USAGE_TAB_PREFS_KEY,
  type UsageTabStorage,
  writeRememberedUsageTab,
} from '../src/company/usage/usageTabPrefs.js';

function memoryStorage(initial: Partial<Record<string, string>> = {}): UsageTabStorage & {
  values: Partial<Record<string, string>>;
} {
  const values = { ...initial };
  return {
    values,
    getItem: (key) => values[key] ?? null,
    setItem: (key, value) => {
      values[key] = value;
    },
  };
}

const refusingStorage: UsageTabStorage = {
  getItem: () => {
    throw new Error('storage is disabled');
  },
  setItem: () => {
    throw new Error('storage is full');
  },
};

describe('readRememberedUsageTab', () => {
  it('reads the tab that was remembered', () => {
    expect(readRememberedUsageTab(memoryStorage({ [USAGE_TAB_PREFS_KEY]: 'limits' }))).toBe(
      'limits',
    );
  });

  it('reads no tab from a missing or unknown value', () => {
    expect(readRememberedUsageTab(memoryStorage())).toBeNull();
    expect(readRememberedUsageTab(memoryStorage({ [USAGE_TAB_PREFS_KEY]: 'x' }))).toBeNull();
  });

  it('reads no tab when there is no store or the store refuses', () => {
    expect(readRememberedUsageTab(null)).toBeNull();
    expect(readRememberedUsageTab(refusingStorage)).toBeNull();
  });
});

describe('writeRememberedUsageTab', () => {
  it('remembers the tab under its key', () => {
    const storage = memoryStorage();
    writeRememberedUsageTab(storage, 'details');
    expect(storage.values[USAGE_TAB_PREFS_KEY]).toBe('details');
  });

  it('does nothing without a store, and survives a refused write', () => {
    expect(() => writeRememberedUsageTab(null, 'overview')).not.toThrow();
    expect(() => writeRememberedUsageTab(refusingStorage, 'overview')).not.toThrow();
  });
});

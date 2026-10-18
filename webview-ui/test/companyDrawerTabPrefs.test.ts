import { describe, expect, it } from 'vitest';

import {
  DEFAULT_DRAWER_TAB_PREFS,
  DRAWER_TAB_PREFS_KEY,
  type DrawerTabStorage,
  readDrawerTabPrefs,
  SESSION_DRAWER_TABS,
  writeDrawerTabPrefs,
} from '../src/company/drawerTabPrefs.js';

/** An in-memory store exposing the values it holds, so a test can read what was written. */
function memoryStore(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  const store: DrawerTabStorage & { values: Map<string, string> } = {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
  return store;
}

/** A store that refuses every call, as a browser with storage disabled does. */
function refusingStore(): DrawerTabStorage {
  return {
    getItem: () => {
      throw new Error('storage is disabled');
    },
    setItem: () => {
      throw new Error('storage is disabled');
    },
  };
}

describe('session drawer tabs', () => {
  it('lists the terminal first, then activity, tasks and details', () => {
    expect(SESSION_DRAWER_TABS).toEqual(['terminal', 'activity', 'tasks', 'details']);
  });

  it('has no preference before a tab is chosen', () => {
    expect(readDrawerTabPrefs(memoryStore())).toEqual(DEFAULT_DRAWER_TAB_PREFS);
    expect(readDrawerTabPrefs(null)).toEqual(DEFAULT_DRAWER_TAB_PREFS);
  });

  it.each(SESSION_DRAWER_TABS)('remembers %s across a reload', (tab) => {
    const store = memoryStore();
    writeDrawerTabPrefs(store, { session: tab });
    expect(readDrawerTabPrefs(store)).toEqual({ session: tab });
  });

  it('stores the preference under its own key', () => {
    const store = memoryStore();
    writeDrawerTabPrefs(store, { session: 'tasks' });
    expect(store.values.get(DRAWER_TAB_PREFS_KEY)).toBe(JSON.stringify({ session: 'tasks' }));
  });

  it('reads a tab name it no longer knows as no preference', () => {
    const store = memoryStore({ [DRAWER_TAB_PREFS_KEY]: JSON.stringify({ session: 'log' }) });
    expect(readDrawerTabPrefs(store)).toEqual(DEFAULT_DRAWER_TAB_PREFS);
  });

  it.each(['{not json', 'null', '"tasks"', '[]', '{}'])(
    'reads a damaged or misshapen value (%s) as no preference',
    (raw) => {
      const store = memoryStore({ [DRAWER_TAB_PREFS_KEY]: raw });
      expect(readDrawerTabPrefs(store)).toEqual(DEFAULT_DRAWER_TAB_PREFS);
    },
  );

  it('treats a refused store as no preference and never throws', () => {
    expect(readDrawerTabPrefs(refusingStore())).toEqual(DEFAULT_DRAWER_TAB_PREFS);
    expect(() => writeDrawerTabPrefs(refusingStore(), { session: 'tasks' })).not.toThrow();
  });
});

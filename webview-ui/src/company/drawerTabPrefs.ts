/**
 * drawerTabPrefs: the session drawer tab the user last chose, remembered across
 * reloads so a session that is not live reopens on the tab they were reading. A
 * live chat always opens on Terminal (see drawerView.ts); the remembered tab only
 * decides the others.
 *
 * The value lives under its own key, apart from the drawer's geometry. A damaged
 * or unknown value reads as no preference, and a refused store means the tab is
 * simply not remembered.
 */

import type { CompanyDrawerTab } from './companyState.js';

/** The session drawer's tabs in display order: the terminal first. */
export const SESSION_DRAWER_TABS: readonly CompanyDrawerTab[] = [
  'terminal',
  'activity',
  'tasks',
  'details',
];

export const DRAWER_TAB_PREFS_KEY = 'omp.company.drawerTabs.v1';

export interface DrawerTabPrefs {
  /** The tab a session drawer last showed, or null when none was chosen yet. */
  session: CompanyDrawerTab | null;
}

export const DEFAULT_DRAWER_TAB_PREFS: DrawerTabPrefs = { session: null };

/** The two storage calls the tab memory needs; `Storage` satisfies it. */
export interface DrawerTabStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function isSessionTab(value: unknown): value is CompanyDrawerTab {
  return typeof value === 'string' && (SESSION_DRAWER_TABS as readonly string[]).includes(value);
}

export function readDrawerTabPrefs(storage: DrawerTabStorage | null): DrawerTabPrefs {
  if (storage === null) return DEFAULT_DRAWER_TAB_PREFS;
  let raw: string | null;
  try {
    raw = storage.getItem(DRAWER_TAB_PREFS_KEY);
  } catch {
    return DEFAULT_DRAWER_TAB_PREFS;
  }
  if (raw === null) return DEFAULT_DRAWER_TAB_PREFS;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return DEFAULT_DRAWER_TAB_PREFS;
  }
  if (typeof parsed !== 'object' || parsed === null || !('session' in parsed)) {
    return DEFAULT_DRAWER_TAB_PREFS;
  }
  return { session: isSessionTab(parsed.session) ? parsed.session : null };
}

export function writeDrawerTabPrefs(storage: DrawerTabStorage | null, prefs: DrawerTabPrefs): void {
  if (storage === null) return;
  try {
    storage.setItem(DRAWER_TAB_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // A refused store only means the tab is not remembered.
  }
}

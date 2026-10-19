/**
 * usageTabPrefs: the usage tab the reader last chose, remembered across reloads so the page reopens
 * on it. A damaged or unknown value reads as no choice, and a refused store means the tab is simply
 * not remembered.
 */

import { isUsageTab, type UsageTab } from './usageRoute.js';

export const USAGE_TAB_PREFS_KEY = 'omp.company.usageTab.v1';

/** The two storage calls the memory needs; `Storage` satisfies it. */
export interface UsageTabStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function readRememberedUsageTab(storage: UsageTabStorage | null): UsageTab | null {
  if (storage === null) return null;
  try {
    const raw = storage.getItem(USAGE_TAB_PREFS_KEY);
    return isUsageTab(raw) ? raw : null;
  } catch {
    return null;
  }
}

export function writeRememberedUsageTab(storage: UsageTabStorage | null, tab: UsageTab): void {
  if (storage === null) return;
  try {
    storage.setItem(USAGE_TAB_PREFS_KEY, tab);
  } catch {
    // A refused store only means the tab is not remembered.
  }
}

/**
 * useUsageRoute: whether the webview shows the usage page, and which of its tabs. The page is a URL
 * (`#usage`, or `#usage/<tab>`), so the browser's back button reaches it and leaves it like any
 * other history entry.
 *
 * Entering pushes an entry; it never replaces one, so back returns to the board. Leaving steps back
 * when the page pushed the entry, and otherwise rewrites the URL to the board (the page was opened
 * by a typed or shared `#usage` link, with no board entry behind it). Switching tabs rewrites the
 * current entry in place, so back still leaves the page in one step.
 */

import { useSyncExternalStore } from 'react';

import {
  boardRouteHref,
  DEFAULT_USAGE_TAB,
  isUsageRoute,
  resolveUsageTab,
  usageRouteHref,
  type UsageTab,
} from './usage/usageRoute.js';
import {
  readRememberedUsageTab,
  type UsageTabStorage,
  writeRememberedUsageTab,
} from './usage/usageTabPrefs.js';

/** The history state key the usage page sets on the entry it pushes. */
const ENTRY_MARK = 'companyUsagePage';

function subscribeRoute(onChange: () => void): () => void {
  window.addEventListener('hashchange', onChange);
  window.addEventListener('popstate', onChange);
  return () => {
    window.removeEventListener('hashchange', onChange);
    window.removeEventListener('popstate', onChange);
  };
}

/** True while the URL names the usage page. */
export function useUsageRoute(): boolean {
  return useSyncExternalStore(
    subscribeRoute,
    () => isUsageRoute(window.location.hash),
    () => false,
  );
}

/** The usage tab on show: the one the URL names, else the one the reader last chose. */
export function useUsageTab(): UsageTab {
  return useSyncExternalStore(
    subscribeRoute,
    () => resolveUsageTab(window.location.hash, readRememberedUsageTab(browserStorage())),
    () => DEFAULT_USAGE_TAB,
  );
}

/** Shows the usage page on a new history entry, so the browser's back button returns to the board. */
export function openUsagePage(): void {
  window.history.pushState({ [ENTRY_MARK]: true }, '', usageRouteHref(window.location.href));
  // pushState fires no event, so the route's listeners are told by hand.
  window.dispatchEvent(new PopStateEvent('popstate', { state: window.history.state }));
}

/** Returns to the board: steps back to the entry the page pushed, else rewrites the URL. */
export function closeUsagePage(): void {
  const state: unknown = window.history.state;
  const pushedHere =
    typeof state === 'object' &&
    state !== null &&
    ENTRY_MARK in state &&
    state[ENTRY_MARK] === true;
  if (pushedHere) {
    window.history.back();
    return;
  }
  window.history.replaceState(null, '', boardRouteHref(window.location.href));
  // replaceState fires no event, so the route's listeners are told by hand.
  window.dispatchEvent(new PopStateEvent('popstate', { state: window.history.state }));
}

/** Shows another tab of the open page: the URL names it, and the choice is remembered. */
export function selectUsageTab(tab: UsageTab): void {
  writeRememberedUsageTab(browserStorage(), tab);
  // replaceState keeps the entry's state, so the page's own entry still steps back to the board.
  window.history.replaceState(window.history.state, '', usageRouteHref(window.location.href, tab));
  // replaceState fires no event, so the route's listeners are told by hand.
  window.dispatchEvent(new PopStateEvent('popstate', { state: window.history.state }));
}

/** The browser's localStorage, or null where the page may not use it. */
function browserStorage(): UsageTabStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

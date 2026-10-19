/**
 * usageRoute: the usage page's address. It is the board's URL with the hash `#usage`, or `#usage`
 * followed by a tab (`#usage/limits`), so the board's own query (such as `?token=`) survives the
 * trip there and back.
 */

export const USAGE_HASH = '#usage';

/** The usage page's tabs in display order. */
export const USAGE_TABS = ['overview', 'limits', 'details'] as const;

export type UsageTab = (typeof USAGE_TABS)[number];

/** The tab a page with no remembered choice opens on. */
export const DEFAULT_USAGE_TAB: UsageTab = 'overview';

export function isUsageTab(value: unknown): value is UsageTab {
  return typeof value === 'string' && (USAGE_TABS as readonly string[]).includes(value);
}

/** The tab a location hash names, such as `limits` for `#usage/limits`; null when it names none. */
export function usageTabFromHash(hash: string): UsageTab | null {
  const prefix = `${USAGE_HASH}/`;
  if (!hash.startsWith(prefix)) return null;
  const name = hash.slice(prefix.length);
  return isUsageTab(name) ? name : null;
}

/**
 * Whether a location hash opens the usage page: the bare hash, the hash with one trailing slash,
 * or the hash with one of its tabs. Case-sensitive.
 */
export function isUsageRoute(hash: string): boolean {
  return hash === USAGE_HASH || hash === `${USAGE_HASH}/` || usageTabFromHash(hash) !== null;
}

/** The tab the page shows: the one the hash names, else the remembered one, else the default. */
export function resolveUsageTab(hash: string, remembered: UsageTab | null): UsageTab {
  return usageTabFromHash(hash) ?? remembered ?? DEFAULT_USAGE_TAB;
}

/**
 * The address with the usage hash on it, keeping its path and every search parameter. A tab adds
 * itself after the hash.
 */
export function usageRouteHref(href: string, tab?: UsageTab): string {
  const hashAt = href.indexOf('#');
  const base = hashAt === -1 ? href : href.slice(0, hashAt);
  return tab === undefined ? `${base}${USAGE_HASH}` : `${base}${USAGE_HASH}/${tab}`;
}

/** The address without the usage hash or its tab, keeping its path and every search parameter. Other hashes are kept. */
export function boardRouteHref(href: string): string {
  const hashAt = href.indexOf('#');
  if (hashAt === -1 || !isUsageRoute(href.slice(hashAt))) return href;
  return href.slice(0, hashAt);
}

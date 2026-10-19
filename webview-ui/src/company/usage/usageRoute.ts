/**
 * usageRoute: the usage page's address. It is the board's URL with the hash `#usage`, so the
 * board's own query (such as `?token=`) survives the trip there and back.
 */

export const USAGE_HASH = '#usage';

/** Whether a location hash opens the usage page. Case-sensitive; one trailing slash is allowed. */
export function isUsageRoute(hash: string): boolean {
  return hash === USAGE_HASH || hash === `${USAGE_HASH}/`;
}

/** The address with the usage hash on it, keeping its path and every search parameter. */
export function usageRouteHref(href: string): string {
  const hashAt = href.indexOf('#');
  const base = hashAt === -1 ? href : href.slice(0, hashAt);
  return `${base}${USAGE_HASH}`;
}

/** The address without the usage hash, keeping its path and every search parameter. Other hashes are kept. */
export function boardRouteHref(href: string): string {
  const hashAt = href.indexOf('#');
  if (hashAt === -1 || !isUsageRoute(href.slice(hashAt))) return href;
  return href.slice(0, hashAt);
}

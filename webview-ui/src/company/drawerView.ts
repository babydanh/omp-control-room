/**
 * drawerView: the small decisions the company drawer makes about a session, as
 * pure functions: the tab it opens on, and the short model name its header shows.
 */

import type { CompanyDrawerTab } from './companyState.js';
import { terminalPolicy } from './sessionActions.js';

/**
 * The tab a session's drawer opens on when nothing asked for another. A live
 * session opens on its terminal, since that is where it is worked; any other
 * session opens on the tab the reader last picked, or the activity timeline.
 */
export function defaultDrawerTab(
  status: string,
  remembered: CompanyDrawerTab | null,
): CompanyDrawerTab {
  if (terminalPolicy(status).attach) return 'terminal';
  return remembered ?? 'activity';
}

/** The model's name without its provider: "anthropic/claude-sonnet-4-5" reads "claude-sonnet-4-5". */
export function shortModelName(model: string): string {
  const trimmed = model.trim();
  const slash = trimmed.lastIndexOf('/');
  return slash === -1 ? trimmed : trimmed.slice(slash + 1);
}

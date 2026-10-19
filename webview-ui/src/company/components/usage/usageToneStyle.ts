/**
 * Text colours for the usage page's bar bands. Kept apart from the components so that a component
 * file exports only components.
 */

import type { UsageBarTone } from '../../usage/usageLimits.js';

/** The text colour of a band, for the percent written beside a bar. */
export const TONE_TEXT: Record<UsageBarTone, string> = {
  ok: 'text-status-success',
  warn: 'text-caution',
  danger: 'text-danger',
};

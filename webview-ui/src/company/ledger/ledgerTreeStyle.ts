/**
 * Colour and icon for each tone, reason and manager dot. The tree and its legend read the
 * same maps, so a word, an icon and a colour always mean the same thing in both places.
 */

import type { IconName } from '../iconNames.js';
import type { NodeTone, ReasonTone } from './ledgerHealth.js';
import type { ManagerDot } from './ledgerManagers.js';

export const TONE_ICON: Readonly<Record<NodeTone, IconName>> = {
  ok: 'check',
  attention: 'alert-triangle',
  conflict: 'x-circle',
  merged: 'archive',
};

/** Text colour of a reason line; `info` stays neutral so it is not read as a problem. */
export const TONE_TEXT: Readonly<Record<ReasonTone, string>> = {
  ok: 'text-status-success',
  attention: 'text-caution',
  conflict: 'text-danger',
  merged: 'text-idle',
  info: 'text-text-secondary',
};

export const TONE_BADGE: Readonly<Record<NodeTone, string>> = {
  ok: 'bg-status-success/15 text-status-success',
  attention: 'bg-caution/15 text-caution',
  conflict: 'bg-danger/15 text-danger',
  merged: 'bg-idle/15 text-idle',
};

/** The accent bar on the card's left edge, drawn as an inset shadow (no border). */
export const TONE_BAR: Readonly<Record<NodeTone, string>> = {
  ok: 'var(--color-status-success)',
  attention: 'var(--color-caution)',
  conflict: 'var(--color-danger)',
  merged: 'var(--color-idle)',
};

export const TONE_STROKE: Readonly<Record<NodeTone, string>> = {
  ok: 'stroke-status-success',
  attention: 'stroke-caution',
  conflict: 'stroke-danger',
  merged: 'stroke-idle',
};

export const TONE_FILL: Readonly<Record<NodeTone, string>> = {
  ok: 'fill-status-success',
  attention: 'fill-caution',
  conflict: 'fill-danger',
  merged: 'fill-idle',
};

export const DOT_CLASS: Readonly<Record<ManagerDot, string>> = {
  waiting: 'bg-caution',
  active: 'bg-status-success',
  idle: 'bg-idle',
  ended: 'bg-idle/35',
};

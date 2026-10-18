/**
 * layoutMode: which of the three board layouts a viewport gets, and how the
 * sidebar, drawer and lane switcher present in it. Pure, so the breakpoints and
 * the phone's one-lane rules are tested without a DOM.
 *
 * phone (below 768px): one lane at a time behind a segmented switcher, the sidebar
 * is a sheet, the drawer fills the screen. tablet (768 to 1023px): the sidebar is a
 * rail, the lanes wrap beside it, the drawer floats over the board. desktop (1024px
 * and up): the sidebar and drawer dock beside the lanes.
 */

import { COMPANY_PHONE_MAX_PX, COMPANY_TABLET_MAX_PX } from './constants.js';

export type LayoutMode = 'phone' | 'tablet' | 'desktop';

/** How the sidebar sits in the layout. */
export type SidebarPresentation = 'docked' | 'overlay' | 'rail' | 'sheet' | 'hidden';

/** How the detail drawer sits in the layout. */
export type DrawerPresentation = 'docked' | 'maximized' | 'overlay' | 'fullscreen';

/** A horizontal drag this far, and further than it is tall, switches lanes on a phone. */
export const LANE_SWIPE_THRESHOLD_PX = 48;

/** The layout a viewport of this width gets; a width that is not a number is a desktop. */
export function layoutModeFor(viewportWidth: number): LayoutMode {
  if (!Number.isFinite(viewportWidth)) return 'desktop';
  if (viewportWidth <= COMPANY_PHONE_MAX_PX) return 'phone';
  if (viewportWidth <= COMPANY_TABLET_MAX_PX) return 'tablet';
  return 'desktop';
}

/**
 * A phone has no rail: a collapsed sidebar is hidden and reopened from the top bar.
 * A tablet's collapsed sidebar is the rail; an open one floats over the board.
 */
export function sidebarPresentation(mode: LayoutMode, collapsed: boolean): SidebarPresentation {
  if (mode === 'phone') return collapsed ? 'hidden' : 'sheet';
  if (mode === 'tablet') return collapsed ? 'rail' : 'overlay';
  return collapsed ? 'rail' : 'docked';
}

/** A phone's drawer fills the screen and a tablet's floats; the desktop drawer docks unless maximized. */
export function drawerPresentation(mode: LayoutMode, maximized: boolean): DrawerPresentation {
  if (mode === 'phone') return 'fullscreen';
  if (mode === 'tablet') return 'overlay';
  return maximized ? 'maximized' : 'docked';
}

/**
 * The lane a phone opens on: the first lane in attention order that holds a card,
 * else the first lane. Null only when there are no lanes.
 */
export function defaultActiveLane<T extends string>(
  lanes: readonly { id: T; count: number }[],
  attentionOrder: readonly T[],
): T | null {
  for (const id of attentionOrder) {
    if (lanes.some((lane) => lane.id === id && lane.count > 0)) return id;
  }
  return lanes[0]?.id ?? null;
}

/**
 * The lane one step away from `current`, clamped at the ends rather than wrapping:
 * a swipe past the last lane stops there. An unknown `current` starts at the first.
 */
export function stepActiveLane<T extends string>(
  ids: readonly T[],
  current: T,
  delta: -1 | 1,
): T | null {
  if (ids.length === 0) return null;
  const index = ids.indexOf(current);
  if (index < 0) return ids[0] ?? null;
  const next = Math.min(ids.length - 1, Math.max(0, index + delta));
  return ids[next] ?? null;
}

/**
 * The lane step a drag asks for: a leftward swipe moves to the next lane, a rightward
 * one to the previous. A short drag, or one more vertical than horizontal, is a
 * scroll and asks for nothing.
 */
export function swipeStep(dx: number, dy: number, threshold: number): -1 | 0 | 1 {
  if (Math.abs(dx) < threshold || Math.abs(dx) <= Math.abs(dy)) return 0;
  return dx < 0 ? 1 : -1;
}

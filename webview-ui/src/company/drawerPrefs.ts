/**
 * drawerPrefs: the company detail drawer's remembered shape: how wide it is and
 * whether it fills the board. Stored once per webview under its own key, the way
 * sidebarPrefs.ts stores the sidebar. A missing or damaged value falls back to
 * the defaults rather than failing the drawer.
 *
 * The storage is described structurally, so this module needs no DOM lib; the
 * shell passes the browser's own storage in.
 */

import {
  COMPANY_DRAWER_DEFAULT_SHARE,
  COMPANY_DRAWER_DEFAULT_WIDTH_PX,
  COMPANY_DRAWER_MIN_WIDTH_PX,
  COMPANY_DRAWER_RESIZE_LARGE_STEP_PX,
  COMPANY_DRAWER_RESIZE_STEP_PX,
  COMPANY_LANE_WIDTH_PX,
  COMPANY_LANES_VISIBLE_MIN,
} from './constants.js';

export interface DrawerPrefs {
  /** The width the user last dragged to, in CSS pixels; null until they resize, when the drawer takes its default share of the board. */
  width: number | null;
  /** Whether the drawer fills the board instead of sitting beside its content. */
  maximized: boolean;
  /** Whether screen and log lines wrap to the drawer's width. Off keeps each line whole and scrolls sideways. */
  wrapLines: boolean;
}

/**
 * The storage key. It is v2 because earlier builds wrote the default width (560) on
 * every load, and that stored number would read as a width the user had chosen.
 */
export const DRAWER_PREFS_KEY = 'omp.company.drawer.v2';

/** The part of Storage the drawer uses; a test passes a plain object. */
export interface DrawerStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const DEFAULT_DRAWER_PREFS: DrawerPrefs = {
  width: null,
  maximized: false,
  wrapLines: true,
};

/**
 * The widest the drawer may be beside a board this wide: the board's width less
 * the room the visible lanes need, and never narrower than the minimum. A width
 * that is not a number gets the minimum.
 */
export function drawerWidthLimit(boardWidth: number): number {
  const room = Number.isFinite(boardWidth)
    ? Math.floor(boardWidth) - COMPANY_LANES_VISIBLE_MIN * COMPANY_LANE_WIDTH_PX
    : 0;
  return Math.max(COMPANY_DRAWER_MIN_WIDTH_PX, room);
}

/** A width as whole pixels, at least the minimum; anything not a number takes the default. */
function wholeWidth(width: number): number {
  const requested = Number.isFinite(width) ? width : COMPANY_DRAWER_DEFAULT_WIDTH_PX;
  return Math.max(COMPANY_DRAWER_MIN_WIDTH_PX, Math.round(requested));
}

/** The width clamped to the drawer's range beside a board of this width. */
export function clampDrawerWidth(width: number, boardWidth: number): number {
  return Math.min(drawerWidthLimit(boardWidth), wholeWidth(width));
}

/**
 * The width the drawer takes beside a board this wide: the width the user last
 * dragged to, or until then 40% of the board at most the default; clamped to the
 * room the board leaves.
 */
export function effectiveDrawerWidth(width: number | null, boardWidth: number): number {
  const share = Math.floor(boardWidth * COMPANY_DRAWER_DEFAULT_SHARE);
  return clampDrawerWidth(width ?? Math.min(COMPANY_DRAWER_DEFAULT_WIDTH_PX, share), boardWidth);
}

/**
 * The width a drawer asks for before the board clamps it: the width the reader last
 * dragged to. Until they drag, a live chat session asks for the widest the board
 * leaves room for, since its terminal is where the work happens; anything else
 * keeps the default share.
 */
export function rememberedOrChatWidth(
  width: number | null,
  liveChat: boolean,
  boardWidth: number,
): number | null {
  if (width !== null || !liveChat) return width;
  return drawerWidthLimit(boardWidth);
}

/**
 * The width after a key press on the resize handle, or null when the handle does
 * not answer that key. The handle sits on the drawer's left edge, so Left widens
 * it; Home and End take the minimum and the largest width the board leaves room for.
 */
export function drawerWidthForKey(
  width: number,
  key: string,
  shiftKey: boolean,
  boardWidth: number,
): number | null {
  const step = shiftKey ? COMPANY_DRAWER_RESIZE_LARGE_STEP_PX : COMPANY_DRAWER_RESIZE_STEP_PX;
  switch (key) {
    case 'ArrowLeft':
      return clampDrawerWidth(width + step, boardWidth);
    case 'ArrowRight':
      return clampDrawerWidth(width - step, boardWidth);
    case 'Home':
      return COMPANY_DRAWER_MIN_WIDTH_PX;
    case 'End':
      return drawerWidthLimit(boardWidth);
    default:
      return null;
  }
}

/** What the drawer remembers; a missing or unreadable value yields the defaults. */
export function readDrawerPrefs(storage: DrawerStorage | null): DrawerPrefs {
  const raw = storage?.getItem(DRAWER_PREFS_KEY) ?? null;
  if (raw === null) return { ...DEFAULT_DRAWER_PREFS };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...DEFAULT_DRAWER_PREFS };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ...DEFAULT_DRAWER_PREFS };
  }
  const width =
    'width' in parsed && typeof parsed.width === 'number' && Number.isFinite(parsed.width)
      ? wholeWidth(parsed.width)
      : null;
  const maximized = 'maximized' in parsed && parsed.maximized === true;
  const wrapLines = 'wrapLines' in parsed ? parsed.wrapLines !== false : true;
  return { width, maximized, wrapLines };
}

export function writeDrawerPrefs(storage: DrawerStorage | null, prefs: DrawerPrefs): void {
  storage?.setItem(
    DRAWER_PREFS_KEY,
    JSON.stringify({
      width: prefs.width === null ? null : wholeWidth(prefs.width),
      maximized: prefs.maximized,
      wrapLines: prefs.wrapLines,
    }),
  );
}

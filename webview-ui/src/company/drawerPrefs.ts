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
  COMPANY_DRAWER_DEFAULT_WIDTH_PX,
  COMPANY_DRAWER_MAX_VIEWPORT_SHARE,
  COMPANY_DRAWER_MIN_WIDTH_PX,
  COMPANY_DRAWER_RESIZE_LARGE_STEP_PX,
  COMPANY_DRAWER_RESIZE_STEP_PX,
} from './constants.js';

export interface DrawerPrefs {
  /** The width the user last dragged to, in CSS pixels; clamped to the viewport when drawn. */
  width: number;
  /** Whether the drawer fills the board instead of sitting beside its content. */
  maximized: boolean;
}

export const DRAWER_PREFS_KEY = 'omp.company.drawer';

/** The part of Storage the drawer uses; a test passes a plain object. */
export interface DrawerStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const DEFAULT_DRAWER_PREFS: DrawerPrefs = {
  width: COMPANY_DRAWER_DEFAULT_WIDTH_PX,
  maximized: false,
};

/**
 * The widest the drawer may be in a viewport this wide: a share of it, and never
 * narrower than the minimum. A viewport that is not a number gets the minimum.
 */
export function drawerWidthLimit(viewportWidth: number): number {
  const share = Number.isFinite(viewportWidth)
    ? Math.floor(viewportWidth * COMPANY_DRAWER_MAX_VIEWPORT_SHARE)
    : 0;
  return Math.max(COMPANY_DRAWER_MIN_WIDTH_PX, share);
}

/** A width as whole pixels, at least the minimum; anything not a number takes the default. */
function wholeWidth(width: number): number {
  const requested = Number.isFinite(width) ? width : COMPANY_DRAWER_DEFAULT_WIDTH_PX;
  return Math.max(COMPANY_DRAWER_MIN_WIDTH_PX, Math.round(requested));
}

/** The width clamped to the drawer's range in a viewport of this width. */
export function clampDrawerWidth(width: number, viewportWidth: number): number {
  return Math.min(drawerWidthLimit(viewportWidth), wholeWidth(width));
}

/**
 * The width after a key press on the resize handle, or null when the handle does
 * not answer that key. The handle sits on the drawer's left edge, so Left widens
 * it; Home and End take the minimum and the largest width the viewport allows.
 */
export function drawerWidthForKey(
  width: number,
  key: string,
  shiftKey: boolean,
  viewportWidth: number,
): number | null {
  const step = shiftKey ? COMPANY_DRAWER_RESIZE_LARGE_STEP_PX : COMPANY_DRAWER_RESIZE_STEP_PX;
  switch (key) {
    case 'ArrowLeft':
      return clampDrawerWidth(width + step, viewportWidth);
    case 'ArrowRight':
      return clampDrawerWidth(width - step, viewportWidth);
    case 'Home':
      return COMPANY_DRAWER_MIN_WIDTH_PX;
    case 'End':
      return drawerWidthLimit(viewportWidth);
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
  const width = 'width' in parsed && typeof parsed.width === 'number' ? parsed.width : Number.NaN;
  const maximized = 'maximized' in parsed && parsed.maximized === true;
  return { width: wholeWidth(width), maximized };
}

export function writeDrawerPrefs(storage: DrawerStorage | null, prefs: DrawerPrefs): void {
  storage?.setItem(
    DRAWER_PREFS_KEY,
    JSON.stringify({ width: wholeWidth(prefs.width), maximized: prefs.maximized }),
  );
}

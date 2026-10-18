/**
 * sidebarPrefs: the agent sidebar's remembered shape: whether it is collapsed
 * and how wide it is. Stored once per webview; a missing or damaged value falls
 * back to the defaults rather than failing the board.
 *
 * The storage, key event and event target are described structurally, so this
 * module needs no DOM lib; the shell passes the browser's own objects in.
 */

import {
  COMPANY_SIDEBAR_DEFAULT_WIDTH_PX,
  COMPANY_SIDEBAR_MAX_WIDTH_PX,
  COMPANY_SIDEBAR_MIN_WIDTH_PX,
} from './constants.js';

export interface SidebarPrefs {
  collapsed: boolean;
  width: number;
}

export const SIDEBAR_PREFS_KEY = 'omp.company.sidebar';

/** The part of Storage the sidebar uses; a test passes a plain object. */
export interface SidebarStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** The part of a key event the toggle reads; a KeyboardEvent satisfies it. */
export interface SidebarShortcutEvent {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/** The part of an element the typing check reads; an HTMLElement satisfies it. */
export interface TypingTarget {
  readonly isContentEditable: boolean;
  closest(selector: string): unknown;
  matches(selector: string): boolean;
}

const DEFAULT_PREFS: SidebarPrefs = {
  collapsed: false,
  width: COMPANY_SIDEBAR_DEFAULT_WIDTH_PX,
};

/** The width clamped to the grip's range; anything not a number takes the default. */
export function clampSidebarWidth(width: number): number {
  if (!Number.isFinite(width)) return COMPANY_SIDEBAR_DEFAULT_WIDTH_PX;
  return Math.min(
    COMPANY_SIDEBAR_MAX_WIDTH_PX,
    Math.max(COMPANY_SIDEBAR_MIN_WIDTH_PX, Math.round(width)),
  );
}

export function readSidebarPrefs(storage: SidebarStorage | null): SidebarPrefs {
  const raw = storage?.getItem(SIDEBAR_PREFS_KEY) ?? null;
  if (raw === null) return { ...DEFAULT_PREFS };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...DEFAULT_PREFS };
  }
  if (typeof parsed !== 'object' || parsed === null) return { ...DEFAULT_PREFS };
  const collapsed = 'collapsed' in parsed && parsed.collapsed === true;
  const width = 'width' in parsed && typeof parsed.width === 'number' ? parsed.width : Number.NaN;
  return { collapsed, width: clampSidebarWidth(width) };
}

export function writeSidebarPrefs(storage: SidebarStorage | null, prefs: SidebarPrefs): void {
  storage?.setItem(
    SIDEBAR_PREFS_KEY,
    JSON.stringify({ collapsed: prefs.collapsed, width: clampSidebarWidth(prefs.width) }),
  );
}

/** Ctrl+B (⌘B on macOS) with no Shift or Alt: the sidebar's toggle. */
export function isSidebarToggleKey(event: SidebarShortcutEvent): boolean {
  return (
    (event.ctrlKey || event.metaKey) &&
    !event.shiftKey &&
    !event.altKey &&
    event.key.toLowerCase() === 'b'
  );
}

/**
 * Whether a key press belongs to a field or a terminal, so the toggle must
 * leave it alone: Ctrl+B is a shell key inside xterm and a word key in a field.
 */
export function isTypingTarget(target: TypingTarget | null): boolean {
  if (target === null) return false;
  if (target.isContentEditable || target.closest('.xterm') !== null) return true;
  return target.matches('input, textarea, select');
}

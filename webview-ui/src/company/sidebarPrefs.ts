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
  /** Keys of the projects the user folded: a board folder's key or a herdr group's. */
  collapsedProjects: string[];
}

export const SIDEBAR_PREFS_KEY = 'omp.company.sidebar';

/** The part of Storage the sidebar uses; a test passes a plain object. */
export interface SidebarStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** The part of an element the typing check reads; an HTMLElement satisfies it. */
export interface TypingTarget {
  readonly isContentEditable: boolean;
  closest(selector: string): unknown;
  matches(selector: string): boolean;
}

/** The most folded project keys kept; a stored list longer than this is cut short. */
const MAX_COLLAPSED_PROJECTS = 200;

const DEFAULT_PREFS: SidebarPrefs = {
  collapsed: false,
  width: COMPANY_SIDEBAR_DEFAULT_WIDTH_PX,
  collapsedProjects: [],
};

/** The width clamped to the grip's range; anything not a number takes the default. */
export function clampSidebarWidth(width: number): number {
  if (!Number.isFinite(width)) return COMPANY_SIDEBAR_DEFAULT_WIDTH_PX;
  return Math.min(
    COMPANY_SIDEBAR_MAX_WIDTH_PX,
    Math.max(COMPANY_SIDEBAR_MIN_WIDTH_PX, Math.round(width)),
  );
}

function defaultPrefs(): SidebarPrefs {
  return { ...DEFAULT_PREFS, collapsedProjects: [] };
}

/** The stored project keys, as strings, without blanks or duplicates, and bounded. */
function keyList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const keys = value.filter((key): key is string => typeof key === 'string' && key !== '');
  return [...new Set(keys)].slice(0, MAX_COLLAPSED_PROJECTS);
}

export function readSidebarPrefs(storage: SidebarStorage | null): SidebarPrefs {
  const raw = storage?.getItem(SIDEBAR_PREFS_KEY) ?? null;
  if (raw === null) return defaultPrefs();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return defaultPrefs();
  }
  if (typeof parsed !== 'object' || parsed === null) return defaultPrefs();
  const collapsed = 'collapsed' in parsed && parsed.collapsed === true;
  const width = 'width' in parsed && typeof parsed.width === 'number' ? parsed.width : Number.NaN;
  const folded = 'collapsedProjects' in parsed ? parsed.collapsedProjects : [];
  return { collapsed, width: clampSidebarWidth(width), collapsedProjects: keyList(folded) };
}

export function writeSidebarPrefs(storage: SidebarStorage | null, prefs: SidebarPrefs): void {
  storage?.setItem(
    SIDEBAR_PREFS_KEY,
    JSON.stringify({
      collapsed: prefs.collapsed,
      width: clampSidebarWidth(prefs.width),
      collapsedProjects: keyList(prefs.collapsedProjects),
    }),
  );
}

/** The folded project keys with `key` added when it is open, or removed when it is folded. */
export function toggleProjectKey(keys: readonly string[], key: string): string[] {
  return keys.includes(key) ? keys.filter((entry) => entry !== key) : [...keys, key];
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

/**
 * composerPrefs: the height the user dragged the composer's text box to. Stored
 * once per webview under its own key, the way drawerPrefs.ts stores the drawer. A
 * missing or unreadable value means the box was never dragged, so it idles at its
 * default height.
 */

/** The storage key; the value is the box's border-box height in pixels. */
export const COMPOSER_HEIGHT_KEY = 'omp.company.composer.height';

/** The part of Storage this uses; a test passes a plain object. */
export interface ComposerStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** The browser's localStorage, or null where the page may not use it. */
export function composerStorage(): ComposerStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** The remembered height, or null when none is saved or the saved value is not a usable height. */
export function readComposerHeight(storage: ComposerStorage | null): number | null {
  if (storage === null) return null;
  try {
    const raw = storage.getItem(COMPOSER_HEIGHT_KEY);
    if (raw === null) return null;
    const px = Number(raw);
    return Number.isFinite(px) && px > 0 ? Math.round(px) : null;
  } catch {
    return null;
  }
}

/** Remember the height. A storage that refuses the write keeps the height until the page reloads. */
export function writeComposerHeight(storage: ComposerStorage | null, px: number): void {
  if (storage === null) return;
  try {
    storage.setItem(COMPOSER_HEIGHT_KEY, String(Math.round(px)));
  } catch {
    // Quota or privacy mode: the box keeps the height for this page only.
  }
}

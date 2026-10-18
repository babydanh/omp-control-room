/**
 * ShortcutsSheet: the keyboard reference, opened with `?`. It lists the shortcut
 * registry grouped by surface, so the keys it shows are the keys the handlers
 * answer to. The caller passes the platform; the sheet does not read navigator.
 */

import { useEffect, useRef } from 'react';

import { matchShortcut, shortcutKeyTokens, shortcutsByGroup } from '../shortcuts.js';
import { Icon } from './Icon.js';

/** The registry is static, so its grouping is computed once. */
const SECTIONS = shortcutsByGroup();

export interface ShortcutsSheetProps {
  /** Whether keys read as Mac symbols (⌘ ⇧ ⌥ ↵). */
  isMac: boolean;
  onClose: () => void;
}

export function ShortcutsSheet({ isMac, onClose }: ShortcutsSheetProps) {
  const closeRef = useRef<HTMLButtonElement>(null);

  // Focus the close button on open, and return focus to whatever held it, if that is still on the page.
  useEffect(() => {
    const returnTo = document.activeElement;
    closeRef.current?.focus();
    return () => {
      if (returnTo instanceof HTMLElement && returnTo.isConnected) returnTo.focus();
    };
  }, []);

  // Escape closes the sheet; the registry owns the key, so this stays in step with it.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (!matchShortcut('board.escape', event)) return;
      event.preventDefault();
      onClose();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center">
      <button
        type="button"
        aria-label="Đóng phím tắt"
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-black/40"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Phím tắt"
        className="relative flex max-h-[85vh] w-[min(520px,92vw)] flex-col gap-3 overflow-hidden rounded-(--company-radius-md) border border-hairline bg-panel p-3 max-md:h-full max-md:max-h-none max-md:w-full max-md:rounded-none"
      >
        <header className="flex shrink-0 items-center justify-between gap-2">
          <h2 className="text-sm text-text">Phím tắt</h2>
          <button
            ref={closeRef}
            type="button"
            aria-label="Đóng"
            onClick={onClose}
            className="company-icon-btn touch-target"
          >
            <Icon name="close" />
          </button>
        </header>
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
          {SECTIONS.map((section) => (
            <section
              key={section.group}
              aria-labelledby={`shortcut-group-${section.group}`}
              className="flex flex-col gap-1"
            >
              <h3 id={`shortcut-group-${section.group}`} className="text-2xs text-text-muted">
                {section.label}
              </h3>
              <dl className="flex flex-col">
                {section.shortcuts.map((def) => (
                  <div key={def.id} className="flex items-center justify-between gap-3 py-1.5">
                    <dt className="min-w-0 text-sm text-text">{def.label}</dt>
                    <dd className="flex shrink-0 flex-wrap justify-end gap-1">
                      {shortcutKeyTokens(def, isMac).map((token, index) => (
                        <kbd
                          key={`${def.id}-${index}`}
                          className="rounded-(--company-radius-sm) bg-raised px-1.5 py-0.5 text-2xs text-text-muted"
                        >
                          {token}
                        </kbd>
                      ))}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
        <p className="shrink-0 text-2xs text-text-muted">
          Phím tắt này áp dụng khi không đang nhập chữ, trừ những phím có ghi khác.
        </p>
      </div>
    </div>
  );
}

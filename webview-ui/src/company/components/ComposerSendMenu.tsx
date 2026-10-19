/**
 * The composer's send control, split in two: Gửi sends to the selected target, and the chevron
 * opens the menu of the other ways to hand the draft on. Arrow keys, Home and End move among the
 * enabled entries; Escape and Tab close the menu and return focus to the chevron.
 */

import { type KeyboardEvent as ReactKeyboardEvent, useEffect, useRef, useState } from 'react';

import { type SendMenuEntry, type SendMenuEntryId, sendMenuStep } from '../composerSendMenu.js';
import { shortcutKeysLabel, SHORTCUTS } from '../shortcuts.js';
import { Icon } from './Icon.js';

/** Enabled entries only: a disabled one stays visible, shows its reason, and is skipped by the keys. */
const ITEM_SELECTOR = 'button[role="menuitem"]:not([aria-disabled="true"])';

/** The platform test the board's shortcut hints use. */
const IS_MAC = /Mac|iPhone|iPad|iPod/.test(navigator.platform);

function enabledItems(menu: HTMLElement | null): HTMLElement[] {
  return menu === null ? [] : Array.from(menu.querySelectorAll<HTMLElement>(ITEM_SELECTOR));
}

export interface ComposerSendMenuProps {
  /** The primary label: "Gửi", or "Đang gửi..." while a send is in flight. */
  readonly sendLabel: string;
  readonly sendDisabled: boolean;
  readonly onSend: () => void;
  readonly entries: readonly SendMenuEntry[];
  readonly onRun: (id: SendMenuEntryId) => void;
}

export function ComposerSendMenu({
  sendLabel,
  sendDisabled,
  onSend,
  entries,
  onRun,
}: ComposerSendMenuProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  /** Set when the menu opens, so its first enabled entry takes focus once it is mounted. */
  const focusFirst = useRef(false);

  useEffect(() => {
    if (!open || !focusFirst.current) return;
    focusFirst.current = false;
    enabledItems(menuRef.current)[0]?.focus({ preventScroll: true });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus({ preventScroll: true });
    }
    function onPointerDown(event: PointerEvent): void {
      if (event.target instanceof Node && wrapRef.current?.contains(event.target)) return;
      setOpen(false);
    }
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('pointerdown', onPointerDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open]);

  function openMenu(): void {
    focusFirst.current = true;
    setOpen(true);
  }

  function onTriggerClick(): void {
    if (open) setOpen(false);
    else openMenu();
  }

  function onTriggerKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>): void {
    if (event.key !== 'ArrowDown') return;
    event.preventDefault();
    if (open) enabledItems(menuRef.current)[0]?.focus({ preventScroll: true });
    else openMenu();
  }

  function onMenuKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    if (event.key === 'Tab') {
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus({ preventScroll: true });
      return;
    }
    const items = enabledItems(menuRef.current);
    const current = items.indexOf(document.activeElement as HTMLElement);
    const next = sendMenuStep(event.key, current, items.length);
    if (next === null) return;
    event.preventDefault();
    items.at(next)?.focus({ preventScroll: true });
  }

  function runEntry(entry: SendMenuEntry): void {
    if (entry.disabledReason !== null) return;
    setOpen(false);
    triggerRef.current?.focus({ preventScroll: true });
    onRun(entry.id);
  }

  return (
    <div ref={wrapRef} className="relative flex shrink-0">
      <button
        type="button"
        className="company-btn company-btn-accent shrink-0 whitespace-nowrap rounded-r-none"
        disabled={sendDisabled}
        onClick={onSend}
      >
        {sendLabel}
      </button>
      <button
        ref={triggerRef}
        type="button"
        aria-label="Các cách giao khác"
        aria-haspopup="menu"
        aria-expanded={open}
        title="Các cách giao khác"
        onClick={onTriggerClick}
        onKeyDown={onTriggerKeyDown}
        className="company-btn shrink-0 rounded-l-none px-2"
      >
        <Icon name="chevron-down" className="size-3.5" />
      </button>
      {open && (
        <div className="absolute right-0 max-md:right-auto max-md:left-0 bottom-full z-50 mb-1 flex w-max min-w-[240px] max-w-[min(320px,calc(100vw-16px))] flex-col rounded-(--company-radius-md) border border-hairline bg-raised py-1 text-xs text-text">
          <p className="px-3 pt-1 pb-1.5 text-2xs font-semibold text-text-muted">Giao cho…</p>
          <div
            ref={menuRef}
            role="menu"
            aria-label="Giao cho"
            onKeyDown={onMenuKeyDown}
            className="flex flex-col"
          >
            {entries.map((entry) => (
              <SendMenuItem key={entry.id} entry={entry} onRun={runEntry} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function SendMenuItem({
  entry,
  onRun,
}: {
  entry: SendMenuEntry;
  onRun: (entry: SendMenuEntry) => void;
}) {
  const off = entry.disabledReason !== null;
  const definition = SHORTCUTS.find((candidate) => candidate.id === entry.shortcut);
  const shortcut = definition === undefined ? null : shortcutKeysLabel(definition, IS_MAC);
  return (
    <button
      type="button"
      role="menuitem"
      aria-disabled={off}
      title={entry.disabledReason ?? undefined}
      onClick={() => onRun(entry)}
      className={`touch-target flex w-full items-start gap-2.5 px-3 py-1.5 text-left outline-none ${
        off ? 'cursor-default text-text-muted' : 'text-text hover:bg-hover focus-visible:bg-hover'
      }`}
    >
      <Icon name={entry.icon} className="mt-0.5 size-3.5 shrink-0 text-text-muted" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-center justify-between gap-3">
          <span className="truncate font-semibold">{entry.label}</span>
          {shortcut !== null && (
            <span className="shrink-0 text-2xs text-text-muted">{shortcut}</span>
          )}
        </span>
        <span className="text-2xs text-text-muted">
          {off ? entry.disabledReason : entry.description}
        </span>
      </span>
    </button>
  );
}

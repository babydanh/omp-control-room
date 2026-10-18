/**
 * CommandPalette: the quick-find dialog. It ranks the rows it is given as the
 * user types, runs the chosen one, and gives focus back to the control that
 * opened it.
 */

import { Fragment, type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';

import {
  PALETTE_GROUP_LABELS,
  type PaletteItem,
  type PaletteMatch,
  rankPaletteItems,
} from '../commandPalette.js';

export interface CommandPaletteProps {
  items: readonly PaletteItem[];
  onRun: (item: PaletteItem) => void;
  onClose: () => void;
}

const LISTBOX_ID = 'palette-listbox';
/** How far PageUp and PageDown move the active row. */
const PAGE_STEP = 5;

function optionId(index: number): string {
  return `palette-opt-${index}`;
}

export function CommandPalette({ items, onRun, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  // Read during the first render, before autoFocus moves focus into the input.
  const [opener] = useState<Element | null>(() => document.activeElement);

  const matches = useMemo(() => rankPaletteItems(items, query), [items, query]);
  // Clamped at read time, so a shrinking result list never leaves the index past the end.
  const current = matches.length === 0 ? 0 : Math.min(active, matches.length - 1);
  const selected: PaletteMatch | undefined = matches.length === 0 ? undefined : matches[current];

  useEffect(() => {
    // autoFocus covers the first paint. This refocuses after StrictMode's simulated
    // remount, whose restore cleanup below would otherwise leave focus on the opener.
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    return () => {
      if (opener instanceof HTMLElement) opener.focus();
    };
  }, [opener]);

  useEffect(() => {
    document.getElementById(optionId(current))?.scrollIntoView?.({ block: 'nearest' });
  }, [current]);

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    // While an IME composition is open its keys belong to the IME (Vietnamese Telex).
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Escape') {
      onClose();
      return;
    }
    if (event.key === 'Enter') {
      if (selected === undefined) return;
      event.preventDefault();
      onRun(selected.item);
      return;
    }
    const count = matches.length;
    if (count === 0) return;
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        setActive((current + 1) % count);
        return;
      case 'ArrowUp':
        event.preventDefault();
        setActive((current - 1 + count) % count);
        return;
      case 'PageDown':
        event.preventDefault();
        setActive(Math.min(current + PAGE_STEP, count - 1));
        return;
      case 'PageUp':
        event.preventDefault();
        setActive(Math.max(current - PAGE_STEP, 0));
        return;
      default:
        return;
    }
  }

  const emptyText =
    query.trim() === '' ? 'Chưa có mục nào để tìm.' : `Không có kết quả cho “${query.trim()}”.`;

  return (
    <div className="fixed inset-0 z-40 flex justify-center pt-[12vh] max-md:block max-md:pt-0">
      <button
        type="button"
        aria-label="Đóng tìm nhanh"
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-black/40"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Tìm nhanh"
        className="relative flex max-h-[min(70vh,560px)] w-[min(640px,92vw)] flex-col overflow-hidden rounded-(--company-radius-md) border border-hairline bg-panel max-md:h-full max-md:max-h-none max-md:w-full max-md:rounded-none max-md:border-0"
      >
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-label="Tìm nhanh"
          aria-expanded
          aria-controls={LISTBOX_ID}
          aria-autocomplete="list"
          aria-activedescendant={selected === undefined ? undefined : optionId(current)}
          placeholder="Tìm phiên, agent, việc, thư mục, tệp hoặc lệnh…"
          value={query}
          autoFocus
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={handleKeyDown}
          className="touch-target w-full border-b border-hairline bg-transparent px-3 text-xs text-text placeholder:text-text-muted"
        />
        <div
          id={LISTBOX_ID}
          role="listbox"
          aria-label="Kết quả"
          className="min-h-0 flex-1 overflow-y-auto py-1"
        >
          {matches.length === 0 ? (
            <p className="px-3 py-4 text-xs text-text-muted">{emptyText}</p>
          ) : (
            matches.map((match, index) => (
              <Fragment key={match.item.id}>
                {(index === 0 || matches[index - 1].item.group !== match.item.group) && (
                  <div role="presentation" className="px-3 pt-2 pb-1 text-2xs text-text-muted">
                    {PALETTE_GROUP_LABELS[match.item.group]}
                  </div>
                )}
                <div
                  id={optionId(index)}
                  role="option"
                  aria-selected={index === current}
                  onClick={() => onRun(match.item)}
                  className={`touch-target mx-1 flex min-w-0 cursor-pointer flex-col justify-center rounded-(--company-radius-sm) px-3 py-1.5 ${index === current ? 'bg-hover' : ''}`}
                >
                  <span className="truncate text-xs text-text">{match.item.title}</span>
                  <span className="truncate text-2xs text-text-muted">{match.item.subtitle}</span>
                </div>
              </Fragment>
            ))
          )}
        </div>
        <p className="border-t border-hairline px-3 py-1.5 text-2xs text-text-muted">
          ↑↓ chọn · Enter mở · Esc đóng
        </p>
      </div>
    </div>
  );
}

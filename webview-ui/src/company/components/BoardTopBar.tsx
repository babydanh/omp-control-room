/**
 * BoardTopBar: one row. On the left, the title and where the board is pointed (the
 * folder switcher); on the right, the new chat button, the company's health pill, the
 * search and the "⋯" menu. The menu holds the agent sidebar, the workspace files, the
 * git tree, the usage page and the shortcuts sheet, each labelled (with its shortcut, if any).
 * On a phone the title is kept for screen readers only and the new chat button shrinks to a plus.
 */

import { useEffect, useId, useRef, useState } from 'react';

import type { CompanyClient } from '../companyClient.js';
import type { CompanyViewState } from '../companyState.js';
import type { IconName } from '../iconNames.js';
import type { LayoutMode } from '../layoutMode.js';
import { matchShortcut, type ShortcutId, shortcutKeysLabel, SHORTCUTS } from '../shortcuts.js';
import { ChatNewButton } from './ChatNewButton.js';
import { Icon } from './Icon.js';
import { StatusPill } from './StatusPill.js';
import { WorkspaceSwitcher } from './WorkspaceSwitcher.js';

export interface BoardTopBarProps {
  client: CompanyClient;
  state: CompanyViewState;
  mode: LayoutMode;
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
  filesOpen: boolean;
  onToggleFiles: () => void;
  /** Whether the ledger can be opened: the server has accepted this connection's probe. */
  ledgerAvailable: boolean;
  ledgerOpen: boolean;
  onToggleLedger: () => void;
  /** Whether the platform is Apple; shortcut hints use its modifier symbols. */
  isMac: boolean;
  onOpenPalette: () => void;
  onOpenShortcuts: () => void;
  /** Opens the "Vai trò & model" dialog. */
  onOpenRoles: () => void;
  /** Opens the usage page: a route of its own, so the board is not drawn beneath it. */
  onOpenUsage: () => void;
  /** Bumped by the palette to open the folder browser once per bump. */
  browseRequest: number;
}

/** The key label of a registry shortcut, or null when the registry has none. */
function shortcutHint(id: ShortcutId, isMac: boolean): string | null {
  const def = SHORTCUTS.find((entry) => entry.id === id);
  return def === undefined ? null : shortcutKeysLabel(def, isMac);
}

/** A tooltip that carries the shortcut for an action, when the registry has one. */
function withShortcut(label: string, id: ShortcutId, isMac: boolean): string {
  const hint = shortcutHint(id, isMac);
  return hint === null ? label : `${label} (${hint})`;
}

interface ToolsMenuItem {
  key: string;
  icon: IconName;
  label: string;
  shortcut?: ShortcutId;
  /** Set for a tool that stays open or closed; the row reads as selected while it is open. */
  pressed?: boolean;
  onSelect: () => void;
}

/** The "⋯" menu: every tool that is not needed on every visit, each labelled and with its shortcut. */
function ToolsMenu({ items, isMac }: { items: readonly ToolsMenuItem[]; isMac: boolean }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  // The menu closes on a press outside it, or on Escape.
  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && rootRef.current?.contains(event.target)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (matchShortcut('board.escape', event)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        aria-label="Công cụ khác"
        title="Công cụ khác"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => setOpen((current) => !current)}
        className="company-icon-btn touch-target shrink-0 px-2 text-sm"
      >
        <Icon name="more" />
      </button>
      {open && (
        <div
          id={menuId}
          role="group"
          aria-label="Công cụ khác"
          className="absolute right-0 top-full z-40 mt-1 flex w-60 max-w-[calc(100vw-1rem)] flex-col gap-0.5 rounded-(--company-radius-md) bg-raised p-1 text-2xs"
        >
          {items.map((item) => {
            const hint = item.shortcut === undefined ? null : shortcutHint(item.shortcut, isMac);
            return (
              <button
                key={item.key}
                type="button"
                aria-pressed={item.pressed}
                onClick={() => {
                  setOpen(false);
                  item.onSelect();
                }}
                className="touch-target flex w-full cursor-pointer items-center gap-2 rounded-(--company-radius-sm) px-2 py-1.5 text-left text-text hover:bg-hover aria-pressed:bg-selected"
              >
                <Icon name={item.icon} className="shrink-0" />
                <span className="min-w-0 flex-1 truncate">{item.label}</span>
                {hint !== null && <span className="shrink-0 text-text-muted">{hint}</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function BoardTopBar({
  client,
  state,
  mode,
  sidebarCollapsed,
  onToggleSidebar,
  filesOpen,
  onToggleFiles,
  ledgerAvailable,
  ledgerOpen,
  onToggleLedger,
  isMac,
  onOpenPalette,
  onOpenShortcuts,
  onOpenRoles,
  onOpenUsage,
  browseRequest,
}: BoardTopBarProps) {
  const phone = mode === 'phone';
  const searchLabel = withShortcut('Tìm kiếm và lệnh', 'board.palette', isMac);
  const tools: ToolsMenuItem[] = [
    {
      key: 'agents',
      icon: 'users',
      label: 'Đàn agent',
      shortcut: 'board.sidebar',
      pressed: !sidebarCollapsed,
      onSelect: onToggleSidebar,
    },
    {
      key: 'roles',
      icon: 'settings',
      label: 'Vai trò & model',
      onSelect: onOpenRoles,
    },
    {
      key: 'files',
      icon: 'file-text',
      label: 'Tệp',
      shortcut: 'board.files',
      pressed: filesOpen,
      onSelect: onToggleFiles,
    },
    ...(ledgerAvailable
      ? [
          {
            key: 'ledger',
            icon: 'git-branch' as const,
            label: 'Cây git',
            shortcut: 'board.ledger' as const,
            pressed: ledgerOpen,
            onSelect: onToggleLedger,
          },
        ]
      : []),
    {
      key: 'usage',
      icon: 'bar-chart',
      label: 'Sử dụng token',
      onSelect: onOpenUsage,
    },
    {
      key: 'shortcuts',
      icon: 'keyboard',
      label: 'Phím tắt',
      shortcut: 'board.help',
      onSelect: onOpenShortcuts,
    },
  ];

  return (
    <header
      className={
        phone ? 'flex items-center gap-1.5 px-2 py-1.5' : 'flex items-center gap-3 px-3 py-2'
      }
    >
      <h1 className={phone ? 'sr-only' : 'shrink-0 text-base text-text'}>Agent Board</h1>
      <div className={phone ? 'min-w-0 flex-1' : 'min-w-0'}>
        <WorkspaceSwitcher client={client} state={state} browseRequest={browseRequest} />
      </div>
      {!phone && <div className="min-w-0 flex-1" />}
      <ChatNewButton client={client} compact={phone} />
      <StatusPill client={client} state={state} />
      <button
        type="button"
        onClick={onOpenPalette}
        aria-label={searchLabel}
        title={searchLabel}
        className="company-icon-btn touch-target shrink-0 gap-1.5 px-2 text-2xs"
      >
        <Icon name="search" />
        {!phone && <span>Tìm…</span>}
      </button>
      <ToolsMenu items={tools} isMac={isMac} />
    </header>
  );
}

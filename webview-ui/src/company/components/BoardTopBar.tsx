/**
 * BoardTopBar: where the board is pointed, how healthy the company is, and the
 * tools that open the palette, the agent sidebar, the workspace files, the git
 * tree and the shortcuts sheet. The health readings sit behind one status pill;
 * the tools are icon buttons whose tooltips carry their shortcuts. On a phone the
 * bar keeps the sidebar toggle, the workspace, the palette and the pill; the "more"
 * menu holds the new chat button, the files, the git tree and the shortcuts sheet.
 */

import { useState } from 'react';

import type { CompanyClient } from '../companyClient.js';
import type { CompanyViewState } from '../companyState.js';
import type { IconName } from '../iconNames.js';
import type { LayoutMode } from '../layoutMode.js';
import { type ShortcutId, shortcutKeysLabel, SHORTCUTS } from '../shortcuts.js';
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
  /** Bumped by the palette to open the folder path field once per bump. */
  folderRequest: number;
}

/** A tooltip that carries the shortcut for an action, when the registry has one. */
function withShortcut(label: string, id: ShortcutId, isMac: boolean): string {
  const def = SHORTCUTS.find((entry) => entry.id === id);
  return def === undefined ? label : `${label} (${shortcutKeysLabel(def, isMac)})`;
}

/** A bare icon button: its label is both the accessible name and the tooltip. */
function ToolButton({
  icon,
  label,
  pressed,
  onClick,
}: {
  icon: IconName;
  label: string;
  pressed?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      onClick={onClick}
      className="company-icon-btn touch-target shrink-0 px-2 text-sm"
    >
      <Icon name={icon} />
    </button>
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
  folderRequest,
}: BoardTopBarProps) {
  const [menuOpen, setMenuOpen] = useState(false);

  if (mode === 'phone') {
    return (
      <>
        <header className="flex items-center gap-2 px-2 py-1.5">
          <button
            type="button"
            onClick={onToggleSidebar}
            aria-label="Đàn agent"
            aria-expanded={!sidebarCollapsed}
            className="company-icon-btn touch-target shrink-0 px-2 text-sm"
          >
            <Icon name="menu" />
          </button>
          <h1 className="min-w-0 shrink truncate text-base text-text">OMP Board</h1>
          <div className="min-w-0 flex-1">
            <WorkspaceSwitcher client={client} state={state} openRequest={folderRequest} />
          </div>
          <ToolButton
            icon="search"
            label={withShortcut('Tìm kiếm và lệnh', 'board.palette', isMac)}
            onClick={onOpenPalette}
          />
          <StatusPill state={state} />
          <button
            type="button"
            onClick={() => setMenuOpen((open) => !open)}
            aria-label="Công cụ khác"
            aria-expanded={menuOpen}
            aria-controls="company-more-menu"
            className="company-icon-btn touch-target shrink-0 px-2 text-sm"
          >
            <Icon name="more" />
          </button>
        </header>
        {menuOpen && (
          <div
            id="company-more-menu"
            className="mx-2 mb-1 flex flex-col items-start gap-2 rounded-(--company-radius-md) bg-raised px-2 py-2"
          >
            <ChatNewButton client={client} />
            <button
              type="button"
              aria-pressed={filesOpen}
              onClick={() => {
                setMenuOpen(false);
                onToggleFiles();
              }}
              className="company-toggle touch-target"
            >
              Tệp
            </button>
            {ledgerAvailable && (
              <button
                type="button"
                aria-pressed={ledgerOpen}
                onClick={() => {
                  setMenuOpen(false);
                  onToggleLedger();
                }}
                className="company-toggle touch-target"
              >
                Cây git
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                setMenuOpen(false);
                onOpenShortcuts();
              }}
              className="company-toggle touch-target"
            >
              Phím tắt
            </button>
          </div>
        )}
      </>
    );
  }

  return (
    <header className="flex items-center gap-3 px-3 py-2">
      <h1 className="shrink-0 text-base text-text">OMP Board</h1>
      <WorkspaceSwitcher client={client} state={state} openRequest={folderRequest} />
      <div className="min-w-0 flex-1" />
      <ChatNewButton client={client} />
      <StatusPill state={state} />
      <nav className="flex shrink-0 items-center gap-1" aria-label="Thanh công cụ">
        <ToolButton
          icon="search"
          label={withShortcut('Tìm kiếm và lệnh', 'board.palette', isMac)}
          onClick={onOpenPalette}
        />
        <ToolButton
          icon="users"
          label={withShortcut('Đàn agent', 'board.sidebar', isMac)}
          pressed={!sidebarCollapsed}
          onClick={onToggleSidebar}
        />
        <ToolButton icon="file-text" label="Tệp" pressed={filesOpen} onClick={onToggleFiles} />
        {ledgerAvailable && (
          <ToolButton
            icon="git-branch"
            label="Cây git"
            pressed={ledgerOpen}
            onClick={onToggleLedger}
          />
        )}
        <ToolButton
          icon="keyboard"
          label={withShortcut('Phím tắt', 'board.help', isMac)}
          onClick={onOpenShortcuts}
        />
      </nav>
    </header>
  );
}

/**
 * BoardTopBar: where the board is pointed and how healthy the company is, with
 * the toggles that open the agent sidebar and the workspace files. On a phone the
 * bar keeps the sidebar toggle, the workspace and a menu; the menu holds the
 * readings and the files toggle.
 *
 * Every number is read from a server message; a value the server has not sent
 * yet reads as unknown, never as zero.
 */

import { useState } from 'react';

import type { CompanyClient } from '../companyClient.js';
import type { CompanyViewState } from '../companyState.js';
import type { LayoutMode } from '../layoutMode.js';
import { quotaRows } from '../usageView.js';
import { Icon } from './Icon.js';
import { WorkspaceSwitcher } from './WorkspaceSwitcher.js';

export interface BoardTopBarProps {
  client: CompanyClient;
  state: CompanyViewState;
  mode: LayoutMode;
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
  filesOpen: boolean;
  onToggleFiles: () => void;
}

/**
 * The class every reading in the top bar shares: a small chip, muted until it matters.
 * Chips shrink and truncate rather than push the buttons off the bar; the container
 * query classes hide the ones that no longer fit.
 */
const CHIP_CLASS =
  'min-w-0 max-w-full truncate rounded-full bg-raised px-2 py-0.5 text-2xs text-text-muted';

/** The catalog chip: loading until the server has answered, then how many models are usable. */
function CatalogStatus({ state }: { state: CompanyViewState }) {
  const entries = state.modelCatalog;
  const usable = entries.filter((entry) => entry.credentialsConfigured).length;
  const text = !state.modelCatalogLoaded
    ? 'đang tải mô hình…'
    : entries.length === 0
      ? 'không có mô hình nào'
      : `mô hình: ${usable}/${entries.length} dùng được`;
  return (
    <span className={CHIP_CLASS} title={text}>
      {text}
    </span>
  );
}

/**
 * The readings a bar shows: the revision, the model catalog, the omp runner and the
 * provider quota. A `compact` bar lets its container query decide which of them fit;
 * the phone menu shows them all in full.
 */
function StatusChips({ state, compact }: { state: CompanyViewState; compact: boolean }) {
  const diagnostics = state.diagnostics;
  const runner = diagnostics
    ? `omp đang chạy ${diagnostics.liveRunners}/${diagnostics.modelLeases} · xếp hàng ${diagnostics.queuedTasks} · giữ lại ${diagnostics.retainedSessions}`
    : null;
  const windows = quotaRows(Object.values(state.quotas)).flatMap((row) =>
    row.windows.map(
      (quotaWindow) =>
        `${row.provider} ${quotaWindow.label}: ${quotaWindow.remaining ?? '?'} ${quotaWindow.reportedUnit}`,
    ),
  );
  return (
    <>
      <span className={compact ? `${CHIP_CLASS} hidden @min-[760px]:block` : CHIP_CLASS}>
        bản sửa {state.revision ?? '-'}
      </span>
      <CatalogStatus state={state} />
      {runner !== null && (
        <span className={CHIP_CLASS}>
          <span className={compact ? 'hidden @min-[560px]:inline' : undefined}>{runner}</span>
          {compact && (
            <span className="@min-[560px]:hidden" title={runner}>
              omp
            </span>
          )}
        </span>
      )}
      {windows.map((text) => (
        <span
          key={text}
          title="Còn lại theo tài khoản nhà cung cấp"
          className={compact ? `${CHIP_CLASS} hidden @min-[640px]:block` : CHIP_CLASS}
        >
          {text}
        </span>
      ))}
    </>
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
            <WorkspaceSwitcher client={client} state={state} />
          </div>
          <button
            type="button"
            onClick={() => setMenuOpen((open) => !open)}
            aria-label="Trạng thái và công cụ"
            aria-expanded={menuOpen}
            aria-controls="company-status-menu"
            className="company-icon-btn touch-target shrink-0 px-2 text-sm"
          >
            <Icon name="more" />
          </button>
        </header>
        {menuOpen && (
          <div
            id="company-status-menu"
            className="mx-2 mb-1 flex flex-col items-start gap-2 rounded-[var(--company-radius-md)] bg-raised px-2 py-2"
          >
            <div className="flex w-full flex-wrap gap-1.5">
              <StatusChips state={state} compact={false} />
            </div>
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
          </div>
        )}
      </>
    );
  }

  return (
    <header className="flex items-center gap-3 px-3 py-2">
      <h1 className="shrink-0 text-base text-text">OMP Board</h1>
      <WorkspaceSwitcher client={client} state={state} />
      <span className="@container flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
        <StatusChips state={state} compact />
      </span>
      <nav className="flex shrink-0 gap-1.5" aria-label="Thanh công cụ">
        <button
          type="button"
          onClick={onToggleSidebar}
          aria-pressed={!sidebarCollapsed}
          title="Mở rộng hoặc thu gọn đàn agent (Ctrl+B)"
          className="company-toggle touch-target"
        >
          Đàn agent
        </button>
        <button
          type="button"
          onClick={onToggleFiles}
          aria-pressed={filesOpen}
          className="company-toggle touch-target"
        >
          Tệp
        </button>
      </nav>
    </header>
  );
}

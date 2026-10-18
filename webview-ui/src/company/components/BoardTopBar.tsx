/**
 * BoardTopBar: where the board is pointed and how healthy the company is, with
 * the two toggles that open the agent sidebar and the workspace files.
 *
 * Every number is read from a server message; a value the server has not sent
 * yet reads as unknown, never as zero.
 */

import type { CompanyModelCatalogEntry } from '../../../../core/src/company.js';
import type { CompanyClient } from '../companyClient.js';
import type { CompanyViewState } from '../companyState.js';
import { quotaRows } from '../usageView.js';
import { WorkspaceSwitcher } from './WorkspaceSwitcher.js';

export interface BoardTopBarProps {
  client: CompanyClient;
  state: CompanyViewState;
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
  'min-w-0 max-w-full truncate rounded-full border border-border px-2 py-0.5 text-2xs text-text-muted';

function CatalogStatus({ entries }: { entries: readonly CompanyModelCatalogEntry[] }) {
  const usable = entries.filter((entry) => entry.credentialsConfigured).length;
  const text =
    entries.length === 0
      ? 'danh mục mô hình: chưa tải'
      : `mô hình: ${usable}/${entries.length} dùng được`;
  return (
    <span className={CHIP_CLASS} title={text}>
      {text}
    </span>
  );
}

function QuotaStatus({ state }: { state: CompanyViewState }) {
  const windows = quotaRows(Object.values(state.quotas)).flatMap((row) =>
    row.windows.map(
      (quotaWindow) =>
        `${row.provider} ${quotaWindow.label}: ${quotaWindow.remaining ?? '?'} ${quotaWindow.reportedUnit}`,
    ),
  );
  return (
    <>
      {windows.map((text) => (
        <span
          key={text}
          title="Còn lại theo tài khoản nhà cung cấp"
          className={`${CHIP_CLASS} hidden @min-[640px]:block`}
        >
          {text}
        </span>
      ))}
    </>
  );
}

function toggleClass(pressed: boolean): string {
  return pressed
    ? 'cursor-pointer rounded-[5px] border border-accent bg-active-bg px-2.5 py-1 text-2xs text-text'
    : 'cursor-pointer rounded-[5px] border border-border px-2.5 py-1 text-2xs text-text-muted hover:border-accent hover:text-text';
}

export function BoardTopBar({
  client,
  state,
  sidebarCollapsed,
  onToggleSidebar,
  filesOpen,
  onToggleFiles,
}: BoardTopBarProps) {
  const diagnostics = state.diagnostics;
  const runner = diagnostics
    ? `omp đang chạy ${diagnostics.liveRunners}/${diagnostics.modelLeases} · xếp hàng ${diagnostics.queuedTasks} · giữ lại ${diagnostics.retainedSessions}`
    : null;
  return (
    <header className="flex items-center gap-3 border-b border-border px-3 py-2">
      <h1 className="shrink-0 text-base text-text">OMP Board</h1>
      <WorkspaceSwitcher client={client} state={state} />
      <span className="@container flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
        <span className={`${CHIP_CLASS} hidden @min-[760px]:block`}>
          bản sửa {state.revision ?? '-'}
        </span>
        <CatalogStatus entries={state.modelCatalog} />
        {runner !== null && (
          <span className={CHIP_CLASS}>
            <span className="hidden @min-[560px]:inline">{runner}</span>
            <span className="@min-[560px]:hidden" title={runner}>
              omp
            </span>
          </span>
        )}
        <QuotaStatus state={state} />
      </span>
      <nav className="flex shrink-0 gap-1.5" aria-label="Thanh công cụ">
        <button
          type="button"
          onClick={onToggleSidebar}
          aria-pressed={!sidebarCollapsed}
          title="Mở rộng hoặc thu gọn đàn agent (Ctrl+B)"
          className={toggleClass(!sidebarCollapsed)}
        >
          Đàn agent
        </button>
        <button
          type="button"
          onClick={onToggleFiles}
          aria-pressed={filesOpen}
          className={toggleClass(filesOpen)}
        >
          Tệp
        </button>
      </nav>
    </header>
  );
}

/**
 * LedgerView: the "Cây git" board for the company. It shows each repo's git tree and the
 * session timeline, with a detail panel for the current selection. Phone layouts show
 * the detail and the side panels as full-screen sheets instead of a side column.
 */

import { type ReactNode, useEffect, useState } from 'react';

import { Icon } from '../components/Icon.js';
import { useLayoutMode } from '../useLayoutMode.js';
import { ledgerStore } from './ledgerClient.js';
import { LedgerDetailPanel } from './LedgerDetailPanel.js';
import { databaseLabel, formatClock, parseLedgerTimestamp } from './ledgerFormat.js';
import { type PaneInput } from './ledgerManagers.js';
import type { BoardSessionIndex } from './ledgerMapping.js';
import { type LedgerSelection, resolveSelection } from './ledgerSelection.js';
import { LedgerSidePanels } from './LedgerSidePanels.js';
import { type LedgerState, useLedgerState } from './ledgerStore.js';
import { LedgerTimelineTab } from './LedgerTimelineTab.js';
import { LedgerTreeTab } from './LedgerTreeTab.js';

type LedgerTab = 'graph' | 'timeline';

const TABS: readonly LedgerTab[] = ['graph', 'timeline'];
const TAB_LABELS: Record<LedgerTab, string> = {
  graph: 'Đồ thị nhánh',
  timeline: 'Dòng thời gian',
};

export interface LedgerViewProps {
  /** The board's sessions, to link a ledger session to its drawer, with their labels. */
  boardSessions: BoardSessionIndex;
  onOpenBoardSession: (sessionId: string) => void;
  /** Herdr panes, live and asleep, listed as managers of a checkout. */
  panes: readonly PaneInput[];
  onOpenHerdr: (paneId: string) => void;
  onOpenSleeping: (paneId: string) => void;
  onClose: () => void;
}

export function LedgerView({
  boardSessions,
  onOpenBoardSession,
  panes,
  onOpenHerdr,
  onOpenSleeping,
  onClose,
}: LedgerViewProps) {
  const ledger = useLedgerState(ledgerStore);
  const phone = useLayoutMode() === 'phone';
  const [tab, setTab] = useState<LedgerTab>('graph');
  const [selection, setSelection] = useState<LedgerSelection | null>(null);
  const [infoOpen, setInfoOpen] = useState(false);
  const view = ledger.view;
  const resolved = view === null || selection === null ? null : resolveSelection(view, selection);
  const sheetOpen = phone && (resolved !== null || infoOpen);
  const generatedMs = view === null ? null : parseLedgerTimestamp(view.generatedAt);

  // Asked again after each reconnect; the first request of a connection is also the probe.
  useEffect(() => {
    ledgerStore.requestView();
  }, [ledger.connection]);

  useEffect(() => {
    if (!sheetOpen) return undefined;
    function closeOnEscape(event: KeyboardEvent): void {
      if (event.key !== 'Escape') return;
      if (infoOpen) setInfoOpen(false);
      else setSelection(null);
    }
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [sheetOpen, infoOpen]);

  function choose(next: LedgerSelection): void {
    setSelection(next);
    setInfoOpen(false);
  }

  return (
    <section aria-label="Cây git" className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex flex-wrap items-center gap-2 px-3 py-2">
        <h2 className="flex items-center gap-1.5 text-sm text-text">
          <Icon name="git-branch" /> Cây git
        </h2>
        {view !== null && (
          <span
            className={`rounded-full bg-raised px-2 py-0.5 text-2xs ${view.database.state === 'ok' ? 'text-text-muted' : 'text-danger'}`}
          >
            {databaseLabel(view.database)}
          </span>
        )}
        {generatedMs !== null && (
          <span className="text-2xs text-text-muted">Cập nhật lúc {formatClock(generatedMs)}</span>
        )}
        <span className="flex-1" />
        <button
          type="button"
          onClick={() => ledgerStore.requestView()}
          className="company-btn company-btn-md company-btn-ghost touch-target"
        >
          <Icon name="refresh" /> Làm mới
        </button>
        {phone && view !== null && (
          <button
            type="button"
            aria-pressed={infoOpen}
            onClick={() => {
              setSelection(null);
              setInfoOpen((open) => !open);
            }}
            className="company-toggle touch-target"
          >
            Thông tin
          </button>
        )}
        <button
          type="button"
          onClick={onClose}
          aria-label="Đóng cây git"
          className="company-icon-btn touch-target"
        >
          <Icon name="close" />
        </button>
        {view !== null && view.database.state !== 'ok' && view.database.error !== undefined && (
          <p role="alert" className="w-full text-2xs text-danger">
            {view.database.error}
          </p>
        )}
      </header>

      {view === null ? (
        <p className="px-3 text-sm text-text-muted">{bodyMessage(ledger)}</p>
      ) : (
        <div className="flex min-h-0 flex-1 overflow-hidden">
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <div
              role="tablist"
              aria-label="Chế độ xem"
              className="flex flex-wrap gap-1.5 px-3 pb-2"
            >
              {TABS.map((item) => (
                <button
                  key={item}
                  type="button"
                  role="tab"
                  aria-selected={tab === item}
                  onClick={() => setTab(item)}
                  className="company-toggle touch-target"
                >
                  {TAB_LABELS[item]}
                </button>
              ))}
            </div>
            <div role="tabpanel" className="min-h-0 flex-1 overflow-auto px-3 pb-3">
              {tab === 'graph' ? (
                <LedgerTreeTab
                  view={view}
                  selection={selection}
                  onSelect={choose}
                  boardSessions={boardSessions}
                  panes={panes}
                  onOpenBoardSession={onOpenBoardSession}
                  onOpenHerdr={onOpenHerdr}
                  onOpenSleeping={onOpenSleeping}
                  phone={phone}
                />
              ) : (
                <LedgerTimelineTab ledger={ledger} selection={selection} onSelect={choose} />
              )}
            </div>
          </div>
          {!phone && (
            <aside
              aria-label="Chi tiết và bối cảnh"
              className="flex w-80 shrink-0 flex-col gap-2 overflow-y-auto p-2.5"
            >
              {resolved !== null && (
                <LedgerDetailPanel
                  ledger={ledger}
                  view={view}
                  resolved={resolved}
                  boardSessions={boardSessions}
                  onOpenBoardSession={onOpenBoardSession}
                  onClose={() => setSelection(null)}
                />
              )}
              <LedgerSidePanels view={view} />
            </aside>
          )}
        </div>
      )}

      {phone && view !== null && infoOpen && (
        <LedgerSheet label="Thông tin" onClose={() => setInfoOpen(false)}>
          <LedgerSidePanels view={view} />
        </LedgerSheet>
      )}
      {phone && view !== null && resolved !== null && (
        <LedgerSheet label="Chi tiết" onClose={() => setSelection(null)}>
          <LedgerDetailPanel
            ledger={ledger}
            view={view}
            resolved={resolved}
            boardSessions={boardSessions}
            onOpenBoardSession={onOpenBoardSession}
          />
        </LedgerSheet>
      )}
    </section>
  );
}

function bodyMessage(ledger: LedgerState): string {
  if (ledger.viewError !== null) return ledger.viewError;
  if (ledger.privileged === false) return 'Kết nối này chỉ xem được, nên không mở được cây git.';
  if (ledger.privileged === null) return 'Đang kiểm tra quyền truy cập…';
  return 'Đang tải cây git…';
}

/** A full-screen panel for phone layouts, closed by its button or Escape. */
function LedgerSheet({
  label,
  onClose,
  children,
}: {
  label: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={label}
      className="fixed inset-0 z-40 flex flex-col bg-panel"
    >
      <div className="flex justify-end px-3 pt-2">
        <button
          type="button"
          onClick={onClose}
          aria-label="Đóng"
          className="company-icon-btn touch-target"
        >
          <Icon name="close" />
        </button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-3 pb-3">{children}</div>
    </div>
  );
}

/**
 * AgentSidebar: the Project tree beside the board (Project → groups → folders →
 * the sessions working there, herdr panes included), under a one-line activity
 * count. Herdr panes no Project folder holds sit in a folded "Ngoài dự án" list
 * below, so none goes out of reach. Every action on a tree row is in its
 * right-click menu. Role models are set in the "Vai trò & model" dialog, opened
 * from the gear beside the heading. The sidebar can be resized from its right edge
 * with the pointer or with the arrow keys.
 */

import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import { useRef, useState } from 'react';

import type { HerdrRoster } from '../companyState.js';
import { COMPANY_SIDEBAR_MAX_WIDTH_PX, COMPANY_SIDEBAR_MIN_WIDTH_PX } from '../constants.js';
import { isSheetDismissSwipe, type SidebarPresentation } from '../layoutMode.js';
import { ProjectTree, type ProjectTreeProps } from '../projects/ProjectTree.js';
import { herdrOutsideProjects, type OutsideHerdrRow, sessionActivityCounts } from '../projects/projectTreeView.js';
import { clampSidebarWidth } from '../sidebarPrefs.js';
import { ActivityChips } from './ActivityCounts.js';
import { Icon } from './Icon.js';

/** Pixels one arrow-key press moves the resize edge. */
const RESIZE_STEP_PX = 16;

/** The sidebar's three shapes: beside the board, over it on a tablet, or as a phone's sheet. */
type PanelPresentation = Extract<SidebarPresentation, 'docked' | 'overlay' | 'sheet'>;

/** Classes for each shape; the docked and overlay widths come from the drag width. */
const PRESENTATION_CLASS: Record<PanelPresentation, string> = {
  docked: 'relative h-full bg-panel',
  overlay: 'absolute inset-y-0 left-0 z-30 h-full bg-panel',
  sheet:
    'fixed top-0 left-0 z-40 h-dvh w-[min(88vw,360px)] bg-raised border border-hairline pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)]',
};

export interface AgentSidebarProps {
  width: number;
  /** Where the sidebar sits: docked beside the board, floating over it, or a phone's sheet. */
  presentation: PanelPresentation;
  projectTree: ProjectTreeProps;
  /** Every pane the herdr server reports, so the ones outside all Projects stay listed. */
  herdrRoster: HerdrRoster;
  onOpenHerdr: (paneId: string) => void;
  /** Opens a hibernated session's drawer, where its wake control is. */
  onOpenSleeping: (paneId: string) => void;
  onWidthChange: (width: number) => void;
  onCollapse: () => void;
  /** Opens the "Vai trò & model" dialog from the sidebar heading. */
  onOpenRoles: () => void;
  /** Closes the sheet after a leftward swipe on it. */
  onDismiss: () => void;
}

export function AgentSidebar({
  width,
  presentation,
  onWidthChange,
  onCollapse,
  onDismiss,
  onOpenRoles,
  projectTree,
  herdrRoster,
  onOpenHerdr,
  onOpenSleeping,
}: AgentSidebarProps) {
  // A leftward swipe on the sheet dismisses it; a swipe on a docked or tablet sidebar does nothing.
  const sheetSwipe = useRef<{ pointerId: number; x: number; y: number } | null>(null);

  function onSheetPointerDown(event: ReactPointerEvent<HTMLElement>): void {
    sheetSwipe.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
  }

  function onSheetPointerUp(event: ReactPointerEvent<HTMLElement>): void {
    const start = sheetSwipe.current;
    sheetSwipe.current = null;
    if (start === null || start.pointerId !== event.pointerId) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    if (presentation === 'sheet' && isSheetDismissSwipe(dx, dy)) onDismiss();
  }

  // The heading counts the sessions the Project tree lists, each once.
  const counts = sessionActivityCounts(projectTree.nodes);
  const total = counts.total;
  const outside = herdrOutsideProjects(projectTree.nodes, herdrRoster);

  return (
    <aside
      aria-label="Đàn agent"
      data-testid="agent-sidebar"
      className={`flex shrink-0 flex-col ${PRESENTATION_CLASS[presentation]}`}
      style={presentation === 'sheet' ? undefined : { width: `${width}px` }}
      onPointerDown={onSheetPointerDown}
      onPointerUp={onSheetPointerUp}
      onPointerCancel={() => {
        sheetSwipe.current = null;
      }}
    >
      <header className="flex items-center justify-between gap-2 px-2.5 py-2">
        <h2 className="text-xs font-semibold text-text-muted">Đàn agent · {total}</h2>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={onOpenRoles}
            aria-label="Vai trò & model"
            title="Vai trò & model"
            className="company-icon-btn touch-target px-1 text-2xs"
          >
            <Icon name="settings" />
          </button>
          <button
            type="button"
            onClick={onCollapse}
            aria-label="Thu gọn đàn agent"
            title="Thu gọn thành thanh biểu tượng (Ctrl+B)"
            className="company-icon-btn touch-target px-1 text-2xs"
          >
            <Icon name="chevron-left" />
          </button>
        </div>
      </header>
      <ActivityChips counts={counts} />
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <ProjectTree {...projectTree} />
        {outside.length > 0 && (
          <OutsideProjects rows={outside} onOpenHerdr={onOpenHerdr} onOpenSleeping={onOpenSleeping} />
        )}
      </div>

      {presentation !== 'sheet' && <ResizeEdge width={width} onWidthChange={onWidthChange} />}
    </aside>
  );
}

/** Herdr panes no Project folder holds, folded by default; a click opens the pane or its wake drawer. */
function OutsideProjects({
  rows,
  onOpenHerdr,
  onOpenSleeping,
}: {
  rows: readonly OutsideHerdrRow[];
  onOpenHerdr: (paneId: string) => void;
  onOpenSleeping: (paneId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <section aria-label="Ngoài dự án" className="px-2 py-2">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        title="Phiên herdr ở thư mục chưa thuộc Project nào. Thêm thư mục đó vào một Project để nó vào cây."
        className="touch-target flex w-full items-center gap-1 rounded px-1 text-left text-2xs text-text-muted hover:bg-hover"
      >
        <span aria-hidden="true">{open ? '⌄' : '›'}</span>
        <span className="flex-1">Ngoài dự án · herdr</span>
        <span>{rows.length}</span>
      </button>
      {open && (
        <ul className="mt-1 flex flex-col">
          {rows.map((row) => (
            <li key={row.paneId}>
              <button
                type="button"
                onClick={() => (row.sleeping ? onOpenSleeping(row.paneId) : onOpenHerdr(row.paneId))}
                title={row.sleeping ? 'Mở để đánh thức' : row.paneId}
                className="touch-target w-full rounded px-2 py-1 text-left hover:bg-hover"
              >
                <span className="block truncate text-xs text-text">{row.title}</span>
                <span className="block truncate text-2xs text-text-muted">
                  {['herdr', row.where, row.sleeping ? 'ngủ đông' : row.status].filter((part) => part !== '').join(' · ')}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * The sidebar's resize edge. A pointer drag follows the cursor from where the
 * press began; the arrow keys move it in steps, so the width is reachable
 * without a mouse.
 */
function ResizeEdge({
  width,
  onWidthChange,
}: {
  width: number;
  onWidthChange: (width: number) => void;
}) {
  const [drag, setDrag] = useState<{ startX: number; startWidth: number } | null>(null);

  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const step = event.key === 'ArrowRight' ? RESIZE_STEP_PX : -RESIZE_STEP_PX;
    onWidthChange(clampSidebarWidth(width + step));
  }

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Đổi độ rộng đại lý"
      aria-valuemin={COMPANY_SIDEBAR_MIN_WIDTH_PX}
      aria-valuemax={COMPANY_SIDEBAR_MAX_WIDTH_PX}
      aria-valuenow={width}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onPointerDown={(event: ReactPointerEvent<HTMLDivElement>) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        setDrag({ startX: event.clientX, startWidth: width });
      }}
      onPointerMove={(event: ReactPointerEvent<HTMLDivElement>) => {
        if (drag === null) return;
        onWidthChange(clampSidebarWidth(drag.startWidth + event.clientX - drag.startX));
      }}
      onPointerUp={() => setDrag(null)}
      onPointerCancel={() => setDrag(null)}
      className="absolute inset-y-0 right-0 z-10 w-1.5 cursor-col-resize hover:bg-accent focus-visible:bg-accent"
    />
  );
}

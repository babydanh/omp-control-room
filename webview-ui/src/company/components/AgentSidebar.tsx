/**
 * AgentSidebar: the Project tree beside the board (Project → groups → folders →
 * the sessions working there, herdr panes included), under a one-line activity
 * count. Panes no Project folder holds are not listed: add their folder to a Project
 * to see them. Every action on a tree row is in its right-click menu. Role models are
 * set in the "Vai trò & model" dialog, opened from the gear beside the heading. The
 * sidebar can be resized from its right edge with the pointer or with the arrow keys.
 */

import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import { useRef, useState } from 'react';

import { COMPANY_SIDEBAR_MAX_WIDTH_PX, COMPANY_SIDEBAR_MIN_WIDTH_PX } from '../constants.js';
import { isSheetDismissSwipe, type SidebarPresentation } from '../layoutMode.js';
import { ProjectTree, type ProjectTreeProps } from '../projects/ProjectTree.js';
import { sessionActivityCounts } from '../projects/projectTreeView.js';
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
        <h2 className="text-sm font-semibold text-text-muted">Đàn agent · {total}</h2>
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
      </div>

      {presentation !== 'sheet' && <ResizeEdge width={width} onWidthChange={onWidthChange} />}
    </aside>
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

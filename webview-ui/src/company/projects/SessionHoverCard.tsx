/**
 * SessionHoverCard: what a session row hides, shown beside it while the pointer rests on it. The
 * session's first request and the user's newest message, the task in hand, the todo progress,
 * what blocks it, the code it changed, and one verdict line.
 */

import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';

import type { ProjectTreeNode } from '../../../../core/src/messages.js';
import { sessionVerdict } from './sessionHover.js';

const CARD_WIDTH_PX = 320;
const GAP_PX = 8;
/** Room kept below the card's top so a row near the bottom does not push it off screen. */
const CARD_ROOM_PX = 260;

export interface SessionHoverCardProps {
  readonly node: ProjectTreeNode;
  /** The row's box: the card opens to its right. */
  readonly anchor: DOMRect;
  /** The branch it works on; main is left out by the caller. */
  readonly where?: string;
  /** The checkout row it sits under, for its changed lines. */
  readonly checkout?: ProjectTreeNode;
  readonly stateLabel?: string;
  readonly running: boolean;
}

export function SessionHoverCard({ node, anchor, where, checkout, stateLabel, running }: SessionHoverCardProps) {
  const progress = node.progress;
  const left = Math.min(anchor.right + GAP_PX, window.innerWidth - CARD_WIDTH_PX - GAP_PX);
  const top = Math.max(GAP_PX, Math.min(anchor.top, window.innerHeight - CARD_ROOM_PX));
  const added = checkout?.additions ?? 0;
  const removed = checkout?.deletions ?? 0;
  const header = [node.agentKind === 'herdr' ? undefined : node.agentKind, stateLabel, where].filter(Boolean).join(' · ');
  // The portal leaves the board's DOM: the company-ui scope brings its text sizes and colours along.
  return createPortal(
    <div
      role="tooltip"
      className="company-ui pointer-events-none fixed z-50 flex flex-col gap-1.5 rounded-(--company-radius-md) border border-hairline bg-raised p-2.5 text-xs text-text-secondary shadow-lg"
      style={{ left, top, width: CARD_WIDTH_PX }}
    >
      {header !== '' && <p className="text-2xs text-text-muted">{header}</p>}
      {node.request !== undefined && <Line icon="🎯" className="text-text">{node.request}</Line>}
      {node.lastRequest !== undefined && <Line icon="💬">Mới nhất: {node.lastRequest}</Line>}
      {progress?.current !== undefined && <Line icon="▶">{progress.current}</Line>}
      {progress !== undefined && (
        <span className="flex items-center gap-2">
          <span aria-hidden="true" className="h-1 flex-1 overflow-hidden rounded-full bg-well">
            <span className="block h-full rounded-full bg-status-success" style={{ width: `${Math.round((progress.done / progress.total) * 100)}%` }} />
          </span>
          <span className="shrink-0 text-2xs">{progress.done}/{progress.total}</span>
        </span>
      )}
      {progress?.blocked !== undefined && <Line icon="⚠" className="text-status-error">Kẹt: {progress.blocked}</Line>}
      {checkout !== undefined && (checkout.dirty === true || added > 0 || removed > 0) && (
        <Line icon="⎇">
          <span className="text-status-success">+{added}</span> <span className="text-status-error">−{removed}</span>
          {checkout.dirty === true && ' · chưa commit'}
        </Line>
      )}
      <p className="border-t border-hairline pt-1.5 text-text">{sessionVerdict(progress, running)}</p>
    </div>,
    document.body,
  );
}

/** One fact, cut to two lines: the card stays a glance, the row's drawer has the rest. */
function Line({ icon, className = '', children }: { icon: string; className?: string; children: ReactNode }) {
  return (
    <p className={`flex gap-1.5 ${className}`}>
      <span aria-hidden="true" className="shrink-0">{icon}</span>
      <span className="line-clamp-2 min-w-0 flex-1 break-words">{children}</span>
    </p>
  );
}

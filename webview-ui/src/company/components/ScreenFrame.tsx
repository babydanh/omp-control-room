/**
 * ScreenFrame: the box a terminal screen is painted into. The newest rows stay in
 * view, so the frame clips the top. Wrapped rows grow past the frame's edges and are
 * clipped there; unwrapped rows keep their columns and scroll sideways inside the
 * frame instead, so nothing else on the page scrolls.
 */

import type { ReactNode } from 'react';
import { useContext, useRef } from 'react';

import { useStickToBottom } from '../useStickToBottom.js';
import { WrapLinesContext } from '../wrapLines.js';

export function ScreenFrame({ children }: { children: ReactNode }) {
  const wrap = useContext(WrapLinesContext);
  const clip = wrap ? 'overflow-hidden' : 'overflow-x-auto overflow-y-hidden';
  return (
    <div
      className={`flex min-h-0 min-w-0 flex-1 flex-col justify-end rounded-(--company-radius-md) bg-well p-3 ${clip}`}
    >
      {children}
    </div>
  );
}

/** Shown while a held or selected screen is frozen: the newest text lands once the reader lets go. */
export function ScreenFreezeChip() {
  return (
    <p
      role="status"
      className="self-start rounded-full bg-raised px-2 py-0.5 text-2xs text-warning"
    >
      Đang chọn chữ — tạm dừng cập nhật
    </p>
  );
}

/**
 * PinnedScreenFrame: a screen frame that scrolls. It opens on its newest line and stays
 * there until the reader scrolls up. A screen shorter than the frame sits at the bottom.
 */
export function PinnedScreenFrame({ children }: { children: ReactNode }) {
  const scroller = useRef<HTMLDivElement>(null);
  const onScroll = useStickToBottom(scroller);
  return (
    <div
      ref={scroller}
      onScroll={onScroll}
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-auto overscroll-contain rounded-(--company-radius-md) bg-well p-3"
    >
      <div className="mt-auto flex min-w-0 flex-col">{children}</div>
    </div>
  );
}

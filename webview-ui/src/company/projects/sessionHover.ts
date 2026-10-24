/**
 * sessionHover: when a session row's hover card opens, and the one-line verdict it ends with.
 * The verdict reads the agent's own todo list and whether it runs, not a check of the work.
 */

import { type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from 'react';

import type { ProjectTreeNode } from '../../../../core/src/messages.js';

const OPEN_DELAY_MS = 350;

/** Pointer handlers for the row, and the row's box once the pointer has rested on it. */
export function useSessionHover(enabled: boolean): {
  readonly bind: { onPointerEnter: (event: ReactPointerEvent<HTMLElement>) => void; onPointerLeave: () => void };
  readonly anchor: DOMRect | null;
} {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const timer = useRef<number | null>(null);
  useEffect(() => () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
  }, []);
  const stop = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  };
  return {
    anchor: enabled ? anchor : null,
    bind: {
      onPointerEnter: (event) => {
        if (!enabled || event.pointerType === 'touch') return;
        const target = event.currentTarget;
        stop();
        timer.current = window.setTimeout(() => setAnchor(target.getBoundingClientRect()), OPEN_DELAY_MS);
      },
      onPointerLeave: () => {
        stop();
        setAnchor(null);
      },
    },
  };
}

/** One line on where the session stands, from its own todo list and whether it is running. */
export function sessionVerdict(progress: ProjectTreeNode['progress'], running: boolean): string {
  if (progress === undefined) return running ? '⏳ Đang làm (không có todo)' : '· Không có todo';
  const left = progress.total - progress.done;
  if (left === 0) return '✓ Xong hết todo';
  if (progress.blocked !== undefined) return `⚠ Chưa xong: còn ${left} việc, đang kẹt`;
  return running ? `⏳ Đang làm: còn ${left} việc` : `· Dừng giữa chừng: còn ${left} việc`;
}

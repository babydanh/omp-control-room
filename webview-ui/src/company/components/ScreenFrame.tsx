/**
 * ScreenFrame: the box a terminal screen is painted into. The newest rows stay in
 * view, so the frame clips the top. Wrapped rows grow past the frame's edges and are
 * clipped there; unwrapped rows keep their columns and scroll sideways inside the
 * frame instead, so nothing else on the page scrolls.
 */

import type { ReactNode } from 'react';
import { useContext } from 'react';

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

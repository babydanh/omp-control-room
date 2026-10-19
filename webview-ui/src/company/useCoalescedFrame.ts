/**
 * useCoalescedFrame: the value a view paints. While `frozen` it holds what it showed; otherwise a
 * newer value lands on the next animation frame, so several updates within one frame paint once.
 */

import { useEffect, useState } from 'react';

export function useCoalescedFrame<T>(latest: T, frozen: boolean): T {
  const [shown, setShown] = useState(latest);

  useEffect(() => {
    if (frozen || Object.is(shown, latest)) return undefined;
    const frame = window.requestAnimationFrame(() => setShown(() => latest));
    return () => window.cancelAnimationFrame(frame);
  }, [frozen, latest, shown]);

  return shown;
}

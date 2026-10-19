/**
 * useNowMs: the current time, re-read on an interval, so the countdowns on the usage page tick
 * while it is open. Each countdown reads its own clock; nothing else re-renders on the tick.
 */

import { useEffect, useState } from 'react';

export function useNowMs(intervalMs: number): number {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return nowMs;
}

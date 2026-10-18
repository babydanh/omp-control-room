import { useEffect, useState } from 'react';

/** How often relative times such as "2 phút trước" are re-read; they change by the minute. */
const NOW_REFRESH_MS = 30_000;

/**
 * The current time in epoch milliseconds, refreshed on a slow timer while the
 * component is mounted, so relative times stay true while the board is open.
 */
export function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), NOW_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

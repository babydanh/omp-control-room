/**
 * useUsageRefresh: when the usage page asks the server for its three reports.
 *
 * The page asks once when it opens, asks again when a refresh falls due while it is visible,
 * and asks with force when the reader presses Làm mới. Nothing polls: a due check compares
 * timestamps, and a request is a message the server answers from its cache or by reading OMP.
 * A report already in flight is not asked for again.
 */

import { useEffect, useRef, useState } from 'react';

import type { CompanyClient } from './companyClient.js';
import {
  isRefreshDue,
  nextRefreshDueAt,
  USAGE_LIMITS_REFRESH_MS,
  USAGE_STATS_REFRESH_MS,
} from './usage/usageRefresh.js';
import type { UsageHistoryDays } from './usage/usageState.js';

/** The history window the page opens on. */
const DEFAULT_DAYS: UsageHistoryDays = 7;
/** How often the due checks run; each one only compares timestamps. */
const DUE_CHECK_MS = 1_000;

/** When each report was last requested, in epoch ms; null until its first request. */
interface RequestTimes {
  limits: number | null;
  stats: number | null;
  history: Record<UsageHistoryDays, number | null>;
}

export interface UsageRefresh {
  days: UsageHistoryDays;
  /** Shows another history window, requesting it unless it is already in flight. */
  selectDays(days: UsageHistoryDays): void;
  /** Requests all three reports with force: the reader's Làm mới. */
  refreshAll(): void;
  /** When the next automatic request falls due, in epoch ms; now when a report was never asked for. */
  nextDueAt(): number;
}

// Each send records the request time even when the report is in flight, so the next
// due check measures from the last attempt rather than firing again straight away.
function sendLimits(client: CompanyClient, times: RequestTimes, force: boolean): void {
  times.limits = Date.now();
  if (client.getState().usageSlots.limits.loading) return;
  client.requestUsageLimits(force);
}

function sendStats(client: CompanyClient, times: RequestTimes, force: boolean): void {
  times.stats = Date.now();
  if (client.getState().usageSlots.stats.loading) return;
  client.requestUsageStats(force);
}

function sendHistory(
  client: CompanyClient,
  times: RequestTimes,
  days: UsageHistoryDays,
  force: boolean,
): void {
  times.history[days] = Date.now();
  if (client.getState().usageSlots.history[days].loading) return;
  client.requestUsageHistory(days, force);
}

export function useUsageRefresh(client: CompanyClient): UsageRefresh {
  const [days, setDays] = useState<UsageHistoryDays>(DEFAULT_DAYS);
  const daysRef = useRef<UsageHistoryDays>(DEFAULT_DAYS);
  const timesRef = useRef<RequestTimes>({
    limits: null,
    stats: null,
    history: { 1: null, 7: null, 30: null },
  });

  // Opening the page and returning to it both start here. A hidden page sends nothing; the
  // visibility change below runs the same check when the page comes back into view.
  useEffect(() => {
    const times = timesRef.current;
    const dueCheck = (): void => {
      const now = Date.now();
      const visible = document.visibilityState === 'visible';
      if (isRefreshDue(times.limits, USAGE_LIMITS_REFRESH_MS, now, visible)) {
        sendLimits(client, times, false);
      }
      if (isRefreshDue(times.stats, USAGE_STATS_REFRESH_MS, now, visible)) {
        sendStats(client, times, false);
      }
      const shown = daysRef.current;
      if (isRefreshDue(times.history[shown], USAGE_STATS_REFRESH_MS, now, visible)) {
        sendHistory(client, times, shown, false);
      }
    };
    dueCheck();
    const timer = window.setInterval(dueCheck, DUE_CHECK_MS);
    document.addEventListener('visibilitychange', dueCheck);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', dueCheck);
    };
  }, [client]);

  function selectDays(next: UsageHistoryDays): void {
    daysRef.current = next;
    setDays(next);
    sendHistory(client, timesRef.current, next, false);
  }

  function refreshAll(): void {
    const times = timesRef.current;
    sendLimits(client, times, true);
    sendStats(client, times, true);
    sendHistory(client, times, daysRef.current, true);
  }

  /** When the next automatic request falls due: the soonest of the three report schedules. */
  function nextDueAt(): number {
    const now = Date.now();
    const times = timesRef.current;
    return Math.min(
      nextRefreshDueAt(times.limits, USAGE_LIMITS_REFRESH_MS, now),
      nextRefreshDueAt(times.stats, USAGE_STATS_REFRESH_MS, now),
      nextRefreshDueAt(times.history[daysRef.current], USAGE_STATS_REFRESH_MS, now),
    );
  }

  return { days, selectDays, refreshAll, nextDueAt };
}

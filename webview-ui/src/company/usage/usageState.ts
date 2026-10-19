/**
 * usageState: the usage page's data slots, and how replies and failures settle them.
 *
 * Each slot keeps the last good answer for one request kind. A request marks its slot loading under
 * the requestId it minted. The reply under that id clears the loading flag. A failed request keeps
 * the slot's data, so a refresh that fails never blanks the page.
 */

import type {
  UsageHistoryMessage,
  UsageLimitsMessage,
  UsageStatsMessage,
} from '../../../../core/src/messages.js';

export type UsageHistoryDays = 1 | 7 | 30;

export interface UsageSlot<T> {
  data: T | null;
  /** The requestId of the request in flight, or null when none is. */
  requestId: string | null;
  loading: boolean;
  errorMessage: string | null;
}

export interface UsageState {
  limits: UsageSlot<UsageLimitsMessage>;
  history: Record<UsageHistoryDays, UsageSlot<UsageHistoryMessage>>;
  stats: UsageSlot<UsageStatsMessage>;
}

/** The history windows the page offers, in the order it shows them. */
export const USAGE_HISTORY_DAYS: readonly UsageHistoryDays[] = [1, 7, 30];

/** Shown when a refused request carries neither a message nor an error code. */
export const USAGE_FAILED_NOTICE = 'Không tải được dữ liệu sử dụng.';

/** The fields of a command outcome this module reads. A command handle carries them. */
export interface UsageOutcome {
  requestId: string;
  ok: boolean;
  errorCode?: string;
  message?: string;
}

function emptyUsageSlot<T>(): UsageSlot<T> {
  return { data: null, requestId: null, loading: false, errorMessage: null };
}

export function emptyUsageState(): UsageState {
  return {
    limits: emptyUsageSlot(),
    history: { 1: emptyUsageSlot(), 7: emptyUsageSlot(), 30: emptyUsageSlot() },
    stats: emptyUsageSlot(),
  };
}

/** The slot waits on a request minted under `requestId`. Its data is kept until a reply lands. */
export function usageSlotStarted<T>(slot: UsageSlot<T>, requestId: string): UsageSlot<T> {
  return { ...slot, requestId, loading: true, errorMessage: null };
}

/** The request under `requestId` failed: the slot stops loading, shows the message, and keeps its data. A slot waiting on another request is returned unchanged. */
export function usageSlotFailed<T>(
  slot: UsageSlot<T>,
  requestId: string,
  message: string,
): UsageSlot<T> {
  if (slot.requestId !== requestId) return slot;
  return { ...slot, requestId: null, loading: false, errorMessage: message };
}

/** A request's send went out, or was refused. A refused send fails its slot at once, since no reply is coming. */
export function usageSlotSent<T>(slot: UsageSlot<T>, outcome: UsageOutcome): UsageSlot<T> {
  const started = usageSlotStarted(slot, outcome.requestId);
  if (outcome.ok) return started;
  const message = outcome.message ?? outcome.errorCode ?? USAGE_FAILED_NOTICE;
  return usageSlotFailed(started, outcome.requestId, message);
}

/** Whether a reply's generation time is at or after the held data's. An unreadable time never beats held data. */
function isNewerThan(generatedAt: string, held: string | undefined): boolean {
  if (held === undefined) return true;
  const incoming = Date.parse(generatedAt);
  const heldAt = Date.parse(held);
  if (!Number.isFinite(incoming)) return false;
  return !Number.isFinite(heldAt) || incoming >= heldAt;
}

/**
 * Settles one slot with a reply. A reply to the slot's open request always lands and clears the
 * loading flag. A reply to no open request lands only when it is the newest data the slot holds.
 */
function settleSlot<T extends { requestId: string; generatedAt: string }>(
  slot: UsageSlot<T>,
  reply: T,
): UsageSlot<T> {
  if (slot.requestId === reply.requestId) {
    return { data: reply, requestId: null, loading: false, errorMessage: null };
  }
  if (!isNewerThan(reply.generatedAt, slot.data?.generatedAt)) return slot;
  return { ...slot, data: reply, errorMessage: null };
}

function isUsageHistoryDays(value: number): value is UsageHistoryDays {
  return value === 1 || value === 7 || value === 30;
}

/** The history slot a reply settles: the one waiting on its requestId, else the window it names. */
function historyDaysFor(
  history: UsageState['history'],
  reply: UsageHistoryMessage,
): UsageHistoryDays | null {
  const open = USAGE_HISTORY_DAYS.find((days) => history[days].requestId === reply.requestId);
  if (open !== undefined) return open;
  return isUsageHistoryDays(reply.days) ? reply.days : null;
}

/** Settles the slot a usage reply belongs to. A history reply for a window the page does not offer is dropped. */
export function reduceUsageMessage(
  state: UsageState,
  message: UsageLimitsMessage | UsageHistoryMessage | UsageStatsMessage,
): UsageState {
  switch (message.type) {
    case 'usageLimits':
      return { ...state, limits: settleSlot(state.limits, message) };
    case 'usageStats':
      return { ...state, stats: settleSlot(state.stats, message) };
    case 'usageHistory': {
      const days = historyDaysFor(state.history, message);
      if (days === null) return state;
      return {
        ...state,
        history: { ...state.history, [days]: settleSlot(state.history[days], message) },
      };
    }
  }
}

/**
 * A refused command under a usage request's requestId fails that request's slot. Any other outcome,
 * including a refusal for a request the page does not hold open, returns the state unchanged.
 */
export function usageCommandFailed(state: UsageState, outcome: UsageOutcome): UsageState {
  if (outcome.ok) return state;
  const open =
    state.limits.requestId === outcome.requestId ||
    state.stats.requestId === outcome.requestId ||
    USAGE_HISTORY_DAYS.some((days) => state.history[days].requestId === outcome.requestId);
  if (!open) return state;
  const message = outcome.message ?? outcome.errorCode ?? USAGE_FAILED_NOTICE;
  // Slots that did not match keep their references, so the untouched parts of the state stay identical.
  const history = USAGE_HISTORY_DAYS.reduce<UsageState['history']>((acc, days) => {
    const slot = usageSlotFailed(acc[days], outcome.requestId, message);
    return slot === acc[days] ? acc : { ...acc, [days]: slot };
  }, state.history);
  return {
    limits: usageSlotFailed(state.limits, outcome.requestId, message),
    history,
    stats: usageSlotFailed(state.stats, outcome.requestId, message),
  };
}

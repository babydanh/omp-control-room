import { describe, expect, it } from 'vitest';

import type {
  QuotaSnapshot,
  UsageHistoryMessage,
  UsageLimitsMessage,
  UsageStatsMessage,
  UsageStatsTotals,
} from '../../core/src/messages.js';
import {
  isCompanyServerMessage,
  usageHistoryRequest,
  usageLimitsRequest,
  usageStatsRequest,
} from '../src/company/companyMessages.js';
import { applyCompanyMessage, emptyCompanyState } from '../src/company/companyState.js';
import {
  emptyUsageState,
  reduceUsageMessage,
  USAGE_FAILED_NOTICE,
  USAGE_HISTORY_DAYS,
  usageCommandFailed,
  usageSlotFailed,
  usageSlotSent,
  usageSlotStarted,
  type UsageState,
} from '../src/company/usage/usageState.js';

const T0 = '2026-10-19T00:00:00.000Z';
const T1 = '2026-10-19T00:05:00.000Z';

const ZERO_TOTALS: UsageStatsTotals = {
  totalRequests: 0,
  successfulRequests: 0,
  failedRequests: 0,
  errorRate: 0,
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalCacheReadTokens: 0,
  totalCacheWriteTokens: 0,
  cacheRate: 0,
  cacheSavings: 0,
  totalCost: 0,
  unpricedRequests: 0,
  totalPremiumRequests: 0,
  avgDuration: 0,
  avgTtft: 0,
  avgTokensPerSecond: 0,
};

function limitsReply(
  requestId: string,
  generatedAt: string,
  snapshots: QuotaSnapshot[] = [],
): UsageLimitsMessage {
  return {
    type: 'usageLimits',
    requestId,
    generatedAt,
    status: 'available',
    cached: false,
    snapshots,
    capacity: [],
  };
}

function historyReply(requestId: string, days: number, generatedAt: string): UsageHistoryMessage {
  return {
    type: 'usageHistory',
    requestId,
    generatedAt,
    sinceAt: T0,
    days,
    entries: [],
    clients: [],
  };
}

function statsReply(requestId: string, generatedAt: string): UsageStatsMessage {
  return {
    type: 'usageStats',
    requestId,
    generatedAt,
    overall: ZERO_TOTALS,
    byModel: [],
    byFolder: [],
    byAgentType: [],
    timeSeries: [],
    modelPerformanceSeries: [],
    costSeries: [],
  };
}

describe('usage request builders', () => {
  it('omits the force flag unless a refresh is forced', () => {
    expect(Object.keys(usageLimitsRequest('r1'))).toEqual(['type', 'requestId']);
    expect(usageLimitsRequest('r1')).toEqual({ type: 'usageLimitsRequest', requestId: 'r1' });
  });

  it('sends force when a refresh is forced', () => {
    expect(usageLimitsRequest('r1', true)).toEqual({
      type: 'usageLimitsRequest',
      requestId: 'r1',
      force: true,
    });
  });

  it('sends the history window with the request', () => {
    expect(usageHistoryRequest('r2', 7)).toEqual({
      type: 'usageHistoryRequest',
      requestId: 'r2',
      days: 7,
    });
    expect(usageHistoryRequest('r2', 30, true)).toEqual({
      type: 'usageHistoryRequest',
      requestId: 'r2',
      days: 30,
      force: true,
    });
  });

  it('builds a stats request and forces it on demand', () => {
    expect(usageStatsRequest('r3')).toEqual({ type: 'usageStatsRequest', requestId: 'r3' });
    expect(usageStatsRequest('r3', true)).toEqual({
      type: 'usageStatsRequest',
      requestId: 'r3',
      force: true,
    });
  });

  it('accepts the three usage replies as server messages', () => {
    expect(isCompanyServerMessage({ type: 'usageLimits' })).toBe(true);
    expect(isCompanyServerMessage({ type: 'usageHistory' })).toBe(true);
    expect(isCompanyServerMessage({ type: 'usageStats' })).toBe(true);
    expect(isCompanyServerMessage({ type: 'usageUnknown' })).toBe(false);
  });
});

describe('usage slots', () => {
  it('starts with every slot empty and no request in flight', () => {
    const state = emptyUsageState();
    expect(state.limits).toEqual({
      data: null,
      requestId: null,
      loading: false,
      errorMessage: null,
    });
    expect(state.stats).toEqual({
      data: null,
      requestId: null,
      loading: false,
      errorMessage: null,
    });
    expect(Object.keys(state.history)).toEqual(['1', '7', '30']);
    expect(USAGE_HISTORY_DAYS).toEqual([1, 7, 30]);
  });

  it('marks a slot loading under the request id and keeps its data', () => {
    const reply = limitsReply('r0', T0);
    const slot = { ...emptyUsageState().limits, data: reply, errorMessage: 'cũ' };
    expect(usageSlotStarted(slot, 'r1')).toEqual({
      data: reply,
      requestId: 'r1',
      loading: true,
      errorMessage: null,
    });
  });

  it('fails the slot only for its open request, keeping the data it holds', () => {
    const reply = limitsReply('r0', T0);
    const slot = usageSlotStarted({ ...emptyUsageState().limits, data: reply }, 'r1');
    expect(usageSlotFailed(slot, 'r9', 'Lỗi')).toBe(slot);
    expect(usageSlotFailed(slot, 'r1', 'Lỗi')).toEqual({
      data: reply,
      requestId: null,
      loading: false,
      errorMessage: 'Lỗi',
    });
  });

  it('keeps a sent request loading when the send went out', () => {
    const slot = usageSlotSent(emptyUsageState().stats, { requestId: 'r1', ok: true });
    expect(slot.requestId).toBe('r1');
    expect(slot.loading).toBe(true);
    expect(slot.errorMessage).toBeNull();
  });

  it('fails a refused send at once with the message it carries', () => {
    const slot = usageSlotSent(emptyUsageState().stats, {
      requestId: 'r1',
      ok: false,
      message: 'Mất kết nối',
    });
    expect(slot).toEqual({
      data: null,
      requestId: null,
      loading: false,
      errorMessage: 'Mất kết nối',
    });
  });

  it('falls back to the error code, then to the page notice, for a refused send', () => {
    const byCode = usageSlotSent(emptyUsageState().stats, {
      requestId: 'r1',
      ok: false,
      errorCode: 'usage_unavailable',
    });
    expect(byCode.errorMessage).toBe('usage_unavailable');

    const bare = usageSlotSent(emptyUsageState().stats, { requestId: 'r1', ok: false });
    expect(bare.errorMessage).toBe(USAGE_FAILED_NOTICE);
  });

  it('uses a Vietnamese notice when nothing else explains the failure', () => {
    expect(USAGE_FAILED_NOTICE).toBe('Không tải được dữ liệu sử dụng.');
  });
});

describe('reduceUsageMessage', () => {
  it('stores the reply under the open request and clears its loading flag', () => {
    const state = {
      ...emptyUsageState(),
      limits: usageSlotStarted(emptyUsageState().limits, 'r1'),
    };
    const reply = limitsReply('r1', T0);
    const next = reduceUsageMessage(state, reply);
    expect(next.limits).toEqual({
      data: reply,
      requestId: null,
      loading: false,
      errorMessage: null,
    });
  });

  it('stores a reply that matches no open request when it is the newest data', () => {
    const held = limitsReply('old', T0);
    const state = { ...emptyUsageState(), limits: { ...emptyUsageState().limits, data: held } };
    const newer = limitsReply('new', T1);
    expect(reduceUsageMessage(state, newer).limits.data).toBe(newer);
  });

  it('drops a reply that matches no open request when it is older than the data held', () => {
    const held = limitsReply('new', T1);
    const state = { ...emptyUsageState(), limits: { ...emptyUsageState().limits, data: held } };
    const next = reduceUsageMessage(state, limitsReply('old', T0));
    expect(next.limits).toBe(state.limits);
  });

  it('drops a reply with an unreadable time when newer data is already held', () => {
    const held = limitsReply('held', T0);
    const state = { ...emptyUsageState(), limits: { ...emptyUsageState().limits, data: held } };
    const next = reduceUsageMessage(state, limitsReply('odd', 'không phải ngày'));
    expect(next.limits).toBe(state.limits);
  });

  it('routes a history reply to the window its request opened', () => {
    const state = {
      ...emptyUsageState(),
      history: {
        ...emptyUsageState().history,
        7: usageSlotStarted(emptyUsageState().history[7], 'r7'),
      },
    };
    const reply = historyReply('r7', 7, T0);
    const next = reduceUsageMessage(state, reply);
    expect(next.history[7]).toEqual({
      data: reply,
      requestId: null,
      loading: false,
      errorMessage: null,
    });
    expect(next.history[1]).toBe(state.history[1]);
    expect(next.history[30]).toBe(state.history[30]);
  });

  it('routes an unmatched history reply by the window it names', () => {
    const state = emptyUsageState();
    const reply = historyReply('elsewhere', 30, T0);
    expect(reduceUsageMessage(state, reply).history[30].data).toBe(reply);
  });

  it('ignores a history reply for a window the page does not offer', () => {
    const state = emptyUsageState();
    expect(reduceUsageMessage(state, historyReply('x', 3, T0))).toBe(state);
  });

  it('stores a stats reply under the open request', () => {
    const state = {
      ...emptyUsageState(),
      stats: usageSlotStarted(emptyUsageState().stats, 'r3'),
    };
    const reply = statsReply('r3', T0);
    expect(reduceUsageMessage(state, reply).stats.data).toBe(reply);
    expect(reduceUsageMessage(state, reply).stats.loading).toBe(false);
  });
});

describe('usageCommandFailed', () => {
  function withOpenRequests(): UsageState {
    const empty = emptyUsageState();
    return {
      limits: usageSlotStarted(empty.limits, 'rl'),
      history: { ...empty.history, 7: usageSlotStarted(empty.history[7], 'rh') },
      stats: empty.stats,
    };
  }

  it('returns the state unchanged for a successful outcome', () => {
    const state = withOpenRequests();
    expect(usageCommandFailed(state, { requestId: 'rl', ok: true })).toBe(state);
  });

  it('returns the state unchanged for a refusal of a request the page does not hold open', () => {
    const state = withOpenRequests();
    expect(usageCommandFailed(state, { requestId: 'other', ok: false, message: 'x' })).toBe(state);
  });

  it('fails the open limits request and leaves the other slots as they were', () => {
    const state = withOpenRequests();
    const next = usageCommandFailed(state, {
      requestId: 'rl',
      ok: false,
      errorCode: 'usage_read_failed',
      message: 'Đọc thất bại',
    });
    expect(next.limits.errorMessage).toBe('Đọc thất bại');
    expect(next.limits.loading).toBe(false);
    expect(next.history).toBe(state.history);
    expect(next.stats).toBe(state.stats);
  });

  it('fails the open history request under its own window', () => {
    const state = withOpenRequests();
    const next = usageCommandFailed(state, { requestId: 'rh', ok: false });
    expect(next.history[7].errorMessage).toBe(USAGE_FAILED_NOTICE);
    expect(next.history[7].loading).toBe(false);
    expect(next.limits).toBe(state.limits);
  });
});

describe('usage routing through the company reducer', () => {
  function stateWithLimitsOpen(requestId: string) {
    const base = emptyCompanyState();
    return {
      ...base,
      usageSlots: {
        ...base.usageSlots,
        limits: usageSlotStarted(base.usageSlots.limits, requestId),
      },
    };
  }

  it('stores a usage reply in the usage slots', () => {
    const state = stateWithLimitsOpen('r1');
    const reply = limitsReply('r1', T0);
    const result = applyCompanyMessage(state, reply);
    expect(result.state.usageSlots.limits.data).toBe(reply);
    expect(result.state.usageSlots.limits.loading).toBe(false);
  });

  it('fails the usage slot when its request is refused, and still records the command result', () => {
    const state = stateWithLimitsOpen('r1');
    const result = applyCompanyMessage(state, {
      type: 'companyCommandResult',
      requestId: 'r1',
      ok: false,
      errorCode: 'usage_read_failed',
      message: 'Đọc thất bại',
    });
    expect(result.state.usageSlots.limits.errorMessage).toBe('Đọc thất bại');
    expect(result.state.usageSlots.limits.loading).toBe(false);
    expect(result.state.commandResults.r1).toMatchObject({ requestId: 'r1', ok: false });
  });

  it('leaves the usage slots untouched for an unrelated command result', () => {
    const state = stateWithLimitsOpen('r1');
    const result = applyCompanyMessage(state, {
      type: 'companyCommandResult',
      requestId: 'unrelated',
      ok: false,
      message: 'x',
    });
    expect(result.state.usageSlots).toBe(state.usageSlots);
  });
});

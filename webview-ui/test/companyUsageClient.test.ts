import { describe, expect, it } from 'vitest';

import { TRANSPORT_DISCONNECTED_ERROR } from '../../core/src/messageDelivery.js';
import type { ClientMessage, UsageLimitsMessage } from '../../core/src/messages.js';
import { CompanyClient } from '../src/company/companyClient.js';
import { USAGE_FAILED_NOTICE } from '../src/company/usage/usageState.js';
import type { MessageTransport } from '../src/transport/types.js';

const T0 = '2026-10-19T00:00:00.000Z';

interface FakeTransport {
  transport: MessageTransport;
  sent: ClientMessage[];
  setConnected(connected: boolean): void;
}

function fakeTransport(): FakeTransport {
  const sent: ClientMessage[] = [];
  let connected = true;
  return {
    sent,
    setConnected(value: boolean) {
      connected = value;
    },
    transport: {
      send(message: ClientMessage) {
        if (!connected) throw new Error(TRANSPORT_DISCONNECTED_ERROR);
        sent.push(message);
      },
      onMessage: () => () => {},
      ready: Promise.resolve(),
      state: 'connected',
      onStateChange: () => () => {},
      dispose: () => {},
    } as MessageTransport,
  };
}

describe('usage requests on the company client', () => {
  it('sends a limits request and shows its slot loading under the request id', () => {
    const fake = fakeTransport();
    const client = new CompanyClient(fake.transport);
    const handle = client.requestUsageLimits();

    expect(handle.ok).toBe(true);
    expect(fake.sent).toEqual([{ type: 'usageLimitsRequest', requestId: handle.requestId }]);
    expect(client.getState().usageSlots.limits).toEqual({
      data: null,
      requestId: handle.requestId,
      loading: true,
      errorMessage: null,
    });
  });

  it('settles the limits slot with the reply under the same request id', () => {
    const fake = fakeTransport();
    const client = new CompanyClient(fake.transport);
    const handle = client.requestUsageLimits();
    const reply: UsageLimitsMessage = {
      type: 'usageLimits',
      requestId: handle.requestId,
      generatedAt: T0,
      status: 'available',
      cached: false,
      snapshots: [],
      capacity: [],
    };

    client.accept(reply);

    const slot = client.getState().usageSlots.limits;
    expect(slot.data).toBe(reply);
    expect(slot.loading).toBe(false);
    expect(slot.requestId).toBeNull();
  });

  it('sends force only when a refresh is forced', () => {
    const fake = fakeTransport();
    const client = new CompanyClient(fake.transport);
    const handle = client.requestUsageStats(true);

    expect(fake.sent).toEqual([
      { type: 'usageStatsRequest', requestId: handle.requestId, force: true },
    ]);
  });

  it('loads only the history window it asked for', () => {
    const fake = fakeTransport();
    const client = new CompanyClient(fake.transport);
    const handle = client.requestUsageHistory(7);

    expect(fake.sent).toEqual([
      { type: 'usageHistoryRequest', requestId: handle.requestId, days: 7 },
    ]);
    const { history } = client.getState().usageSlots;
    expect(history[7].requestId).toBe(handle.requestId);
    expect(history[7].loading).toBe(true);
    expect(history[1].loading).toBe(false);
    expect(history[30].requestId).toBeNull();
  });

  it('fails the slot at once when the send is refused, with the handle message', () => {
    const fake = fakeTransport();
    const client = new CompanyClient(fake.transport);
    fake.setConnected(false);
    const handle = client.requestUsageStats();

    expect(handle.ok).toBe(false);
    expect(fake.sent).toEqual([]);
    const slot = client.getState().usageSlots.stats;
    expect(slot.loading).toBe(false);
    expect(slot.requestId).toBeNull();
    expect(slot.errorMessage).toBe(handle.message ?? handle.errorCode ?? USAGE_FAILED_NOTICE);
  });
});

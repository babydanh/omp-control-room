import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TRANSPORT_DISCONNECTED_ERROR } from '../../core/src/messageDelivery.js';
import type { ClientMessage, LedgerTimelineMessage } from '../../core/src/messages.js';
import {
  applyLedgerFixture,
  ledgerFixtureTimeline,
  ledgerFixtureView,
} from '../src/company/ledger/ledgerFixture.js';
import {
  createLedgerStore,
  LEDGER_LOST_REASON,
  LEDGER_NO_CONNECTION_REASON,
} from '../src/company/ledger/ledgerStore.js';

/** A store whose transport records what it sends; request ids are r1, r2, ... */
function harness(options: { throwOnSend?: Error } = {}) {
  const sent: ClientMessage[] = [];
  let counter = 0;
  const store = createLedgerStore({
    send: (message) => {
      if (options.throwOnSend !== undefined) throw options.throwOnSend;
      sent.push(message);
    },
    newRequestId: () => {
      counter += 1;
      return `r${counter}`;
    },
  });
  return { store, sent };
}

describe('ledger store: connection and privilege', () => {
  it('sends the first view request as the probe and stays unknown until it is answered', () => {
    const { store, sent } = harness();
    store.connect();
    expect(sent).toEqual([{ type: 'ledgerViewRequest', requestId: 'r1' }]);
    expect(store.getSnapshot()).toMatchObject({
      privileged: null,
      connection: 1,
      probeRequestId: 'r1',
    });
  });

  it('treats a snapshot that answers the probe as privileged', () => {
    const { store } = harness();
    store.connect();
    const view = ledgerFixtureView();
    store.accept({ type: 'ledgerSnapshot', requestId: 'r1', view });
    expect(store.getSnapshot()).toMatchObject({ privileged: true, probeRequestId: null });
    expect(store.getSnapshot().view).toBe(view);
  });

  it('treats a refused probe as a read-only connection and shows the reason', () => {
    const { store } = harness();
    store.connect();
    store.accept({ type: 'ledgerCommandResult', requestId: 'r1', ok: false, reason: 'Chỉ đọc' });
    expect(store.getSnapshot()).toMatchObject({
      privileged: false,
      probeRequestId: null,
      viewError: 'Chỉ đọc',
    });
  });

  it('settles requests still in flight as lost when the socket reconnects', () => {
    const { store } = harness();
    store.sendMessage('x', 'xin chào');
    store.connect();
    expect(store.getSnapshot().sends[0]).toMatchObject({
      status: 'refused',
      reason: LEDGER_LOST_REASON,
    });
  });
});

describe('ledger store: replies', () => {
  it('ignores a view reply that is no longer the newest view request', () => {
    const { store } = harness();
    store.requestView(); // r1
    store.requestView(); // r2
    const view = ledgerFixtureView();
    store.accept({ type: 'ledgerSnapshot', requestId: 'r1', view });
    expect(store.getSnapshot().view).toBeNull();
    store.accept({ type: 'ledgerSnapshot', requestId: 'r2', view });
    expect(store.getSnapshot().view).toBe(view);
  });

  it('keeps the newer broadcast view when an older one arrives', () => {
    const { store } = harness();
    const fresh = ledgerFixtureView();
    store.accept({ type: 'ledgerSnapshot', view: fresh });
    store.accept({
      type: 'ledgerSnapshot',
      view: { ...fresh, generatedAt: '2000-01-01 00:00:00' },
    });
    expect(store.getSnapshot().view).toBe(fresh);
    expect(store.getSnapshot().privileged).toBe(true);
  });

  it('applies a timeline only when it answers the latest request for the same window', () => {
    const { store } = harness();
    store.requestTimeline(15); // r1
    const wrongWindow: LedgerTimelineMessage = {
      type: 'ledgerTimeline',
      requestId: 'r1',
      timeline: ledgerFixtureTimeline(60),
    };
    store.accept(wrongWindow);
    expect(store.getSnapshot().timeline).toBeNull();

    const timeline = ledgerFixtureTimeline(15);
    store.accept({ type: 'ledgerTimeline', requestId: 'r1', timeline });
    expect(store.getSnapshot().timeline).toBe(timeline);
    expect(store.getSnapshot().timelineWindow).toBe(15);
  });

  it('loads a file diff and reports a failed one with its reason', () => {
    const { store } = harness();
    store.requestFileDiff('D:/Code/app', 'src/a.ts'); // r1
    expect(store.getSnapshot().diff).toMatchObject({
      status: 'loading',
      worktree: 'D:/Code/app',
      path: 'src/a.ts',
    });
    store.accept({
      type: 'ledgerFileDiff',
      requestId: 'r1',
      ok: false,
      worktree: 'D:/Code/app',
      path: 'src/a.ts',
      diff: '',
      truncated: false,
      reason: 'Không đọc được tệp.',
    });
    expect(store.getSnapshot().diff).toMatchObject({
      status: 'failed',
      reason: 'Không đọc được tệp.',
    });
  });
  it('requests file history and applies only the newest matching reply', () => {
    const { store, sent } = harness();
    const firstRequestId = store.requestFileHistory('D:/repo/src/a.ts');
    const requestId = store.requestFileHistory('D:/repo/src/b.ts');
    expect(sent).toEqual([
      { type: 'ledgerFileHistoryRequest', requestId: firstRequestId, path: 'D:/repo/src/a.ts' },
      { type: 'ledgerFileHistoryRequest', requestId, path: 'D:/repo/src/b.ts' },
    ]);
    expect(store.getSnapshot().fileHistory).toMatchObject({
      requestId,
      path: 'D:/repo/src/b.ts',
      status: 'loading',
      entries: [],
    });
    store.accept({
      type: 'ledgerFileHistory',
      requestId: firstRequestId,
      path: 'D:/repo/src/a.ts',
      entries: [],
    });
    expect(store.getSnapshot().fileHistory?.requestId).toBe(requestId);
    const entries = [{
      ts: '2026-10-21 11:00:00',
      sessionId: 'session-a',
      agentKind: 'codex',
      agentName: 'Worker',
      branch: 'feat/a',
      checkout: 'D:/repo-wt',
      tool: 'apply_patch',
      intent: 'Sửa màn hình',
    }];
    store.accept({
      type: 'ledgerFileHistory',
      requestId,
      path: 'D:/repo/src/b.ts',
      entries,
    });
    expect(store.getSnapshot().fileHistory).toMatchObject({
      requestId,
      path: 'D:/repo/src/b.ts',
      status: 'done',
      entries,
    });
    const failedId = store.requestFileHistory('D:/repo/src/c.ts');
    store.accept({
      type: 'ledgerFileHistory',
      requestId: failedId,
      path: 'D:/repo/src/c.ts',
      entries: [],
      reason: 'Không đọc được cơ sở dữ liệu hoạt động.',
    });
    expect(store.getSnapshot().fileHistory).toMatchObject({
      requestId: failedId,
      status: 'failed',
      reason: 'Không đọc được cơ sở dữ liệu hoạt động.',
    });
  });
});

describe('ledger store: sending messages', () => {
  it('reports a delivered message with the sessions that received it', () => {
    const { store, sent } = harness();
    const id = store.sendMessage('c3a9e7f1', 'xin chào');
    expect(sent).toEqual([
      { type: 'ledgerSendMessage', requestId: id, sessionId: 'c3a9e7f1', text: 'xin chào' },
    ]);
    expect(store.getSnapshot().sends[0]).toMatchObject({ requestId: id, status: 'sending' });

    store.accept({ type: 'ledgerCommandResult', requestId: id, ok: true, delivered: ['c3a9e7f1'] });
    expect(store.getSnapshot().sends[0]).toMatchObject({
      status: 'delivered',
      delivered: ['c3a9e7f1'],
      reason: null,
    });
  });

  it('reports a refused message with the server reason', () => {
    const { store } = harness();
    const id = store.sendMessage('c3a9e7f1', 'xin chào');
    store.accept({
      type: 'ledgerCommandResult',
      requestId: id,
      ok: false,
      reason: 'Phiên đã dừng.',
    });
    expect(store.getSnapshot().sends[0]).toMatchObject({
      status: 'refused',
      reason: 'Phiên đã dừng.',
    });
  });

  it('falls back to a default reason when a refusal carries none', () => {
    const { store } = harness();
    const id = store.sendMessage('c3a9e7f1', 'xin chào');
    store.accept({ type: 'ledgerCommandResult', requestId: id, ok: false });
    expect(store.getSnapshot().sends[0]).toMatchObject({
      status: 'refused',
      reason: 'Máy chủ từ chối yêu cầu cây git.',
    });
  });

  it('marks a send refused as no-connection when the transport reports a disconnect', () => {
    const { store } = harness({ throwOnSend: new Error(TRANSPORT_DISCONNECTED_ERROR) });
    const id = store.sendMessage('x', 'xin chào');
    expect(store.getSnapshot().sends[0]).toMatchObject({
      requestId: id,
      status: 'refused',
      reason: LEDGER_NO_CONNECTION_REASON,
    });
  });

  it('marks a send refused with a generic reason when the transport throws otherwise', () => {
    const { store } = harness({ throwOnSend: new Error('boom') });
    store.sendMessage('x', 'xin chào');
    expect(store.getSnapshot().sends[0]).toMatchObject({
      status: 'refused',
      reason: 'Không gửi được yêu cầu cây git.',
    });
  });

  it('keeps only the newest twenty sends', () => {
    const { store } = harness();
    for (let index = 0; index < 25; index += 1) store.sendMessage('x', `tin ${index}`);
    const sends = store.getSnapshot().sends;
    expect(sends).toHaveLength(20);
    expect(sends.at(-1)?.requestId).toBe('r25');
  });
});

describe('ledger store: subscriptions and transport', () => {
  it('notifies subscribers on change and stops after unsubscribe', () => {
    const { store } = harness();
    let calls = 0;
    const unsubscribe = store.subscribe(() => {
      calls += 1;
    });
    store.requestView();
    expect(calls).toBe(1);
    unsubscribe();
    store.requestView();
    expect(calls).toBe(1);
  });

  it('sends through the transport installed by setSend', () => {
    const { store } = harness();
    const seen: ClientMessage[] = [];
    store.setSend((message) => {
      seen.push(message);
    });
    store.requestView();
    expect(seen).toHaveLength(1);
  });
});

describe('ledger fixture transport', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('answers the probe and a timeline request locally once the replies are due', () => {
    let counter = 0;
    const store = createLedgerStore({
      send: () => undefined,
      newRequestId: () => {
        counter += 1;
        return `f${counter}`;
      },
    });
    applyLedgerFixture(store);
    vi.advanceTimersByTime(200);
    expect(store.getSnapshot()).toMatchObject({ privileged: true, timelineWindow: 60 });
    expect(store.getSnapshot().view).not.toBeNull();
    expect(store.getSnapshot().timeline?.windowMinutes).toBe(60);
  });
});
describe('ledger store: coordination requests', () => {
  it('sends the new requests and applies their replies', () => {
    const { store, sent } = harness();
    store.requestCoordination();
    store.requestToolUsage(true);
    expect(sent.slice(-2)).toEqual([
      { type: 'ledgerCoordinationRequest', requestId: 'r1' },
      { type: 'ledgerToolUsageRequest', requestId: 'r2', refresh: true },
    ]);
    store.accept({ type: 'ledgerCoordination', requestId: 'r1', messages: [], handoffs: [] });
    store.accept({
      type: 'ledgerToolUsage',
      requestId: 'r2',
      ok: true,
      running: false,
      generatedAt: null,
      days: null,
      transcripts: {},
      rows: [],
      unusedSkills: {},
      tokenUsage: { totalUnits: 0, rows: [] },
      nameOnlyCandidates: [],
      reason: '',
    });
    expect(store.getSnapshot().coordination).toEqual({ messages: [], handoffs: [] });
    expect(store.getSnapshot().toolUsage?.ok).toBe(true);
  });
});

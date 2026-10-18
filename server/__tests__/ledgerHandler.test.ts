import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ServerMessage } from '../../core/src/messages.js';
import {
  LEDGER_REASON_BAD_SESSION,
  LEDGER_REASON_BAD_WINDOW,
  LEDGER_REASON_COMMAND_FAILED,
  LEDGER_REASON_READ_ONLY,
  LEDGER_REASON_UNAVAILABLE,
  LEDGER_REASON_WORKTREE_UNKNOWN,
} from '../src/ledger/constants.js';
import { handleLedgerMessage } from '../src/ledger/handler.js';
import { eventRow, flushAsync, makeService, minutesAgo } from './ledgerFixtures.js';

const FALLBACK_REQUEST_ID = '00000000-0000-4000-8000-000000000000';
const LEDGER_REQUEST_TYPES = [
  'ledgerViewRequest',
  'ledgerTimelineRequest',
  'ledgerFileDiffRequest',
  'ledgerSendMessage',
];

function collector() {
  const sent: ServerMessage[] = [];
  return {
    sent,
    send: (message: ServerMessage) => {
      sent.push(message);
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('handleLedgerMessage: dispatch', () => {
  it('returns false and sends nothing for a message that is not a ledger request', () => {
    const { sent, send } = collector();
    const handled = handleLedgerMessage({ type: 'someOtherRequest' }, send, {
      ledger: null,
      privileged: true,
    });
    expect(handled).toBe(false);
    expect(sent).toEqual([]);
  });
});

describe('handleLedgerMessage: unprivileged connections', () => {
  it.each(LEDGER_REQUEST_TYPES)('refuses %s as read-only and keeps its requestId', (type) => {
    const { sent, send } = collector();
    const handled = handleLedgerMessage({ type, requestId: 'req-1' }, send, {
      ledger: makeService().service,
      privileged: false,
    });
    expect(handled).toBe(true);
    expect(sent).toEqual([
      {
        type: 'ledgerCommandResult',
        requestId: 'req-1',
        ok: false,
        reason: LEDGER_REASON_READ_ONLY,
      },
    ]);
  });

  it('uses the fallback requestId when the request has none', () => {
    const { sent, send } = collector();
    handleLedgerMessage({ type: 'ledgerViewRequest' }, send, { ledger: null, privileged: false });
    expect(sent[0]).toMatchObject({ requestId: FALLBACK_REQUEST_ID });
  });
});

describe('handleLedgerMessage: privileged connections', () => {
  it('replies unavailable when the ledger is not wired on this host', () => {
    const { sent, send } = collector();
    handleLedgerMessage({ type: 'ledgerViewRequest', requestId: 'req-2' }, send, {
      ledger: null,
      privileged: true,
    });
    expect(sent).toEqual([
      {
        type: 'ledgerCommandResult',
        requestId: 'req-2',
        ok: false,
        reason: LEDGER_REASON_UNAVAILABLE,
      },
    ]);
  });

  it('replies with a snapshot carrying the requestId', async () => {
    const h = makeService({ data: { events: [eventRow('s1', { ts: minutesAgo(1) })] } });
    const { sent, send } = collector();
    handleLedgerMessage({ type: 'ledgerViewRequest', requestId: 'req-3' }, send, {
      ledger: h.service,
      privileged: true,
    });
    await flushAsync();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: 'ledgerSnapshot', requestId: 'req-3' });
  });

  it.each([30, '15', undefined])('refuses timeline window %j', async (windowMinutes) => {
    const { sent, send } = collector();
    handleLedgerMessage(
      { type: 'ledgerTimelineRequest', requestId: 'req-4', windowMinutes },
      send,
      {
        ledger: makeService().service,
        privileged: true,
      },
    );
    await flushAsync();
    expect(sent[0]).toMatchObject({
      type: 'ledgerCommandResult',
      requestId: 'req-4',
      ok: false,
      reason: LEDGER_REASON_BAD_WINDOW,
    });
  });

  it('replies with a timeline for a supported window', async () => {
    const { sent, send } = collector();
    handleLedgerMessage(
      { type: 'ledgerTimelineRequest', requestId: 'req-5', windowMinutes: 15 },
      send,
      {
        ledger: makeService().service,
        privileged: true,
      },
    );
    await flushAsync();
    expect(sent[0]).toMatchObject({
      type: 'ledgerTimeline',
      requestId: 'req-5',
      timeline: { windowMinutes: 15 },
    });
  });

  it('replies to a send with the refusal reason and the requestId', async () => {
    const { sent, send } = collector();
    handleLedgerMessage(
      { type: 'ledgerSendMessage', requestId: 'req-6', sessionId: 'bad id', text: 'hi' },
      send,
      { ledger: makeService().service, privileged: true },
    );
    await flushAsync();
    expect(sent[0]).toMatchObject({
      type: 'ledgerCommandResult',
      requestId: 'req-6',
      ok: false,
      reason: LEDGER_REASON_BAD_SESSION,
    });
  });

  it('replies to a diff for an unknown worktree with the worktree and path echoed back', async () => {
    const { sent, send } = collector();
    handleLedgerMessage(
      { type: 'ledgerFileDiffRequest', requestId: 'req-7', worktree: 'C:/Elsewhere', path: 'a.ts' },
      send,
      { ledger: makeService().service, privileged: true },
    );
    await flushAsync();
    expect(sent[0]).toMatchObject({
      type: 'ledgerFileDiff',
      requestId: 'req-7',
      ok: false,
      worktree: 'C:/Elsewhere',
      path: 'a.ts',
      reason: LEDGER_REASON_WORKTREE_UNKNOWN,
    });
  });

  it('replies with a command failure and logs when the service throws', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = makeService();
    h.source.eventRows = () => {
      throw new Error('db down');
    };
    const { sent, send } = collector();

    handleLedgerMessage({ type: 'ledgerViewRequest', requestId: 'req-8' }, send, {
      ledger: h.service,
      privileged: true,
    });
    await flushAsync();

    expect(sent).toEqual([
      {
        type: 'ledgerCommandResult',
        requestId: 'req-8',
        ok: false,
        reason: LEDGER_REASON_COMMAND_FAILED,
      },
    ]);
    expect(errors).toHaveBeenCalledWith(
      '[ledger] request failed',
      'ledgerViewRequest',
      expect.any(Error),
    );
  });
});

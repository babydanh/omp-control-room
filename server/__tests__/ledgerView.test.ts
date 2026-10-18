import { describe, expect, it } from 'vitest';

import type { LedgerOverlapScan, LedgerView } from '../../core/src/messages.js';
import { LEDGER_NOTICE_CONTENT_MAX, LEDGER_SPAM_RULE } from '../src/ledger/constants.js';
import type { LedgerWorktreeState } from '../src/ledger/git.js';
import { ledgerBasename } from '../src/ledger/ledgerPath.js';
import { formatLedgerTime } from '../src/ledger/ledgerTime.js';
import {
  buildLedgerView,
  type LedgerRepoInput,
  type LedgerViewInput,
  viewContentJson,
} from '../src/ledger/view.js';
import {
  eventRow,
  LEDGER_NOW_MS,
  minutesAgo,
  noticeRow,
  pendingRow,
  sessionRow,
} from './ledgerFixtures.js';

const MINUTE_MS = 60_000;

function worktreeState(
  path: string,
  overrides: Partial<LedgerWorktreeState> = {},
): LedgerWorktreeState {
  return {
    path,
    name: ledgerBasename(path),
    branch: 'main',
    head: 'abc12345',
    isMain: false,
    ahead: 0,
    behind: 0,
    dirtyCount: 0,
    dirtyFiles: [],
    merged: false,
    hasUpstream: false,
    lastCommitSubject: '',
    lastCommitAt: null,
    ...overrides,
  };
}

function viewInput(overrides: Partial<LedgerViewInput> = {}): LedgerViewInput {
  return {
    nowMs: LEDGER_NOW_MS,
    database: { state: 'ok' },
    sessions: [],
    events: [],
    pending: [],
    notices: [],
    mainWrites: [],
    repos: [],
    overlaps: [],
    ...overrides,
  };
}

function sessionById(view: LedgerView, sessionId: string) {
  const session = view.sessions.find((row) => row.sessionId === sessionId);
  if (session === undefined) throw new Error(`session ${sessionId} missing from view`);
  return session;
}

describe('buildLedgerView: session liveness', () => {
  it('marks a session live when open with a heartbeat within 60 seconds', () => {
    const view = buildLedgerView(
      viewInput({
        sessions: [
          sessionRow('fresh', { heartbeat: formatLedgerTime(LEDGER_NOW_MS - 30_000) }),
          sessionRow('edge', { heartbeat: formatLedgerTime(LEDGER_NOW_MS - 60_000) }),
          sessionRow('stale', { heartbeat: formatLedgerTime(LEDGER_NOW_MS - 61_000) }),
        ],
      }),
    );
    expect(sessionById(view, 'fresh')).toMatchObject({ open: true, live: true });
    expect(sessionById(view, 'edge')).toMatchObject({ open: true, live: true });
    expect(sessionById(view, 'stale')).toMatchObject({ open: true, live: false });
  });

  it('marks an ended session closed and not live, even with a fresh heartbeat', () => {
    const view = buildLedgerView(
      viewInput({
        sessions: [
          sessionRow('done', {
            endedAt: minutesAgo(1),
            heartbeat: formatLedgerTime(LEDGER_NOW_MS - 10_000),
          }),
        ],
      }),
    );
    expect(sessionById(view, 'done')).toMatchObject({ open: false, live: false });
  });
});

describe('buildLedgerView: checkout mapping', () => {
  it('maps a session to its checkout case-insensitively and lists it under that worktree', () => {
    const view = buildLedgerView(
      viewInput({
        sessions: [sessionRow('s1')],
        events: [eventRow('s1', { checkout: 'C:/Repo/WT-A', repo: 'C:/Repo', branch: 'feat/a' })],
        repos: [
          {
            repo: 'C:/Repo',
            scan: { kind: 'repo', worktrees: [worktreeState('c:/repo/wt-a/')] },
          },
        ],
      }),
    );
    const repo = view.repos[0];
    expect(repo).toMatchObject({ repo: 'C:/Repo', name: 'Repo' });
    expect(repo.worktrees[0].sessionIds).toEqual(['s1']);
    expect(sessionById(view, 's1')).toMatchObject({
      checkout: 'C:/Repo/WT-A',
      repo: 'C:/Repo',
      branch: 'feat/a',
    });
  });

  it('does not list a closed session under its worktree', () => {
    const view = buildLedgerView(
      viewInput({
        sessions: [sessionRow('gone', { endedAt: minutesAgo(1) })],
        events: [eventRow('gone', { checkout: 'C:/Repo/wt' })],
        repos: [
          { repo: 'C:/Repo', scan: { kind: 'repo', worktrees: [worktreeState('C:/Repo/wt')] } },
        ],
      }),
    );
    expect(view.repos[0].worktrees[0].sessionIds).toEqual([]);
  });

  it('lists folders that are not git repos as unscanned, not as repos', () => {
    const notRepo: LedgerRepoInput = { repo: 'V:/Duan/Project', scan: { kind: 'not-repo' } };
    const view = buildLedgerView(viewInput({ repos: [notRepo] }));
    expect(view.unscannedFolders).toEqual(['V:/Duan/Project']);
    expect(view.repos).toEqual([]);
  });
});

describe('buildLedgerView: call counts and spam', () => {
  it('counts calls in the last 5 and 30 minutes, skipping session events', () => {
    const view = buildLedgerView(
      viewInput({
        sessions: [sessionRow('s1')],
        events: [
          eventRow('s1', { kind: 'session', tool: 'start', ts: minutesAgo(1) }),
          eventRow('s1', { ts: minutesAgo(2) }),
          eventRow('s1', { ts: minutesAgo(5) }),
          eventRow('s1', { ts: minutesAgo(10) }),
          eventRow('s1', { ts: minutesAgo(40) }),
        ],
      }),
    );
    expect(sessionById(view, 's1')).toMatchObject({ calls5m: 2, calls30m: 3 });
  });

  it('flags a session that crosses the spam rule and echoes the rule', () => {
    const events = Array.from({ length: 60 }, (_, index) =>
      eventRow('busy', { ts: formatLedgerTime(LEDGER_NOW_MS - MINUTE_MS + index * 1000) }),
    );
    const view = buildLedgerView(viewInput({ sessions: [sessionRow('busy')], events }));
    expect(sessionById(view, 'busy')).toMatchObject({
      spamming: true,
      spamReason: '60 lệnh trong 5 phút',
    });
    expect(view.spamRule).toEqual(LEDGER_SPAM_RULE);
  });
});

describe('buildLedgerView: pending, notices, main writes', () => {
  it('normalizes pending checkouts and keeps their counts', () => {
    const view = buildLedgerView(
      viewInput({
        pending: [
          pendingRow('C:\\Repo\\WT-A\\', { dirty: 2, unpushed: 1, notInMain: 1, hasRemote: true }),
        ],
      }),
    );
    expect(view.pending[0]).toMatchObject({
      checkout: 'C:/Repo/WT-A',
      dirty: 2,
      unpushed: 1,
      notInMain: 1,
      hasRemote: true,
    });
  });

  it('shows only undelivered notices, newest first, with content cut to the cap', () => {
    const view = buildLedgerView(
      viewInput({
        notices: [
          noticeRow(1, { ts: minutesAgo(5), delivered: 0 }),
          noticeRow(2, { ts: minutesAgo(3), delivered: 1 }),
          noticeRow(3, { ts: minutesAgo(1), delivered: 0 }),
          noticeRow(4, { ts: minutesAgo(10), delivered: 0, content: 'x'.repeat(500) }),
        ],
      }),
    );
    expect(view.notices.map((notice) => notice.id)).toEqual([3, 1, 4]);
    expect(view.notices[2].content).toHaveLength(LEDGER_NOTICE_CONTENT_MAX);
  });

  it('lists only main-checkout edits and writes from the last day', () => {
    const view = buildLedgerView(
      viewInput({
        mainWrites: [
          eventRow('s1', { isMainCheckout: true, kind: 'edit', ts: minutesAgo(10) }),
          eventRow('s2', { isMainCheckout: true, kind: 'bash', tool: 'bash', ts: minutesAgo(5) }),
          eventRow('s3', {
            isMainCheckout: true,
            kind: 'write',
            tool: 'write',
            ts: minutesAgo(25 * 60),
          }),
          eventRow('s4', { isMainCheckout: false, kind: 'edit', ts: minutesAgo(2) }),
        ],
      }),
    );
    expect(view.mainWrites.map((write) => write.sessionId)).toEqual(['s1']);
  });

  it('passes overlap scans through unchanged', () => {
    const scan: LedgerOverlapScan = {
      repo: 'C:/Repo',
      state: 'partial',
      startedAt: null,
      finishedAt: null,
      base: null,
      lanes: 2,
      pairs: [],
      main: [],
      pending: [],
      complete: false,
      error: null,
    };
    expect(buildLedgerView(viewInput({ overlaps: [scan] })).overlaps).toEqual([scan]);
  });
});

describe('viewContentJson', () => {
  it('ignores generatedAt, so an unchanged view hashes the same at a later time', () => {
    const first = viewContentJson(buildLedgerView(viewInput({ nowMs: LEDGER_NOW_MS })));
    const later = viewContentJson(buildLedgerView(viewInput({ nowMs: LEDGER_NOW_MS + 60_000 })));
    expect(later).toBe(first);
  });
});

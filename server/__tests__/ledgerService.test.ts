import { afterEach, describe, expect, it, vi } from 'vitest';

import type { LedgerSnapshotMessage } from '../../core/src/messages.js';
import {
  LEDGER_ACTIVITY_WINDOW_MS,
  LEDGER_GIT_REFRESH_MS,
  LEDGER_OVERLAP_BASE,
  LEDGER_OVERLAP_BUDGET_SECONDS,
  LEDGER_REASON_BAD_SESSION,
  LEDGER_REASON_DIFF_EMPTY,
  LEDGER_REASON_WORKTREE_UNKNOWN,
} from '../src/ledger/constants.js';
import { formatLedgerTime } from '../src/ledger/ledgerTime.js';
import {
  defaultGitScript,
  eventRow,
  flushAsync,
  type GitScript,
  LEDGER_NOW_MS,
  makeService,
  minutesAgo,
  type ServiceHarness,
  sessionRow,
} from './ledgerFixtures.js';

const REPO = 'C:/Repo';
const SESSION_ID = 'session-0123456789abcdef';

/** A recent edit in the repo, so the view knows about it and reads its git state. */
function repoEvent() {
  return eventRow('s1', { repo: REPO, checkout: REPO, ts: minutesAgo(1) });
}

/** Counts full git reads: every read starts with `rev-parse --show-prefix`. */
function topLevelReads(h: ServiceHarness): number {
  return h.git.calls.filter((call) => call.args.join(' ') === 'rev-parse --show-prefix').length;
}

/** The repo has two checkouts, so an overlap scan is due. */
const TWO_CHECKOUTS: GitScript = (cwd, args) =>
  args[0] === 'worktree'
    ? {
        stdout:
          `worktree ${cwd}\nHEAD ${'a'.repeat(40)}\nbranch refs/heads/main\n\n` +
          `worktree ${cwd}-wt\nHEAD ${'b'.repeat(40)}\nbranch refs/heads/feat\n`,
      }
    : defaultGitScript(cwd, args);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('LedgerService: polling lifecycle', () => {
  it('polls only while a subscriber exists, and stops when the last one leaves', () => {
    const h = makeService();
    expect(h.schedule.live.size).toBe(0);

    const off = h.service.subscribe(() => {});
    expect(h.schedule.live.size).toBe(1);

    off();
    expect(h.schedule.live.size).toBe(0);
  });

  it('keeps polling for the activity window after a request, then stops', async () => {
    const h = makeService({ data: { events: [repoEvent()] } });
    await h.service.getView();
    expect(h.schedule.live.size).toBe(1);

    h.advance(LEDGER_ACTIVITY_WINDOW_MS - 1);
    h.schedule.fire();
    expect(h.schedule.live.size).toBe(1);

    h.advance(1);
    h.schedule.fire();
    expect(h.schedule.live.size).toBe(0);
  });

  it('stops the poll on dispose and refuses later requests', async () => {
    const h = makeService();
    h.service.subscribe(() => {});
    h.service.dispose();

    expect(h.source.closed).toBe(true);
    expect(h.schedule.live.size).toBe(0);
    await expect(h.service.getView()).rejects.toThrow('ledger service is disposed');
  });

  it('counts a subscriber as watching the ledger', () => {
    const h = makeService();
    expect(h.service.watched()).toBe(false);

    h.service.subscribe(() => {});
    expect(h.service.watched()).toBe(true);
  });
});

describe('LedgerService: broadcasts', () => {
  it('broadcasts a snapshot only when the view content changes', async () => {
    const h = makeService({ data: { events: [repoEvent()] } });
    // Warm the git cache first, so the broadcast count below depends only on the data.
    await h.service.getView();

    const messages: LedgerSnapshotMessage[] = [];
    h.service.subscribe((message) => messages.push(message));

    h.schedule.fire();
    await flushAsync();
    expect(messages).toHaveLength(0);

    h.source.data.sessions = [sessionRow('s9')];
    h.schedule.fire();
    await flushAsync();
    expect(messages).toHaveLength(1);
    expect(messages[0].view.sessions.map((session) => session.sessionId)).toEqual(['s9']);
  });

  it('keeps delivering to the other listeners when one throws', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const h = makeService();
    h.service.subscribe(() => {
      throw new Error('listener down');
    });
    const received: LedgerSnapshotMessage[] = [];
    h.service.subscribe((message) => received.push(message));

    h.schedule.fire();
    await flushAsync();

    expect(received).toHaveLength(1);
  });
});

describe('LedgerService: git cache', () => {
  it('reuses a git scan for 60 seconds, then reads it again on the next poll', async () => {
    const h = makeService({ data: { events: [repoEvent()] } });
    h.service.subscribe(() => {});
    await h.service.getView();
    await flushAsync();
    expect(topLevelReads(h)).toBe(1);

    h.advance(LEDGER_GIT_REFRESH_MS - 1);
    h.schedule.fire();
    await flushAsync();
    expect(topLevelReads(h)).toBe(1);

    h.advance(1);
    h.schedule.fire();
    await flushAsync();
    expect(topLevelReads(h)).toBe(2);
  });

  it('keeps the last good git scan when a read throws', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let failing = false;
    const h = makeService({
      data: { events: [repoEvent()] },
      git: (cwd, args) => {
        if (failing) throw new Error('git exploded');
        return defaultGitScript(cwd, args);
      },
    });
    await h.service.getView();
    failing = true;
    h.advance(LEDGER_GIT_REFRESH_MS);

    h.service.subscribe(() => {});
    h.schedule.fire();
    await flushAsync();

    const view = await h.service.getView();
    expect(view.repos.map((repo) => repo.repo)).toEqual([REPO]);
  });
});

describe('LedgerService: reads', () => {
  it('assembles the view and reads each recent repo once', async () => {
    const h = makeService({
      data: {
        events: [repoEvent()],
        sessions: [sessionRow('s1', { heartbeat: formatLedgerTime(LEDGER_NOW_MS - 30_000) })],
      },
    });

    const view = await h.service.getView();
    await flushAsync();

    expect(view.repos.map((repo) => repo.repo)).toEqual([REPO]);
    expect(view.sessions[0]).toMatchObject({ sessionId: 's1', live: true });
    expect(topLevelReads(h)).toBe(1);
  });

  it('returns the timeline for the requested window', async () => {
    const h = makeService({
      data: { events: [eventRow('s1', { ts: minutesAgo(1) })] },
    });
    const timeline = await h.service.timeline(15);
    expect(timeline.windowMinutes).toBe(15);
    expect(timeline.lanes.map((lane) => lane.sessionId)).toEqual(['s1']);
  });

  it('refuses a worktree the view does not list, and diffs one it does', async () => {
    const h = makeService({ data: { events: [repoEvent()] } });

    expect(await h.service.fileDiff('C:/Elsewhere', 'a.ts')).toMatchObject({
      ok: false,
      reason: LEDGER_REASON_WORKTREE_UNKNOWN,
    });
    expect(h.git.calls.filter((call) => call.args[0] === 'diff')).toHaveLength(0);

    expect(await h.service.fileDiff(REPO, 'src/a.ts')).toMatchObject({
      ok: true,
      diff: '',
      reason: LEDGER_REASON_DIFF_EMPTY,
    });
    const diffCall = h.git.calls.filter((call) => call.args[0] === 'diff').at(-1);
    expect(diffCall?.args).toEqual([
      'diff',
      '--no-color',
      '--no-ext-diff',
      '--no-textconv',
      'HEAD',
      '--',
      'src/a.ts',
    ]);
  });
});

describe('LedgerService: sending', () => {
  it('runs who.py send, then forces a git refresh in the background', async () => {
    const h = makeService({ data: { events: [repoEvent()] } });
    await h.service.getView();
    await flushAsync();
    expect(topLevelReads(h)).toBe(1);

    const outcome = await h.service.sendMessage(SESSION_ID, 'hi');
    expect(outcome).toEqual({ ok: true, delivered: ['89abcdef'] });
    expect(h.who.calls[0].argv).toEqual(['send', SESSION_ID, 'hi']);

    await flushAsync();
    expect(topLevelReads(h)).toBe(2);
  });

  it('refuses a bad session id without running who.py', async () => {
    const h = makeService();
    expect(await h.service.sendMessage('bad id', 'hi')).toEqual({
      ok: false,
      reason: LEDGER_REASON_BAD_SESSION,
    });
    expect(h.who.calls).toHaveLength(0);
  });
});

describe('LedgerService: overlap scans', () => {
  it('starts an overlap scan for a repo with two checkouts, with the exact argv', async () => {
    const h = makeService({ data: { events: [repoEvent()] }, git: TWO_CHECKOUTS });
    await h.service.getView();

    expect(h.overlap.calls).toHaveLength(1);
    expect(h.overlap.calls[0].argv).toEqual([
      REPO,
      '--json',
      '--base',
      LEDGER_OVERLAP_BASE,
      '--budget',
      String(LEDGER_OVERLAP_BUDGET_SECONDS),
    ]);
    expect(h.overlap.calls[0].argv).not.toContain('--notify');
  });

  it('returns the overlap scans without marking the ledger watched', async () => {
    const h = makeService({ data: { events: [repoEvent()] }, git: TWO_CHECKOUTS });

    const scans = await h.service.overlapScans();
    expect(scans).toHaveLength(1);
    expect(scans[0]?.repo).toBe(REPO);
    expect(h.service.watched()).toBe(false);

    await h.service.getView();
    expect(h.service.watched()).toBe(true);
  });
});

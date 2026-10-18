import { describe, expect, it } from 'vitest';

import { LEDGER_SPAM_RULE, LEDGER_TIMELINE_MAX_LANES } from '../src/ledger/constants.js';
import { formatLedgerTime } from '../src/ledger/ledgerTime.js';
import {
  buildTimeline,
  type TimelineEvent,
  type TimelineSession,
  toolCategory,
} from '../src/ledger/timeline.js';
import { LEDGER_NOW_MS, minutesAgo } from './ledgerFixtures.js';

const MINUTE_MS = 60_000;

function timelineEvent(sessionId: string, overrides: Partial<TimelineEvent> = {}): TimelineEvent {
  return {
    tMs: LEDGER_NOW_MS,
    sessionId,
    kind: 'edit',
    tool: 'edit',
    path: null,
    pathKey: null,
    repo: null,
    intent: null,
    ...overrides,
  };
}

function build(events: TimelineEvent[], windowMinutes = 15, sessions: TimelineSession[] = []) {
  return buildTimeline({
    windowMinutes,
    nowMs: LEDGER_NOW_MS,
    events,
    sessions,
    rule: LEDGER_SPAM_RULE,
  });
}

describe('toolCategory', () => {
  it('maps edit and write to edit, bash and git to bash, and read-style tools to read', () => {
    expect(toolCategory('edit', 'edit')).toBe('edit');
    expect(toolCategory('write', 'write')).toBe('edit');
    expect(toolCategory('bash', 'bash')).toBe('bash');
    expect(toolCategory('git', 'bash')).toBe('bash');
    expect(toolCategory('grep', 'grep')).toBe('read');
    expect(toolCategory(null, 'ls')).toBe('read');
  });

  it('falls back to other for unknown kinds and tools', () => {
    expect(toolCategory('todo', 'todo')).toBe('other');
    expect(toolCategory('session', 'start')).toBe('other');
  });
});

describe('buildTimeline: buckets', () => {
  it('reports 60 buckets worth of seconds and the window bounds', () => {
    const timeline = build([], 15);
    expect(timeline.windowMinutes).toBe(15);
    expect(timeline.bucketSeconds).toBe(15);
    expect(timeline.startedAt).toBe(minutesAgo(15));
    expect(timeline.endedAt).toBe(formatLedgerTime(LEDGER_NOW_MS));
    expect(build([], 1440).bucketSeconds).toBe(1440);
  });

  it('places events in their bucket and emits only non-empty buckets, in order', () => {
    // Window 15 min => 15 s buckets. Index = floor((t - start) / 15 s), clamped to 59.
    const events = [
      timelineEvent('s1', { tMs: LEDGER_NOW_MS - 15 * MINUTE_MS + 1000 }), // index 0
      timelineEvent('s1', { tMs: LEDGER_NOW_MS - 7.5 * MINUTE_MS }), // index 30
      timelineEvent('s1', { tMs: LEDGER_NOW_MS }), // clamped to index 59
    ];
    const lane = build(events, 15).lanes[0];
    expect(lane.buckets.map((bucket) => bucket.index)).toEqual([0, 30, 59]);
    expect(lane.buckets.map((bucket) => bucket.edit)).toEqual([1, 1, 1]);
  });

  it('counts each category in its bucket', () => {
    const at = LEDGER_NOW_MS - MINUTE_MS;
    const events = [
      timelineEvent('s1', { tMs: at, kind: 'edit', tool: 'edit' }),
      timelineEvent('s1', { tMs: at, kind: 'write', tool: 'write' }),
      timelineEvent('s1', { tMs: at, kind: 'bash', tool: 'bash' }),
      timelineEvent('s1', { tMs: at, kind: 'git', tool: 'bash' }),
      timelineEvent('s1', { tMs: at, kind: 'grep', tool: 'grep' }),
      timelineEvent('s1', { tMs: at, kind: 'todo', tool: 'todo' }),
    ];
    const [bucket] = build(events, 15).lanes[0].buckets;
    expect(bucket).toMatchObject({ edit: 2, bash: 2, read: 1, other: 1 });
  });

  it('ignores session lifecycle events and events outside the window', () => {
    const events = [
      timelineEvent('s1', { kind: 'session', tool: 'start' }),
      timelineEvent('s2', { tMs: LEDGER_NOW_MS - 16 * MINUTE_MS }),
      timelineEvent('s3', { tMs: LEDGER_NOW_MS + MINUTE_MS }),
    ];
    expect(build(events, 15).lanes).toEqual([]);
  });

  it('reports lane totals and the session metadata for each lane', () => {
    const sessions: TimelineSession[] = [
      { sessionId: 's1', agentKind: 'sub', agentName: 'worker' },
    ];
    const events = [timelineEvent('s1'), timelineEvent('s1'), timelineEvent('s2')];
    const lanes = build(events, 15, sessions).lanes;
    const s1 = lanes.find((lane) => lane.sessionId === 's1');
    const s2 = lanes.find((lane) => lane.sessionId === 's2');
    expect(s1).toMatchObject({ agentKind: 'sub', agentName: 'worker', total: 2 });
    expect(s2).toMatchObject({ agentKind: 'main', agentName: '', total: 1 });
  });
});

describe('buildTimeline: shared files', () => {
  it('pairs two sessions editing the same path in the same bucket', () => {
    const events = [
      timelineEvent('a', { path: 'src/X.ts', pathKey: 'src/x.ts' }),
      timelineEvent('b', { path: 'src/X.ts', pathKey: 'src/x.ts' }),
    ];
    expect(build(events, 15).shared).toEqual([{ a: 'a', b: 'b', path: 'src/X.ts', bucket: 59 }]);
  });

  it('does not pair sessions that edit the same path in different buckets', () => {
    const events = [
      timelineEvent('a', { tMs: LEDGER_NOW_MS - MINUTE_MS, pathKey: 'x.ts' }),
      timelineEvent('b', { tMs: LEDGER_NOW_MS, pathKey: 'x.ts' }),
    ];
    expect(build(events, 15).shared).toEqual([]);
  });
});

describe('buildTimeline: spam and truncation', () => {
  it('flags a lane whose calls cross the spam rule, with the reason', () => {
    const events = Array.from({ length: 60 }, (_, index) =>
      timelineEvent('busy', { tMs: LEDGER_NOW_MS - MINUTE_MS + index * 1000, kind: 'bash' }),
    );
    const lane = build(events, 60).lanes[0];
    expect(lane.spamming).toBe(true);
    expect(lane.spamReason).toBe('60 lệnh trong 5 phút');
  });

  it('caps lanes and reports truncation', () => {
    const events = Array.from({ length: LEDGER_TIMELINE_MAX_LANES + 1 }, (_, index) =>
      timelineEvent(`s${index}`),
    );
    const timeline = build(events, 15);
    expect(timeline.lanes).toHaveLength(LEDGER_TIMELINE_MAX_LANES);
    expect(timeline.truncated).toBe(true);
  });

  it('is not truncated below the lane cap', () => {
    expect(build([timelineEvent('only')], 15).truncated).toBe(false);
  });
});

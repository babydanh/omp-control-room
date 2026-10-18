import { describe, expect, it } from 'vitest';

import type {
  LedgerSharedFile,
  LedgerTimeline,
  LedgerTimelineBucket,
  LedgerTimelineLane,
} from '../../core/src/messages.js';
import {
  bucketTotal,
  describeBucket,
  dominantCategory,
  dotRadius,
  layoutTimeline,
  repoGroupLabel,
  TIMELINE_GROUP_HEIGHT,
  TIMELINE_LANE_HEIGHT,
} from '../src/company/ledger/ledgerTimelineLayout.js';

const CHART_WIDTH = 600;

function bucket(
  index: number,
  counts: Partial<Pick<LedgerTimelineBucket, 'edit' | 'bash' | 'read' | 'other'>> = {},
  extra: Partial<Pick<LedgerTimelineBucket, 'intents' | 'files'>> = {},
): LedgerTimelineBucket {
  return {
    index,
    edit: counts.edit ?? 0,
    bash: counts.bash ?? 0,
    read: counts.read ?? 0,
    other: counts.other ?? 0,
    intents: extra.intents ?? [],
    files: extra.files ?? [],
  };
}

function lane(
  sessionId: string,
  repo: string | null,
  buckets: LedgerTimelineBucket[],
): LedgerTimelineLane {
  return {
    sessionId,
    agentKind: 'omp',
    agentName: sessionId.toUpperCase(),
    repo,
    spamming: false,
    spamReason: null,
    total: buckets.reduce((sum, item) => sum + bucketTotal(item), 0),
    buckets,
  };
}

function timeline(lanes: LedgerTimelineLane[], shared: LedgerSharedFile[] = []): LedgerTimeline {
  return {
    windowMinutes: 60,
    bucketSeconds: 60,
    startedAt: '2026-10-18 10:00:00',
    endedAt: '2026-10-18 11:00:00',
    lanes,
    shared,
    truncated: false,
  };
}

describe('dots and categories', () => {
  it('adds the four categories of a bucket', () => {
    expect(bucketTotal(bucket(0, { edit: 1, bash: 2, read: 3, other: 4 }))).toBe(10);
  });

  it('picks the category with the most events, and the earlier one on a tie', () => {
    expect(dominantCategory(bucket(0))).toBeNull();
    expect(dominantCategory(bucket(0, { edit: 2, read: 2 }))).toBe('edit');
    expect(dominantCategory(bucket(0, { edit: 3, bash: 5 }))).toBe('bash');
  });

  it('grows a dot with its count and never past the cap', () => {
    expect(dotRadius(0)).toBe(0);
    expect(dotRadius(1)).toBeGreaterThanOrEqual(2);
    expect(dotRadius(1000)).toBeLessThanOrEqual(8);
    for (let count = 1; count < 200; count += 1) {
      expect(dotRadius(count + 1)).toBeGreaterThanOrEqual(dotRadius(count));
    }
  });
});

describe('layoutTimeline: lanes and dots', () => {
  it('places a bucket at its centre along the chart', () => {
    const layout = layoutTimeline(
      timeline([lane('a', 'D:/Code/app', [bucket(0, { edit: 1 })])]),
      CHART_WIDTH,
    );
    expect(layout.lanes[0].dots[0]).toMatchObject({ index: 0, x: 5, category: 'edit', total: 1 });
    expect(layout.width).toBe(CHART_WIDTH);
  });

  it('draws no dot for an empty bucket', () => {
    const layout = layoutTimeline(timeline([lane('a', 'D:/Code/app', [bucket(3)])]), CHART_WIDTH);
    expect(layout.lanes[0].dots).toEqual([]);
  });

  it('groups lanes by repo in first-seen order and stacks them below a heading each', () => {
    const layout = layoutTimeline(
      timeline([
        lane('a', 'D:/Code/omp-board', []),
        lane('b', 'D:/Code/api', []),
        lane('c', 'D:/Code/omp-board', []),
      ]),
      CHART_WIDTH,
    );
    expect(layout.groups.map((group) => group.label)).toEqual(['omp-board', 'api']);
    expect(layout.lanes.map((item) => item.sessionId)).toEqual(['a', 'c', 'b']);
    expect(layout.lanes[0].top).toBe(TIMELINE_GROUP_HEIGHT);
    expect(layout.lanes[1].top).toBe(TIMELINE_GROUP_HEIGHT + TIMELINE_LANE_HEIGHT);
    expect(layout.groups[1].top).toBe(TIMELINE_GROUP_HEIGHT + 2 * TIMELINE_LANE_HEIGHT);
  });

  it('labels a lane with no repo as unknown', () => {
    expect(repoGroupLabel(null)).toBe('Không rõ repo');
  });
});

describe('layoutTimeline: shared files and ticks', () => {
  it('draws one connector per lane pair and bucket, counting each shared file', () => {
    const shared: LedgerSharedFile[] = [
      { a: 'a', b: 'b', path: 'x.ts', bucket: 3 },
      { a: 'b', b: 'a', path: 'y.ts', bucket: 3 },
    ];
    const layout = layoutTimeline(
      timeline(
        [
          lane('a', 'D:/Code/app', [bucket(3, { edit: 1 })]),
          lane('b', 'D:/Code/app', [bucket(3, { read: 1 })]),
        ],
        shared,
      ),
      CHART_WIDTH,
    );
    expect(layout.connectors).toHaveLength(1);
    expect(layout.connectors[0]).toMatchObject({ a: 'a', b: 'b', bucket: 3, count: 2 });
    expect(layout.connectors[0].paths).toEqual(['x.ts', 'y.ts']);
  });

  it('skips a shared file whose session is not in the timeline', () => {
    const layout = layoutTimeline(
      timeline([lane('a', 'D:/Code/app', [])], [{ a: 'a', b: 'ghost', path: 'x.ts', bucket: 1 }]),
      CHART_WIDTH,
    );
    expect(layout.connectors).toEqual([]);
  });

  it('puts a tick every ten buckets, labelled with the clock time', () => {
    const layout = layoutTimeline(timeline([]), CHART_WIDTH);
    expect(layout.ticks.map((tick) => tick.index)).toEqual([0, 10, 20, 30, 40, 50]);
    expect(layout.ticks[1].label).toBe('10:10');
  });

  it('draws no ticks when the window start cannot be read', () => {
    const broken = { ...timeline([]), startedAt: 'không rõ' };
    expect(layoutTimeline(broken, CHART_WIDTH).ticks).toEqual([]);
  });
});

describe('describeBucket', () => {
  it('returns the counts, intents, and files of one bucket', () => {
    const lanes = [
      lane('a', 'D:/Code/app', [
        bucket(2, { edit: 2, bash: 1 }, { intents: ['sửa login'], files: ['login.ts'] }),
      ]),
    ];
    const detail = describeBucket(timeline(lanes), lanes[0], 2);
    expect(detail).toMatchObject({
      counts: { edit: 2, bash: 1, read: 0, other: 0 },
      intents: ['sửa login'],
      files: ['login.ts'],
    });
    expect(detail?.range).toContain('10:02');
  });

  it('returns null for a bucket the lane does not have', () => {
    const lanes = [lane('a', 'D:/Code/app', [bucket(2, { edit: 1 })])];
    expect(describeBucket(timeline(lanes), lanes[0], 7)).toBeNull();
  });
});

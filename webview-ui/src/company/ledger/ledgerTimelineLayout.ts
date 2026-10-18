/**
 * Geometry for the activity timeline. Pure: one lane per session, 60 buckets across the
 * window, a dot per active bucket sized by its event count, shared-file connectors
 * between lanes, and tick marks. The view draws these numbers and handles pointer input.
 */

import type {
  LedgerTimeline,
  LedgerTimelineBucket,
  LedgerTimelineLane,
} from '../../../../core/src/messages.js';
import {
  fileName,
  formatClock,
  LEDGER_CATEGORIES,
  type LedgerCategory,
  parseLedgerTimestamp,
} from './ledgerFormat.js';

/** Every timeline window is drawn as this many buckets, whatever its length. */
export const TIMELINE_BUCKET_COUNT = 60;
export const TIMELINE_LANE_HEIGHT = 30;
export const TIMELINE_GROUP_HEIGHT = 24;

const TICK_EVERY = 10;
const DOT_MIN_RADIUS = 2;
const DOT_RADIUS_SCALE = 1.2;
const DOT_MAX_RADIUS = 8;

/** The colour token each category is drawn in. All four are on the contrast test's list. */
export const CATEGORY_TOKEN: Record<
  LedgerCategory,
  'accent' | 'status-active' | 'status-success' | 'idle'
> = {
  edit: 'accent',
  bash: 'status-active',
  read: 'status-success',
  other: 'idle',
};

export interface TimelineDot {
  index: number;
  x: number;
  r: number;
  category: LedgerCategory;
  total: number;
}

export interface TimelineLaneLayout {
  sessionId: string;
  agentName: string;
  repo: string | null;
  top: number;
  /** Vertical centre of the lane's line. */
  y: number;
  spamming: boolean;
  spamReason: string | null;
  dots: TimelineDot[];
}

export interface TimelineGroupLayout {
  key: string;
  label: string;
  top: number;
  height: number;
}

/** A dashed line between two lanes at one bucket: both sessions touched the same file then. */
export interface TimelineConnector {
  a: string;
  b: string;
  bucket: number;
  x: number;
  y1: number;
  y2: number;
  paths: string[];
  count: number;
}

export interface TimelineTick {
  index: number;
  x: number;
  label: string;
}

export interface TimelineLayout {
  width: number;
  height: number;
  groups: TimelineGroupLayout[];
  lanes: TimelineLaneLayout[];
  connectors: TimelineConnector[];
  ticks: TimelineTick[];
}

export interface BucketDetail {
  range: string;
  counts: Record<LedgerCategory, number>;
  intents: string[];
  files: string[];
}

export function bucketTotal(bucket: LedgerTimelineBucket): number {
  return bucket.edit + bucket.bash + bucket.read + bucket.other;
}

/** The category with the most events. Ties go to the earlier category in LEDGER_CATEGORIES. */
export function dominantCategory(bucket: LedgerTimelineBucket): LedgerCategory | null {
  let best: LedgerCategory | null = null;
  let bestCount = 0;
  for (const category of LEDGER_CATEGORIES) {
    if (bucket[category] > bestCount) {
      best = category;
      bestCount = bucket[category];
    }
  }
  return best;
}

/**
 * Dot radius for an event count. It grows with the square root of the count and is
 * capped, so one busy bucket cannot swallow its neighbours. Zero events draw nothing.
 */
export function dotRadius(count: number): number {
  if (count <= 0) return 0;
  return Math.min(DOT_MAX_RADIUS, DOT_MIN_RADIUS + DOT_RADIUS_SCALE * Math.sqrt(count));
}

/** The "HH:MM–HH:MM" span of one bucket, or '' when the window start is unreadable. */
export function bucketRange(timeline: LedgerTimeline, index: number): string {
  const startMs = parseLedgerTimestamp(timeline.startedAt);
  if (startMs === null) return '';
  const start = startMs + index * timeline.bucketSeconds * 1000;
  return `${formatClock(start)}–${formatClock(start + timeline.bucketSeconds * 1000)}`;
}

/** What hovering a dot shows: the bucket's span, counts per category, intents and files. */
export function describeBucket(
  timeline: LedgerTimeline,
  lane: LedgerTimelineLane,
  index: number,
): BucketDetail | null {
  const bucket = lane.buckets.find((item) => item.index === index);
  if (bucket === undefined) return null;
  return {
    range: bucketRange(timeline, index),
    counts: { edit: bucket.edit, bash: bucket.bash, read: bucket.read, other: bucket.other },
    intents: bucket.intents,
    files: bucket.files,
  };
}

/** Group heading: the repo's folder name, or a plain label for sessions with no repo. */
export function repoGroupLabel(repo: string | null): string {
  return repo === null ? 'Không rõ repo' : fileName(repo);
}

function dotsOf(buckets: readonly LedgerTimelineBucket[], chartWidth: number): TimelineDot[] {
  const dots: TimelineDot[] = [];
  for (const bucket of buckets) {
    const total = bucketTotal(bucket);
    const category = dominantCategory(bucket);
    if (total === 0 || category === null) continue;
    if (bucket.index < 0 || bucket.index >= TIMELINE_BUCKET_COUNT) continue;
    dots.push({
      index: bucket.index,
      x: ((bucket.index + 0.5) * chartWidth) / TIMELINE_BUCKET_COUNT,
      r: dotRadius(total),
      category,
      total,
    });
  }
  return dots;
}

export function layoutTimeline(timeline: LedgerTimeline, chartWidth: number): TimelineLayout {
  // Lanes group under their repo, in the order the server sent them.
  const groupsByRepo = new Map<string, { repo: string | null; lanes: LedgerTimelineLane[] }>();
  for (const lane of timeline.lanes) {
    const key = lane.repo ?? '';
    const group = groupsByRepo.get(key);
    if (group === undefined) groupsByRepo.set(key, { repo: lane.repo, lanes: [lane] });
    else group.lanes.push(lane);
  }

  const groups: TimelineGroupLayout[] = [];
  const lanes: TimelineLaneLayout[] = [];
  const centreOf = new Map<string, number>();
  let cursor = 0;
  for (const [key, group] of groupsByRepo) {
    groups.push({
      key,
      label: repoGroupLabel(group.repo),
      top: cursor,
      height: TIMELINE_GROUP_HEIGHT,
    });
    cursor += TIMELINE_GROUP_HEIGHT;
    for (const lane of group.lanes) {
      const y = cursor + TIMELINE_LANE_HEIGHT / 2;
      centreOf.set(lane.sessionId, y);
      lanes.push({
        sessionId: lane.sessionId,
        agentName: lane.agentName,
        repo: lane.repo,
        top: cursor,
        y,
        spamming: lane.spamming,
        spamReason: lane.spamReason,
        dots: dotsOf(lane.buckets, chartWidth),
      });
      cursor += TIMELINE_LANE_HEIGHT;
    }
  }

  const ticks: TimelineTick[] = [];
  const startMs = parseLedgerTimestamp(timeline.startedAt);
  if (startMs !== null) {
    for (let index = 0; index < TIMELINE_BUCKET_COUNT; index += TICK_EVERY) {
      ticks.push({
        index,
        x: (index * chartWidth) / TIMELINE_BUCKET_COUNT,
        label: formatClock(startMs + index * timeline.bucketSeconds * 1000),
      });
    }
  }

  // One connector per lane pair and bucket. Several shared files in the same bucket
  // add to its count instead of drawing a second line on top of the first.
  const connectors = new Map<string, TimelineConnector>();
  for (const shared of timeline.shared) {
    const first = centreOf.get(shared.a);
    const second = centreOf.get(shared.b);
    if (first === undefined || second === undefined || shared.a === shared.b) continue;
    if (shared.bucket < 0 || shared.bucket >= TIMELINE_BUCKET_COUNT) continue;
    const [a, b] = shared.a < shared.b ? [shared.a, shared.b] : [shared.b, shared.a];
    const key = `${a}|${b}|${shared.bucket}`;
    const existing = connectors.get(key);
    if (existing !== undefined) {
      existing.count += 1;
      if (!existing.paths.includes(shared.path)) existing.paths.push(shared.path);
      continue;
    }
    connectors.set(key, {
      a,
      b,
      bucket: shared.bucket,
      x: ((shared.bucket + 0.5) * chartWidth) / TIMELINE_BUCKET_COUNT,
      y1: Math.min(first, second),
      y2: Math.max(first, second),
      paths: [shared.path],
      count: 1,
    });
  }

  return {
    width: chartWidth,
    height: cursor,
    groups,
    lanes,
    connectors: [...connectors.values()],
    ticks,
  };
}

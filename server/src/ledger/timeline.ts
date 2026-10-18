/**
 * Timeline: pure bucketing of one window of ledger events into swim lanes.
 * Sixty buckets per window; only non-empty buckets are emitted. `session`
 * events are lifecycle noise and never count as calls.
 */

import type {
  LedgerSharedFile,
  LedgerSpamRule,
  LedgerTimeline,
  LedgerTimelineBucket,
  LedgerTimelineLane,
} from '../../../core/src/messages.js';
import {
  LEDGER_DEFAULT_AGENT_KIND,
  LEDGER_TIMELINE_BUCKETS,
  LEDGER_TIMELINE_LIST_MAX,
  LEDGER_TIMELINE_MAX_LANES,
  LEDGER_TIMELINE_MAX_SHARED,
} from './constants.js';
import type { EventRow } from './ledgerDb.js';
import { formatLedgerTime, parseLedgerTime } from './ledgerTime.js';
import { evaluateSpam, type SpamCall } from './spam.js';

export type TimelineCategory = 'edit' | 'bash' | 'read' | 'other';

const CATEGORY_BY_NAME: Record<string, TimelineCategory> = {
  edit: 'edit',
  write: 'edit',
  bash: 'bash',
  git: 'bash',
  read: 'read',
  grep: 'read',
  search: 'read',
  glob: 'read',
  find: 'read',
  ls: 'read',
};

/** Category of one event: `kind` decides when it names a category, else `tool`. */
export function toolCategory(kind: string | null, tool: string | null): TimelineCategory {
  for (const name of [kind, tool]) {
    if (name !== null && Object.hasOwn(CATEGORY_BY_NAME, name)) return CATEGORY_BY_NAME[name];
  }
  return 'other';
}

export interface TimelineEvent {
  readonly tMs: number;
  readonly sessionId: string;
  readonly kind: string;
  readonly tool: string | null;
  readonly path: string | null;
  readonly pathKey: string | null;
  readonly repo: string | null;
  readonly intent: string | null;
}

export interface TimelineSession {
  readonly sessionId: string;
  readonly agentKind: string | null;
  readonly agentName: string | null;
}

export interface TimelineInput {
  readonly windowMinutes: number;
  readonly nowMs: number;
  readonly events: readonly TimelineEvent[];
  readonly sessions: readonly TimelineSession[];
  readonly rule: LedgerSpamRule;
}

/** Converts an event row; null when its timestamp is unreadable. */
export function timelineEventOf(row: EventRow): TimelineEvent | null {
  const tMs = parseLedgerTime(row.ts);
  if (tMs === null) return null;
  return {
    tMs,
    sessionId: row.sessionId,
    kind: row.kind,
    tool: row.tool,
    path: row.path,
    pathKey: row.pathKey,
    repo: row.repo,
    intent: row.intent,
  };
}

interface BucketTally {
  edit: number;
  bash: number;
  read: number;
  other: number;
  readonly intents: Set<string>;
  readonly files: Set<string>;
}

interface LaneTally {
  readonly sessionId: string;
  repo: string | null;
  latestMs: number;
  total: number;
  readonly calls: SpamCall[];
  readonly buckets: Map<number, BucketTally>;
}

interface SharedCell {
  readonly index: number;
  readonly pathKey: string;
  readonly path: string;
  readonly sessions: Set<string>;
}

export function buildTimeline(input: TimelineInput): LedgerTimeline {
  const windowMs = input.windowMinutes * 60_000;
  const startMs = input.nowMs - windowMs;
  const bucketMs = windowMs / LEDGER_TIMELINE_BUCKETS;
  const bucketSeconds = (input.windowMinutes * 60) / LEDGER_TIMELINE_BUCKETS;
  const sessionMeta = new Map(
    input.sessions.map((session) => [session.sessionId, session] as const),
  );
  const lanes = new Map<string, LaneTally>();
  const cells = new Map<string, SharedCell>();

  const inWindow = input.events
    .filter((event) => event.kind !== 'session' && event.tMs >= startMs && event.tMs <= input.nowMs)
    .sort((a, b) => a.tMs - b.tMs);
  for (const event of inWindow) {
    const index = Math.min(
      LEDGER_TIMELINE_BUCKETS - 1,
      Math.floor((event.tMs - startMs) / bucketMs),
    );
    const category = toolCategory(event.kind, event.tool);

    let lane = lanes.get(event.sessionId);
    if (lane === undefined) {
      lane = {
        sessionId: event.sessionId,
        repo: null,
        latestMs: event.tMs,
        total: 0,
        calls: [],
        buckets: new Map<number, BucketTally>(),
      };
      lanes.set(event.sessionId, lane);
    }
    lane.total += 1;
    lane.latestMs = event.tMs;
    if (event.repo !== null && event.repo !== '') lane.repo = event.repo;
    lane.calls.push({ tMs: event.tMs, intent: event.intent });

    let bucket = lane.buckets.get(index);
    if (bucket === undefined) {
      bucket = {
        edit: 0,
        bash: 0,
        read: 0,
        other: 0,
        intents: new Set<string>(),
        files: new Set<string>(),
      };
      lane.buckets.set(index, bucket);
    }
    bucket[category] += 1;
    if (event.intent !== null && event.intent !== '') bucket.intents.add(event.intent);
    const file = event.path ?? event.pathKey;
    if (file !== null && file !== '') bucket.files.add(file);

    const sharedKey = event.pathKey ?? event.path;
    if (category === 'edit' && sharedKey !== null && sharedKey !== '') {
      const cellKey = `${index}\u0000${sharedKey}`;
      let cell = cells.get(cellKey);
      if (cell === undefined) {
        cell = {
          index,
          pathKey: sharedKey,
          path: event.path ?? sharedKey,
          sessions: new Set<string>(),
        };
        cells.set(cellKey, cell);
      }
      cell.sessions.add(event.sessionId);
    }
  }

  const shared: LedgerSharedFile[] = [];
  let sharedTruncated = false;
  const orderedCells = [...cells.values()].sort(
    (a, b) => a.index - b.index || a.pathKey.localeCompare(b.pathKey),
  );
  cellLoop: for (const cell of orderedCells) {
    const members = [...cell.sessions].sort((a, b) => a.localeCompare(b));
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        if (shared.length >= LEDGER_TIMELINE_MAX_SHARED) {
          sharedTruncated = true;
          break cellLoop;
        }
        shared.push({ a: members[i], b: members[j], path: cell.path, bucket: cell.index });
      }
    }
  }

  const laneList = [...lanes.values()].sort(
    (a, b) => b.latestMs - a.latestMs || a.sessionId.localeCompare(b.sessionId),
  );
  const outLanes = laneList
    .slice(0, LEDGER_TIMELINE_MAX_LANES)
    .map((lane) => laneView(lane, sessionMeta.get(lane.sessionId), input));

  return {
    windowMinutes: input.windowMinutes,
    bucketSeconds,
    startedAt: formatLedgerTime(startMs),
    endedAt: formatLedgerTime(input.nowMs),
    lanes: outLanes,
    shared,
    truncated: laneList.length > LEDGER_TIMELINE_MAX_LANES || sharedTruncated,
  };
}

function laneView(
  lane: LaneTally,
  meta: TimelineSession | undefined,
  input: TimelineInput,
): LedgerTimelineLane {
  const verdict = evaluateSpam(lane.calls, input.rule);
  const buckets: LedgerTimelineBucket[] = [...lane.buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([index, tally]) => ({
      index,
      edit: tally.edit,
      bash: tally.bash,
      read: tally.read,
      other: tally.other,
      intents: [...tally.intents].slice(0, LEDGER_TIMELINE_LIST_MAX),
      files: [...tally.files].slice(0, LEDGER_TIMELINE_LIST_MAX),
    }));
  return {
    sessionId: lane.sessionId,
    agentKind: meta?.agentKind ?? LEDGER_DEFAULT_AGENT_KIND,
    agentName: meta?.agentName ?? '',
    repo: lane.repo,
    spamming: verdict.spamming,
    spamReason: verdict.reason,
    total: lane.total,
    buckets,
  };
}

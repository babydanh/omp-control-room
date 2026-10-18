/**
 * LedgerTimelineTab: one swimlane per session, grouped by repo, over the chosen window.
 * ledgerTimelineLayout.ts places every dot and connector; this file draws them, shows
 * the hover tooltip, and re-requests the timeline every POLL_MS while it is on screen.
 */

import { useEffect, useRef, useState } from 'react';

import type { LedgerTimeline } from '../../../../core/src/messages.js';
import { Icon } from '../components/Icon.js';
import { useElementWidth } from '../useElementWidth.js';
import { ledgerStore } from './ledgerClient.js';
import { categoryLabel, LEDGER_CATEGORIES, LEDGER_WINDOWS, windowLabel } from './ledgerFormat.js';
import type { LedgerSelection } from './ledgerSelection.js';
import type { LedgerState } from './ledgerStore.js';
import {
  bucketRange,
  CATEGORY_TOKEN,
  describeBucket,
  layoutTimeline,
  TIMELINE_LANE_HEIGHT,
  type TimelineLayout,
} from './ledgerTimelineLayout.js';

/** Width of the lane label column, in px. */
const LABEL_WIDTH = 150;
/** Padding the chart keeps around itself, both sides together. */
const CHART_INSET = 20;
const MIN_CHART_WIDTH = 240;
const TICK_ROW_HEIGHT = 18;
const POLL_MS = 10_000;
const TOOLTIP_WIDTH = 240;
const TOOLTIP_LIST_LIMIT = 3;

export interface LedgerTimelineTabProps {
  ledger: LedgerState;
  selection: LedgerSelection | null;
  onSelect: (selection: LedgerSelection) => void;
}

interface Hover {
  sessionId: string;
  index: number;
  x: number;
  y: number;
}

export function LedgerTimelineTab({ ledger, selection, onSelect }: LedgerTimelineTabProps) {
  const ref = useRef<HTMLDivElement>(null);
  const measured = useElementWidth(ref, 'ledger-timeline');
  const [hover, setHover] = useState<Hover | null>(null);
  const windowMinutes = ledger.timelineWindow;
  const connection = ledger.connection;

  // Requested again after each reconnect, since the old socket may have dropped the reply.
  useEffect(() => {
    ledgerStore.requestTimeline(windowMinutes);
    const timer = setInterval(() => ledgerStore.requestTimeline(windowMinutes), POLL_MS);
    return () => clearInterval(timer);
  }, [windowMinutes, connection]);

  // A reply for another window is ignored by the store; a stale one is never drawn here.
  const timeline =
    ledger.timeline !== null && ledger.timeline.windowMinutes === windowMinutes
      ? ledger.timeline
      : null;
  const chartWidth = Math.max(measured - LABEL_WIDTH - CHART_INSET, MIN_CHART_WIDTH);

  return (
    <div className="flex flex-col gap-2">
      <div role="group" aria-label="Khoảng thời gian" className="flex flex-wrap gap-1.5">
        {LEDGER_WINDOWS.map((minutes) => (
          <button
            key={minutes}
            type="button"
            aria-pressed={minutes === windowMinutes}
            onClick={() => ledgerStore.requestTimeline(minutes)}
            className="company-toggle touch-target"
          >
            {windowLabel(minutes)}
          </button>
        ))}
      </div>
      {ledger.timelineError !== null && (
        <p role="alert" className="text-2xs text-danger">
          {ledger.timelineError}
        </p>
      )}
      <div ref={ref} className="overflow-x-auto rounded-(--company-radius-md) bg-panel p-2.5">
        {timeline === null ? (
          <p className="text-2xs text-text-muted">Đang tải dòng thời gian…</p>
        ) : (
          <TimelineCanvas
            timeline={timeline}
            layout={layoutTimeline(timeline, chartWidth)}
            selection={selection}
            hover={hover}
            onHover={setHover}
            onSelect={onSelect}
          />
        )}
      </div>
      <Legend />
    </div>
  );
}

interface TimelineCanvasProps {
  timeline: LedgerTimeline;
  layout: TimelineLayout;
  selection: LedgerSelection | null;
  hover: Hover | null;
  onHover: (hover: Hover | null) => void;
  onSelect: (selection: LedgerSelection) => void;
}

function TimelineCanvas({
  timeline,
  layout,
  selection,
  hover,
  onHover,
  onSelect,
}: TimelineCanvasProps) {
  if (layout.lanes.length === 0) {
    return <p className="text-2xs text-text-muted">Không có hoạt động trong khoảng này.</p>;
  }

  const hoverLane =
    hover === null ? undefined : timeline.lanes.find((lane) => lane.sessionId === hover.sessionId);
  const hoverDetail =
    hover === null || hoverLane === undefined
      ? null
      : describeBucket(timeline, hoverLane, hover.index);

  return (
    <div
      className="relative"
      style={{ width: LABEL_WIDTH + layout.width, height: layout.height + TICK_ROW_HEIGHT }}
    >
      {layout.groups.map((group) => (
        <div
          key={group.key}
          className="absolute left-0 flex items-center truncate text-2xs text-text-secondary"
          style={{ top: group.top, height: group.height, width: LABEL_WIDTH + layout.width }}
        >
          {group.label}
        </div>
      ))}
      {layout.lanes.map((lane) =>
        lane.spamming ? (
          <div
            key={`${lane.sessionId}-band`}
            aria-hidden="true"
            className="pointer-events-none absolute rounded-(--company-radius-sm) bg-danger/14"
            style={{
              left: LABEL_WIDTH,
              top: lane.top,
              height: TIMELINE_LANE_HEIGHT,
              width: layout.width,
            }}
          />
        ) : null,
      )}
      <svg
        aria-hidden="true"
        className="pointer-events-none absolute top-0"
        style={{ left: LABEL_WIDTH }}
        width={layout.width}
        height={layout.height}
      >
        {layout.connectors.map((connector) => (
          <line
            key={`${connector.a}|${connector.b}|${connector.bucket}`}
            x1={connector.x}
            x2={connector.x}
            y1={connector.y1}
            y2={connector.y2}
            stroke="var(--color-warning)"
            strokeWidth={2}
            strokeDasharray="3 3"
          >
            <title>{connector.paths.join('\n')}</title>
          </line>
        ))}
      </svg>
      {layout.lanes.map((lane) => {
        const selected = selection?.kind === 'session' && selection.sessionId === lane.sessionId;
        return (
          <div key={lane.sessionId}>
            <button
              type="button"
              aria-pressed={selected}
              onClick={() => onSelect({ kind: 'session', sessionId: lane.sessionId })}
              className={`absolute flex items-center gap-1 truncate rounded-(--company-radius-sm) px-1 text-left text-xs text-text hover:bg-hover ${selected ? 'bg-selected' : ''}`}
              style={{
                left: 0,
                top: lane.top,
                height: TIMELINE_LANE_HEIGHT,
                width: LABEL_WIDTH - 8,
              }}
            >
              <span className="truncate">{lane.agentName}</span>
              {lane.spamming && (
                <span
                  className="flex shrink-0 items-center gap-0.5 text-2xs text-danger"
                  title={lane.spamReason ?? undefined}
                >
                  <Icon name="alert-triangle" />
                  spam
                </span>
              )}
            </button>
            <div
              aria-hidden="true"
              className="pointer-events-none absolute h-px bg-hairline"
              style={{ left: LABEL_WIDTH, top: lane.y, width: layout.width }}
            />
            {lane.dots.map((dot) => {
              const range = bucketRange(timeline, dot.index);
              return (
                <button
                  key={dot.index}
                  type="button"
                  aria-label={`${lane.agentName}, ${range}: ${dot.total} sự kiện`}
                  onMouseEnter={() =>
                    onHover({
                      sessionId: lane.sessionId,
                      index: dot.index,
                      x: LABEL_WIDTH + dot.x,
                      y: lane.y,
                    })
                  }
                  onFocus={() =>
                    onHover({
                      sessionId: lane.sessionId,
                      index: dot.index,
                      x: LABEL_WIDTH + dot.x,
                      y: lane.y,
                    })
                  }
                  onMouseLeave={() => onHover(null)}
                  onBlur={() => onHover(null)}
                  className="absolute -translate-x-1/2 -translate-y-1/2 rounded-full"
                  style={{
                    left: LABEL_WIDTH + dot.x,
                    top: lane.y,
                    width: dot.r * 2,
                    height: dot.r * 2,
                    background: `var(--color-${CATEGORY_TOKEN[dot.category]})`,
                  }}
                />
              );
            })}
          </div>
        );
      })}
      {layout.ticks.map((tick) => (
        <span
          key={tick.index}
          className="absolute text-2xs text-text-muted"
          style={{ left: LABEL_WIDTH + tick.x, top: layout.height + 2 }}
        >
          {tick.label}
        </span>
      ))}
      {hover !== null && hoverLane !== undefined && hoverDetail !== null && (
        <div
          role="tooltip"
          className="pointer-events-none absolute z-10 rounded-(--company-radius-sm) bg-hover p-2 text-2xs text-text"
          style={{
            left: Math.max(0, Math.min(hover.x + 10, LABEL_WIDTH + layout.width - TOOLTIP_WIDTH)),
            top: hover.y + 12,
            width: TOOLTIP_WIDTH,
          }}
        >
          <p className="text-text">
            {hoverLane.agentName} · {hoverDetail.range}
          </p>
          {LEDGER_CATEGORIES.map((category) =>
            hoverDetail.counts[category] > 0 ? (
              <p key={category} className="text-text-secondary">
                {categoryLabel(category)}: {hoverDetail.counts[category]}
              </p>
            ) : null,
          )}
          {hoverDetail.intents.slice(0, TOOLTIP_LIST_LIMIT).map((intent) => (
            <p key={intent} className="truncate text-text-muted">
              {intent}
            </p>
          ))}
          {hoverDetail.files.slice(0, TOOLTIP_LIST_LIMIT).map((file) => (
            <p key={file} className="truncate text-text-muted">
              {file}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

function Legend() {
  return (
    <div className="flex flex-wrap items-center gap-3 text-2xs text-text-muted">
      {LEDGER_CATEGORIES.map((category) => (
        <span key={category} className="flex items-center gap-1">
          <span
            aria-hidden="true"
            className="size-2 rounded-full"
            style={{ background: `var(--color-${CATEGORY_TOKEN[category]})` }}
          />
          {categoryLabel(category)}
        </span>
      ))}
      <span className="flex items-center gap-1">
        <svg aria-hidden="true" width="16" height="4">
          <line
            x1="0"
            y1="2"
            x2="16"
            y2="2"
            stroke="var(--color-warning)"
            strokeWidth={2}
            strokeDasharray="3 3"
          />
        </svg>
        tệp dùng chung
      </span>
      <span className="flex items-center gap-1">
        <span aria-hidden="true" className="size-2 rounded-full bg-danger/14" />
        spam
      </span>
      <span>Mỗi chấm là một khoảng thời gian; chấm càng lớn, càng nhiều sự kiện.</span>
    </div>
  );
}

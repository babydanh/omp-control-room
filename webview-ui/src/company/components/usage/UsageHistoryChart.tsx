/**
 * UsageHistoryChart: one account's limit share over the chosen window, drawn as an inline SVG
 * line. The x axis runs from the window's start to the server's report time, so every chart on the
 * page shares one time scale. Reset points are ticks. Hovering or tapping names a sample's value
 * and time; with no pointer on the chart, the newest sample is named.
 */

import { type PointerEvent, useState } from 'react';

import { formatPercent } from '../../usage/usageFormat.js';
import {
  downsampleSeries,
  type HistoryPoint,
  type HistorySeries,
  nearestPoint,
  seriesPath,
} from '../../usage/usageHistory.js';
import { WHEN_FORMAT } from './usageTime.js';

/** The drawing space; the SVG stretches to the card's width. */
const VIEW_W = 1000;
const VIEW_H = 100;
/** The most samples drawn and searched; a longer series keeps its peaks and resets. */
const MAX_POINTS = 240;

interface UsageHistoryChartProps {
  series: HistorySeries;
  sinceMs: number;
  endMs: number;
}

export function UsageHistoryChart({ series, sinceMs, endMs }: UsageHistoryChartProps) {
  const [hovered, setHovered] = useState<HistoryPoint | null>(null);
  const points = downsampleSeries(series.points, MAX_POINTS);
  const first = points[0];
  const latest = points[points.length - 1];
  if (first === undefined || latest === undefined) return null;

  const windowMs = endMs - sinceMs;
  const spanMs = latest.at - first.at;
  const drawable = windowMs > 0 && spanMs > 0 && points.length > 1;
  const scaleX = drawable ? spanMs / windowMs : 0;
  // The y axis runs 0 to the larger of 100% and the highest share, as seriesPath draws it.
  const top = points.reduce((max, point) => Math.max(max, point.usedFraction), 1);
  const xOf = (at: number): number => (windowMs > 0 ? ((at - sinceMs) / windowMs) * VIEW_W : 0);
  const yOf = (fraction: number): number => VIEW_H * (1 - fraction / top);
  const resets = points.filter((point) => point.reset);

  const readPointer = (event: PointerEvent<HTMLDivElement>): void => {
    const rect = event.currentTarget.getBoundingClientRect();
    const share = rect.width > 0 ? (event.clientX - rect.left) / rect.width : 0;
    const atMs = sinceMs + Math.min(Math.max(share, 0), 1) * windowMs;
    const along = spanMs > 0 ? (atMs - first.at) / spanMs : 0;
    setHovered(nearestPoint(points, Math.min(Math.max(along, 0), 1)) ?? null);
  };

  const clearHover = (event: PointerEvent<HTMLDivElement>): void => {
    if (event.pointerType === 'mouse') setHovered(null);
  };

  const reading = hovered ?? latest;
  const readingText = `${formatPercent(reading.usedFraction)} lúc ${WHEN_FORMAT.format(reading.at)}${
    reading.reset ? ' · đã đặt lại' : ''
  }`;

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-2 text-xs">
        <span className="min-w-0 truncate text-text">
          {series.email ?? series.accountKey} · {series.label}
        </span>
        <span className="shrink-0 text-2xs text-text-muted">{series.provider}</span>
      </div>
      <p className="text-2xs tabular-nums text-text-secondary" aria-live="polite">
        {hovered === null ? 'Mới nhất: ' : ''}
        {readingText}
      </p>
      <div
        className="relative h-14 w-full touch-pan-y overflow-hidden rounded-(--company-radius-sm) bg-well"
        onPointerMove={readPointer}
        onPointerDown={readPointer}
        onPointerLeave={clearHover}
      >
        <svg
          viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={`Biểu đồ ${series.label}`}
          className="block h-full w-full"
        >
          <line
            x1={0}
            x2={VIEW_W}
            y1={yOf(1)}
            y2={yOf(1)}
            stroke="currentColor"
            strokeDasharray="4 4"
            vectorEffect="non-scaling-stroke"
            opacity={0.5}
            className="text-text-muted"
          />
          {resets.map((point) => (
            <line
              key={point.at}
              x1={xOf(point.at)}
              x2={xOf(point.at)}
              y1={0}
              y2={VIEW_H}
              stroke="currentColor"
              vectorEffect="non-scaling-stroke"
              className="text-text-muted"
            />
          ))}
          {drawable ? (
            <g transform={`translate(${xOf(first.at)} 0) scale(${scaleX} 1)`}>
              <path
                d={seriesPath(points, { width: VIEW_W, height: VIEW_H })}
                fill="none"
                stroke="currentColor"
                strokeWidth={1.5}
                vectorEffect="non-scaling-stroke"
                className="text-status-active"
              />
            </g>
          ) : (
            <rect
              x={xOf(first.at) - 4}
              y={yOf(first.usedFraction) - 4}
              width={8}
              height={8}
              fill="currentColor"
              className="text-status-active"
            />
          )}
          {hovered !== null && (
            <line
              x1={xOf(hovered.at)}
              x2={xOf(hovered.at)}
              y1={0}
              y2={VIEW_H}
              stroke="currentColor"
              vectorEffect="non-scaling-stroke"
              className="text-text-secondary"
            />
          )}
        </svg>
      </div>
    </div>
  );
}

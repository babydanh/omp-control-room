/**
 * UsageTimeChart: tokens per time bucket as bars, with the reported cost as a line over the same
 * buckets. Both are inline SVG. The SVG holds no text; the scale maxima and the window ends are
 * written beside it.
 */

import type { UsageStatsTimePoint } from '../../../../../core/src/messages.js';
import { formatTokens, formatUsd } from '../../usage/usageFormat.js';
import { timeSeriesPoints } from '../../usage/usageStats.js';
import { WHEN_FORMAT } from './usageTime.js';

const VIEW_W = 1000;
const VIEW_H = 120;
/** A bucket's bar takes this share of its slot; the rest is the gap between bars. */
const BAR_SHARE = 0.7;

export function UsageTimeChart({ points }: { points: readonly UsageStatsTimePoint[] }) {
  const timed = timeSeriesPoints(points);
  const first = timed[0];
  const last = timed[timed.length - 1];
  if (first === undefined || last === undefined) {
    return <p className="text-xs text-text-muted">Chưa có dữ liệu theo giờ.</p>;
  }

  const maxTokens = timed.reduce((max, point) => Math.max(max, point.tokens), 0);
  const maxCost = timed.reduce((max, point) => Math.max(max, point.cost), 0);
  const slot = VIEW_W / timed.length;
  const barWidth = slot * BAR_SHARE;
  const bars = timed.map((point, index) => {
    const height = maxTokens > 0 ? (point.tokens / maxTokens) * VIEW_H : 0;
    return (
      <rect
        key={point.at}
        x={index * slot + (slot - barWidth) / 2}
        y={VIEW_H - height}
        width={barWidth}
        height={height}
      />
    );
  });
  const costLine = timed
    .map((point, index) => {
      const y = VIEW_H - (maxCost > 0 ? (point.cost / maxCost) * VIEW_H : 0);
      return `${(index + 0.5) * slot},${y}`;
    })
    .join(' ');

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-2xs text-text-muted">
        <span>Cột: token, cao nhất {formatTokens(maxTokens)}</span>
        <span>Đường: chi phí đã báo cáo, cao nhất {formatUsd(maxCost)}</span>
      </div>
      <div className="h-32 w-full overflow-hidden rounded-(--company-radius-sm) bg-well">
        <svg
          viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
          preserveAspectRatio="none"
          role="img"
          aria-label="Token và chi phí theo giờ"
          className="block h-full w-full"
        >
          <g className="text-accent" fill="currentColor" opacity={0.6}>
            {bars}
          </g>
          {maxCost > 0 && (
            <polyline
              points={costLine}
              fill="none"
              stroke="currentColor"
              strokeWidth={1.5}
              vectorEffect="non-scaling-stroke"
              className="text-caution"
            />
          )}
        </svg>
      </div>
      <div className="flex justify-between text-2xs tabular-nums text-text-muted">
        <span>{WHEN_FORMAT.format(first.at)}</span>
        <span>{WHEN_FORMAT.format(last.at)}</span>
      </div>
    </div>
  );
}

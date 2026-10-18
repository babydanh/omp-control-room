/**
 * ActivityCounts: how many agents are working, waiting on the user, idle, and
 * failed (only when there are some), across companies and herdr. The sidebar
 * draws them as chips under its title; the collapsed rail draws them as a stack.
 */

import { ACTIVITY_LABELS, type ActivityCounts } from '../agentSidebarView.js';
import { StatusDot } from './StatusDot.js';

type ActivityKey = keyof ActivityCounts;

/** The order the counts read in: what moves, what needs you, what rests, what failed. */
const ACTIVITY_KEYS: readonly ActivityKey[] = ['working', 'needs', 'idle', 'error'];

/** A clean board shows three counts; the failed count joins only when there is one. */
function shownKeys(counts: ActivityCounts): ActivityKey[] {
  return ACTIVITY_KEYS.filter((key) => key !== 'error' || counts[key] > 0);
}

export function ActivityChips({ counts }: { counts: ActivityCounts }) {
  return (
    <p
      aria-label="Tóm tắt hoạt động"
      data-testid="activity-counts"
      className="flex flex-wrap gap-x-3 gap-y-1 border-b border-border px-2.5 py-1.5 text-2xs text-text-muted"
    >
      {shownKeys(counts).map((key) => (
        <span key={key} className="inline-flex items-center gap-1.5">
          <StatusDot tone={key} />
          <span className="font-mono text-text">{counts[key]}</span>
          <span>{ACTIVITY_LABELS[key]}</span>
        </span>
      ))}
    </p>
  );
}

export function ActivityStack({ counts }: { counts: ActivityCounts }) {
  return (
    <div
      data-testid="rail-counts"
      className="flex flex-col items-center gap-1 border-b border-border px-1 py-2 text-2xs"
    >
      {shownKeys(counts).map((key) => (
        <span
          key={key}
          title={`${ACTIVITY_LABELS[key]}: ${counts[key]}`}
          className="inline-flex items-center gap-1 font-mono text-text"
        >
          <StatusDot tone={key} />
          {counts[key]}
        </span>
      ))}
    </div>
  );
}

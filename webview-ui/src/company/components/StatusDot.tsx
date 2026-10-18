/**
 * StatusDot: the one-glyph status mark the sidebar rows share. Working is a
 * braille spinner, a thing waiting on the user breathes red, and the rest are
 * still dots. Reduced motion freezes both (index.css).
 */

import type { AgentTone } from '../agentSidebarView.js';
import type { HerdrTone } from '../herdrView.js';

export type DotTone = AgentTone | HerdrTone;

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;
// The first frame is repeated at the end, so the looping step lands on a frame
// identical to the start and the spinner never visibly jumps back.
const SPINNER_COLUMN: readonly string[] = [...SPINNER_FRAMES, SPINNER_FRAMES[0]];

const DOT_CLASS: Readonly<Record<Exclude<DotTone, 'working'>, string>> = {
  needs: 'bg-warning company-breathe',
  idle: 'bg-idle',
  error: 'bg-danger',
  done: 'bg-status-success',
  parked: 'border border-text-muted bg-transparent',
  unknown: 'bg-idle opacity-60',
};

export function Spinner() {
  return (
    <span aria-hidden="true" className="company-spinner text-accent">
      <span className="company-spinner-track">
        {SPINNER_COLUMN.map((frame, index) => (
          <span key={index}>{frame}</span>
        ))}
      </span>
    </span>
  );
}

export function StatusDot({ tone }: { tone: DotTone }) {
  if (tone === 'working') return <Spinner />;
  return (
    <span
      aria-hidden="true"
      className={`inline-block h-2 w-2 shrink-0 rounded-full ${DOT_CLASS[tone]}`}
    />
  );
}

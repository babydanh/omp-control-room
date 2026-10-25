/**
 * StatusDot: the one-glyph status mark the sidebar rows share. Working is the
 * session face glancing about (the same character as the project tree), a thing
 * waiting on the user breathes red, and the rest are still dots. Reduced motion
 * freezes both.
 */

import type { AgentTone } from '../agentSidebarView.js';
import type { HerdrTone } from '../herdrView.js';
import { SessionFace } from '../projects/SessionFace.js';

export type DotTone = AgentTone | HerdrTone;

/** The working face's colour: the green the board uses for work in progress. */
const WORKING_FACE_HUE = 160;

const DOT_CLASS: Readonly<Record<Exclude<DotTone, 'working'>, string>> = {
  needs: 'bg-warning company-breathe',
  idle: 'bg-idle',
  error: 'bg-danger',
  done: 'bg-status-success',
  parked: 'bg-text-muted/40',
  unknown: 'bg-idle',
};

/** The small "working" mark: a face at text size, eyes glancing left and right. */
export function Spinner() {
  return <SessionFace mood="work" hue={WORKING_FACE_HUE} size="sm" />;
}

export function StatusDot({ tone }: { tone: DotTone }) {
  if (tone === 'working') return <Spinner />;
  return (
    <span
      aria-hidden="true"
      className={`company-dot inline-block h-2 w-2 shrink-0 rounded-full ${DOT_CLASS[tone]}`}
    />
  );
}

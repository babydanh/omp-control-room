import './SessionFace.css';

import type { CSSProperties } from 'react';

import type { SessionFaceMood } from './projectTreeView.js';

/**
 * A session's little face in the tree: a rounded square in the session's own colour with two eyes.
 * Asleep the eyes are shut, at work they glance from side to side, at rest they blink now and then.
 * Pure CSS, so a long list of faces costs nothing; the hue also staggers the animations.
 */
export function SessionFace({ mood, hue }: { mood: SessionFaceMood; hue: number }) {
  const style = { '--face-hue': hue, '--face-delay': `${-(hue % 7)}s` } as CSSProperties;
  return (
    <span aria-hidden="true" className="session-face" data-mood={mood} style={style}>
      <span className="session-face__eyes">
        <span className="session-face__eye" />
        <span className="session-face__eye" />
      </span>
    </span>
  );
}

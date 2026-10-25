import './SessionFace.css';

import type { CSSProperties } from 'react';

import type { SessionFaceMood } from './projectTreeView.js';

/**
 * A session's little face in the tree: a soft rounded square in the session's own colour with two
 * eyes. Each eye is an open lid and a closed arc stacked on one another, so moving between moods
 * cross-fades instead of jumping. Pure CSS (transform and opacity only), so a long list costs nothing;
 * the hue staggers the loops so no two faces blink together.
 */
export function SessionFace({ mood, hue }: { mood: SessionFaceMood; hue: number }) {
  const style = { '--face-hue': hue, '--face-delay': `${-((hue % 37) / 10)}s` } as CSSProperties;
  return (
    <span aria-hidden="true" className="session-face" data-mood={mood} style={style}>
      <span className="session-face__body">
        <span className="session-face__eyes">
          <span className="session-face__eye session-face__eye--left">
            <span className="session-face__lid" />
            <span className="session-face__shut" />
          </span>
          <span className="session-face__eye session-face__eye--right">
            <span className="session-face__lid" />
            <span className="session-face__shut" />
          </span>
        </span>
      </span>
      {/* The mood's mark: a drifting "z" asleep, a bobbing "!" when the session waits on you. */}
      <span className="session-face__mark" />
    </span>
  );
}

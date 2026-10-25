import './SessionFace.css';

import { type CSSProperties, useEffect, useRef, useState } from 'react';

import { finishedTurn, SESSION_FACE_CHEER_MS, type SessionFaceMood, shownFaceMood } from './projectTreeView.js';

/**
 * A session's little face in the tree: a soft rounded square in the session's own colour with two
 * eyes. Each eye is an open lid and a closed arc stacked on one another, so moving between moods
 * cross-fades instead of jumping. Pure CSS (transform and opacity only), so a long list costs nothing;
 * the hue staggers the loops so no two faces blink together. When a session finishes a turn (it was
 * working and now rests), the face cheers "^ ^" for a moment before settling.
 */
export function SessionFace({ mood, hue }: { mood: SessionFaceMood; hue: number }) {
  const previous = useRef(mood);
  const [cheering, setCheering] = useState(false);

  // Every mood change decides the cheer afresh: a finished turn starts it, anything else ends it.
  // Deferred a tick, so the state change follows the mood change rather than sitting in its render.
  useEffect(() => {
    const was = previous.current;
    previous.current = mood;
    const cheer = finishedTurn(was, mood);
    const decide = window.setTimeout(() => setCheering(cheer), 0);
    return () => window.clearTimeout(decide);
  }, [mood]);

  // The cheer ends on its own clock, which no mood change can cancel and leave it standing.
  useEffect(() => {
    if (!cheering) return undefined;
    const stop = window.setTimeout(() => setCheering(false), SESSION_FACE_CHEER_MS);
    return () => window.clearTimeout(stop);
  }, [cheering]);

  const style = { '--face-hue': hue, '--face-delay': `${-((hue % 37) / 10)}s` } as CSSProperties;
  return (
    <span aria-hidden="true" className="session-face" data-mood={shownFaceMood(mood, cheering)} style={style}>
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
      {/* The mood's mark: a drifting "z" asleep, a bobbing "!" waiting on you, a sparkle when done. */}
      <span className="session-face__mark" />
    </span>
  );
}

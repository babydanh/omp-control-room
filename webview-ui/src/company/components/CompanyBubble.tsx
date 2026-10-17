/**
 * CompanyBubble: the company counterpart of the office's per-agent overlay.
 *
 * PRESENTATION ONLY. What a bubble says, and in what order, is decided by
 * `companyBubble.ts`; where it sits is decided by the same projection every
 * other overlay uses, so a company bubble cannot drift a pixel away from the
 * character it belongs to. Clicking one opens the real session in the drawer —
 * the bubble is a signpost, never a second copy of the terminal.
 *
 * Deltas already arrive batched (COMPANY_TEXT_BATCH_MS), so this re-renders at
 * most ten times a second no matter how fast the model writes.
 */

import { useEffect, useMemo, useRef, useState } from 'react';

import type { Question } from '../../../../core/src/company.js';
import { Button } from '../../components/ui/Button.js';
import { CHARACTER_SITTING_OFFSET_PX } from '../../constants.js';
import type { OfficeState } from '../../office/engine/officeState.js';
import { overlayProjection } from '../../office/projection.js';
import { CharacterState } from '../../office/types.js';
import type { CompanyBubbleView } from '../companyBubble.js';
import { COMPANY_BUBBLE_TONE_COLOR, companyBubbleView } from '../companyBubble.js';
import type { CompanyCharacterLayer } from '../companyCharacters.js';
import type { CompanyClient } from '../companyClient.js';
import {
  COMPANY_BUBBLE_FADE_MS,
  COMPANY_BUBBLE_MAX_WIDTH_PX,
  COMPANY_BUBBLE_RISE_WORLD,
  COMPANY_BUBBLE_STACK_STEP_PX,
  COMPANY_BUBBLE_Z_INDEX,
} from '../constants.js';
import { useCompanyState } from '../useCompanyState.js';

export interface CompanyBubbleProps {
  client: CompanyClient;
  /** The sessionId -> character id map the office was built from. */
  characters: CompanyCharacterLayer;
  officeState: OfficeState;
  containerRef: React.RefObject<HTMLDivElement | null>;
  zoom: number;
  panRef: React.RefObject<{ x: number; y: number }>;
  /** Mirrors the office's own overlay preference: with it on, every company
   *  character carries a panel instead of only the one under the cursor. */
  alwaysShowOverlay: boolean;
}

interface PlacedBubble extends CompanyBubbleView {
  sessionId: string;
  characterId: number;
  screenX: number;
  screenY: number;
  row: number;
  selected: boolean;
}

/**
 * Greedy stacking: each bubble takes the lowest row whose previous bubble on
 * that row ends before this one starts. Deterministic in character order, so
 * the same office always stacks the same way and nothing jitters frame to frame.
 */
function stackRows(placed: PlacedBubble[], halfWidth: number): void {
  const rightEdges: number[] = [];
  for (const bubble of placed) {
    let row = rightEdges.findIndex((edge) => bubble.screenX >= edge);
    if (row === -1) {
      row = rightEdges.length;
      rightEdges.push(0);
    }
    rightEdges[row] = bubble.screenX + halfWidth;
    bubble.row = row;
  }
}

export function CompanyBubble({
  client,
  characters,
  officeState,
  containerRef,
  zoom,
  panRef,
  alwaysShowOverlay,
}: CompanyBubbleProps) {
  const state = useCompanyState(client);
  // The seq each session's output bubble faded out at. A delta with a newer seq
  // re-shows it; the same seq stays hidden, so an idle session does not flicker
  // back into view on every unrelated company message.
  const fadedSeq = useRef<Record<string, number>>({});
  const [liveSeq, setLiveSeq] = useState<Record<string, number>>({});

  useEffect(() => {
    const live: Record<string, number> = {};
    for (const [sessionId, stream] of Object.entries(state.streams)) {
      if (stream.seq > 0 && stream.seq > (fadedSeq.current[sessionId] ?? 0)) {
        live[sessionId] = stream.seq;
      }
    }
    const ids = Object.keys(live);
    if (ids.length === 0) return undefined;
    setLiveSeq(live);
    const timer = setTimeout(() => {
      fadedSeq.current = { ...fadedSeq.current, ...live };
      setLiveSeq((previous) => {
        const next = { ...previous };
        for (const id of ids) delete next[id];
        return next;
      });
    }, COMPANY_BUBBLE_FADE_MS);
    return () => clearTimeout(timer);
  }, [state.streams]);

  // The office's camera moves on its own (follow, wander, pan), so the overlay
  // is positioned during a rAF tick exactly like the office's other overlays
  // rather than only when a message arrives.
  const [, setTick] = useState(0);
  useEffect(() => {
    let rafId = 0;
    const loop = () => {
      setTick((n) => n + 1);
      rafId = requestAnimationFrame(loop);
    };
    rafId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafId);
  }, []);

  const pendingBySession = useMemo(() => {
    const pending: Record<string, Question> = {};
    for (const question of Object.values(state.questions)) {
      if (question.status === 'pending') pending[question.sessionId] = question;
    }
    return pending;
  }, [state.questions]);

  const el = containerRef.current;
  if (!el) return null;
  const project = overlayProjection(
    officeState.getLayout(),
    el.getBoundingClientRect(),
    zoom,
    panRef.current,
    window.devicePixelRatio || 1,
  );

  const placed: PlacedBubble[] = [];
  for (const { sessionId, characterId } of characters.mappedCharacters()) {
    const character = officeState.characters.get(characterId);
    const session = state.sessions[sessionId];
    if (!character || !session) continue;
    const selected = state.selection.sessionId === sessionId;
    const hovered = officeState.hoveredAgentId === characterId;
    const view = companyBubbleView(
      session,
      state.streams[sessionId],
      pendingBySession[sessionId] ?? null,
      liveSeq[sessionId] !== undefined,
      alwaysShowOverlay || selected || hovered,
    );
    if (!view) continue;
    const sitting = character.state === CharacterState.TYPE ? CHARACTER_SITTING_OFFSET_PX : 0;
    placed.push({
      ...view,
      sessionId,
      characterId,
      screenX: project.toScreenX(character.x),
      screenY: project.toScreenY(character.y + sitting - COMPANY_BUBBLE_RISE_WORLD),
      row: 0,
      selected,
    });
  }
  stackRows(placed, COMPANY_BUBBLE_MAX_WIDTH_PX / 2);

  return (
    <>
      {placed.map((bubble) => (
        <div
          key={bubble.characterId}
          className="office-ui absolute flex -translate-x-1/2 flex-col items-center"
          style={{
            left: bubble.screenX,
            top: bubble.screenY - bubble.row * COMPANY_BUBBLE_STACK_STEP_PX,
            zIndex: COMPANY_BUBBLE_Z_INDEX,
          }}
          data-testid="company-bubble"
          data-company-session={bubble.sessionId}
          data-company-tone={bubble.tone}
        >
          <div
            className="pixel-panel flex cursor-pointer items-start gap-2 px-3 py-2"
            style={{ maxWidth: COMPANY_BUBBLE_MAX_WIDTH_PX }}
            role="button"
            tabIndex={0}
            aria-label={`${bubble.label}: ${bubble.detail}`}
            onClick={() => client.select({ sessionId: bubble.sessionId, tab: bubble.tab })}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' && event.key !== ' ') return;
              event.preventDefault();
              client.select({ sessionId: bubble.sessionId, tab: bubble.tab });
            }}
          >
            <span
              className="mt-1 h-2 w-2 shrink-0"
              style={{ background: COMPANY_BUBBLE_TONE_COLOR[bubble.tone] }}
              aria-hidden="true"
            />
            <span className="flex min-w-0 flex-col gap-1">
              <span className="text-2xs uppercase leading-none tracking-wide text-text-muted">
                {bubble.label}
              </span>
              <span className="text-2xs leading-tight" style={{ color: 'var(--color-text)' }}>
                {bubble.detail}
              </span>
            </span>
            {bubble.selected && (
              <Button
                variant="ghost"
                size="icon"
                className="ml-1 shrink-0 leading-none"
                title="Dừng phiên công ty này"
                aria-label={`Dừng ${bubble.label}`}
                onClick={(event) => {
                  // The character's × is the SESSION's stop, never the legacy
                  // agent dismissal: there is no Claude terminal behind it.
                  event.stopPropagation();
                  client.controlSession(bubble.sessionId, 'kill');
                }}
              >
                ×
              </Button>
            )}
          </div>
        </div>
      ))}
    </>
  );
}

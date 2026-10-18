/**
 * flip: the board's card motion. A card that changes lane or slot flies from
 * where it was to where it is now.
 *
 * The plan and the bookkeeping are described with structural types, so this
 * module needs no DOM lib and runs under the node test config. The board hands
 * in its rendered cards; reduced motion plans nothing and the card simply sits
 * in its new place.
 */

/** A card's top-left corner in layout space (transforms do not move it). */
export interface FlightRect {
  left: number;
  top: number;
}

/** Where a card was at the last layout change: its lane, its slot, and its place. */
export interface FlightMemory {
  lane: string;
  index: number;
  rect: FlightRect;
}

/**
 * One keyframe of a flight. A type alias rather than an interface so it stays
 * assignable to the DOM's Keyframe, which has an index signature.
 */
export type FlightKeyframe = {
  transform: string;
  boxShadow?: string;
  offset?: number;
};

export interface FlightAnimationOptions {
  duration: number;
  easing: string;
}

export interface FlightPlan {
  keyframes: FlightKeyframe[];
  options: FlightAnimationOptions;
}

/** The part of a rendered card a flight reads and animates; an HTMLElement satisfies it. */
export interface FlightCard {
  readonly dataset: { readonly [key: string]: string | undefined };
  readonly offsetLeft: number;
  readonly offsetTop: number;
  animate(keyframes: FlightKeyframe[], options: FlightAnimationOptions): unknown;
}

/** A move at least this far (px) travels the arc; a shorter one slides. */
const FAR_PX = 40;
/** Under this much (px) on both axes, nothing moved. */
const STILL_PX = 1;
const ARC_MS = 720;
const NEAR_MS = 260;
const EASING = 'cubic-bezier(.22,1,.36,1)';
/** How far the card lifts off the board at the top of the arc. */
const ARC_LIFT_PX = 28;
const ARC_SCALE = 1.06;
const ARC_TILT_DEG = 2;
/** The lifted card's shadow: the project's hard pixel offset, in the board's dark ink. */
const ARC_SHADOW = '2px 2px 0px var(--color-bg-dark)';

/**
 * The keyframes that carry a card from `from` back to where it now sits at
 * `to`. Null when reduced motion is on or the card did not move.
 */
export function planFlight(
  from: FlightRect,
  to: FlightRect,
  reducedMotion: boolean,
): FlightPlan | null {
  if (reducedMotion) return null;
  const dx = from.left - to.left;
  const dy = from.top - to.top;
  if (Math.abs(dx) < STILL_PX && Math.abs(dy) < STILL_PX) return null;

  if (Math.hypot(dx, dy) < FAR_PX) {
    return {
      keyframes: [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }],
      options: { duration: NEAR_MS, easing: EASING },
    };
  }

  // A card moving right tilts clockwise, and one moving left tilts back.
  const tilt = dx < 0 ? ARC_TILT_DEG : -ARC_TILT_DEG;
  return {
    keyframes: [
      { transform: `translate(${dx}px, ${dy}px)`, offset: 0 },
      {
        transform: `translate(${dx / 2}px, ${dy / 2 - ARC_LIFT_PX}px) scale(${ARC_SCALE}) rotate(${tilt}deg)`,
        boxShadow: ARC_SHADOW,
        offset: 0.45,
      },
      { transform: 'none', offset: 1 },
    ],
    options: { duration: ARC_MS, easing: EASING },
  };
}

/**
 * Fly every card that changed lane or slot since `previous` was taken, and
 * return where every card sits now for the next layout change to compare with.
 *
 * Cards carry `data-task-id`, `data-lane` and `data-index`. Positions come from
 * `offsetLeft`/`offsetTop`, which ignore the transforms of a flight still
 * running, so a card mid-flight measures where it belongs rather than where it
 * is drawn.
 */
export function flyChangedCards(
  cards: readonly FlightCard[],
  previous: ReadonlyMap<string, FlightMemory>,
  reducedMotion: boolean,
): Map<string, FlightMemory> {
  const next = new Map<string, FlightMemory>();
  for (const card of cards) {
    next.set(card.dataset['taskId'] ?? '', {
      lane: card.dataset['lane'] ?? '',
      index: Number(card.dataset['index']),
      rect: { left: card.offsetLeft, top: card.offsetTop },
    });
  }

  for (const card of cards) {
    const taskId = card.dataset['taskId'] ?? '';
    const before = previous.get(taskId);
    const after = next.get(taskId);
    if (before === undefined || after === undefined) continue;
    if (before.lane === after.lane && before.index === after.index) continue;
    const plan = planFlight(before.rect, after.rect, reducedMotion);
    if (plan !== null) card.animate(plan.keyframes, plan.options);
  }
  return next;
}

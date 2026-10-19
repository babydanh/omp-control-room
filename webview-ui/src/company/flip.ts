/**
 * flip: the board's card motion. A card that changes lane flies from where it was
 * to where it is now, lifting off the board and settling; a card that moves within
 * its lane glides; a card that arrives fades and rises in. Every duration, distance
 * and tone comes from COMPANY_MOTION.
 *
 * The plan and the bookkeeping are described with structural types, so this
 * module needs no DOM lib and runs under the node test config. The DOM side
 * (useFlightLayout) measures every keyed element and hands in its layout place;
 * reduced motion plans nothing and the card simply sits in its new place.
 */

import { COMPANY_MOTION } from './constants.js';

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
  transform?: string;
  opacity?: number;
  backgroundColor?: string;
  offset?: number;
};

export interface FlightAnimationOptions {
  duration: number;
  easing: string;
  /** Milliseconds before the animation starts. */
  delay?: number;
  /** `backwards` holds the first keyframe during the delay, so a staggered card waits where it was. */
  fill?: 'backwards';
}

export interface FlightPlan {
  keyframes: FlightKeyframe[];
  options: FlightAnimationOptions;
}

/** A card that changed lane arcs; a card that changed only its slot glides. */
export type FlightKind = 'cross-lane' | 'reorder';

/**
 * The part of a rendered card a flight reads and animates. `rect` is the card's
 * layout place, which the DOM side measures so that a card mid-flight still
 * reports where it belongs.
 */
export interface FlightCard {
  readonly dataset: { readonly [key: string]: string | undefined };
  readonly rect: FlightRect;
  animate(keyframes: FlightKeyframe[], options: FlightAnimationOptions): unknown;
}

/** Under this much (px) on both axes, nothing moved. */
const STILL_PX = 1;
/** An arriving card rises a few pixels and fades in. */
const ENTER_KEYFRAMES: FlightKeyframe[] = [
  { transform: `translateY(${COMPANY_MOTION.enterRisePx}px)`, opacity: 0 },
  { transform: 'none', opacity: 1 },
];

/** Round to a thousandth, so keyframe strings stay short and free of float noise. */
function fmt(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}

/** How far along its path a flight has travelled at time fraction `t`: the ease-out cubic. */
function travelled(t: number): number {
  return 1 - (1 - t) ** 3;
}

/**
 * Sample a cross-lane flight along its path. The card travels from `dx, dy` back
 * to its place on an ease-out curve, and at the midpoint of that travel it lifts
 * `flightLiftPx` off the straight line, so the lift is an arc in space. The
 * keyframe at the arc's top carries the flight tone.
 */
function arcKeyframes(dx: number, dy: number): FlightKeyframe[] {
  const steps = COMPANY_MOTION.flightSteps;
  const scaleFrom = COMPANY_MOTION.flightScaleFrom;
  // The travel is half way where 1 - (1 - t)^3 = 0.5: the arc's top.
  const topStep = Math.round(steps * (1 - Math.cbrt(0.5)));
  const frames: FlightKeyframe[] = [];
  for (let step = 0; step <= steps; step += 1) {
    const offset = step / steps;
    const p = travelled(offset);
    const lift = COMPANY_MOTION.flightLiftPx * Math.sin(Math.PI * p);
    const frame: FlightKeyframe = {
      offset,
      transform: `translate(${fmt(dx * (1 - p))}px, ${fmt(dy * (1 - p) - lift)}px) scale(${fmt(scaleFrom + (1 - scaleFrom) * p)})`,
    };
    if (step === topStep) frame.backgroundColor = COMPANY_MOTION.flightTone;
    frames.push(frame);
  }
  return frames;
}

/**
 * The keyframes that carry a card from `from` back to where it now sits at `to`.
 * Null when reduced motion is on or the card did not move.
 *
 * A cross-lane flight is a sampled arc (see arcKeyframes). Its samples carry the
 * ease, so the animation itself runs linear between them.
 */
export function planFlight(
  from: FlightRect,
  to: FlightRect,
  reducedMotion: boolean,
  kind: FlightKind,
): FlightPlan | null {
  if (reducedMotion) return null;
  const dx = from.left - to.left;
  const dy = from.top - to.top;
  if (Math.abs(dx) < STILL_PX && Math.abs(dy) < STILL_PX) return null;

  if (kind === 'reorder') {
    return {
      keyframes: [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }],
      options: { duration: COMPANY_MOTION.glideMs, easing: COMPANY_MOTION.easing },
    };
  }

  return {
    keyframes: arcKeyframes(dx, dy),
    options: { duration: COMPANY_MOTION.flightMs, easing: 'linear' },
  };
}

/**
 * Fly every card that changed lane or slot since `previous` was taken, and
 * return where every card sits now for the next layout change to compare with.
 *
 * Cards carry `data-flight-key`, `data-lane` and `data-index`. A card with no
 * earlier memory flies nothing here; `enterArrivingCards` handles it. The cards
 * that fly in one render start one stagger step apart, in DOM order.
 */
export function flyChangedCards(
  cards: readonly FlightCard[],
  previous: ReadonlyMap<string, FlightMemory>,
  reducedMotion: boolean,
): Map<string, FlightMemory> {
  const next = new Map<string, FlightMemory>();
  for (const card of cards) {
    next.set(card.dataset['flightKey'] ?? '', {
      lane: card.dataset['lane'] ?? '',
      index: Number(card.dataset['index'] ?? '-1'),
      rect: card.rect,
    });
  }

  let flown = 0;
  for (const card of cards) {
    const key = card.dataset['flightKey'] ?? '';
    const before = previous.get(key);
    const after = next.get(key);
    if (before === undefined || after === undefined) continue;
    if (before.lane === after.lane && before.index === after.index) continue;
    const kind: FlightKind = before.lane === after.lane ? 'reorder' : 'cross-lane';
    const plan = planFlight(before.rect, after.rect, reducedMotion, kind);
    if (plan === null) continue;
    card.animate(plan.keyframes, {
      ...plan.options,
      delay: flown * COMPANY_MOTION.flightStaggerMs,
      fill: 'backwards',
    });
    flown += 1;
  }
  return next;
}

/**
 * Fade and rise in every card whose key was not in `previous`. Call it only
 * after the first layout: the cards that exist then are not arrivals.
 */
export function enterArrivingCards(
  cards: readonly FlightCard[],
  previous: ReadonlyMap<string, FlightMemory>,
  reducedMotion: boolean,
): void {
  if (reducedMotion) return;
  for (const card of cards) {
    if (previous.has(card.dataset['flightKey'] ?? '')) continue;
    card.animate(ENTER_KEYFRAMES, {
      duration: COMPANY_MOTION.enterMs,
      easing: COMPANY_MOTION.easing,
    });
  }
}

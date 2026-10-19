import { describe, expect, it } from 'vitest';

import { COMPANY_MOTION } from '../src/company/constants.js';
import {
  enterArrivingCards,
  type FlightAnimationOptions,
  type FlightCard,
  type FlightKeyframe,
  type FlightMemory,
  type FlightPlan,
  flyChangedCards,
  planFlight,
} from '../src/company/flip.js';

/** One animation a fake card received, so a test can read what it flew or faded. */
interface Animated {
  key: string;
  keyframes: FlightKeyframe[];
  options: FlightAnimationOptions;
}

/** A card as the DOM side reports it: its flight key, lane, slot, and layout rect. */
function fakeCard(
  key: string,
  lane: string,
  index: number,
  left: number,
  top: number,
  log: Animated[],
): FlightCard {
  return {
    dataset: { flightKey: key, lane, index: String(index) },
    rect: { left, top },
    animate(keyframes, options) {
      log.push({ key, keyframes, options });
      return undefined;
    },
  };
}

/** The memory flyChangedCards keeps for a card: its lane, its slot and its place. */
function memory(lane: string, index: number, left: number, top: number): FlightMemory {
  return { lane, index, rect: { left, top } };
}

/** The keyframes of a plan that the test expects to exist. */
function keyframesOf(plan: FlightPlan | null): FlightKeyframe[] {
  if (plan === null) throw new Error('expected a flight plan');
  return plan.keyframes;
}

/** The translate a keyframe's transform carries, in px: [x, y]. */
function translateOf(keyframe: FlightKeyframe | undefined): [number, number] {
  const match = /translate\((-?[\d.e-]+)px, (-?[\d.e-]+)px\)/.exec(keyframe?.transform ?? '');
  if (match === null) throw new Error('expected a translate');
  return [Number(match[1]), Number(match[2])];
}

describe('planFlight', () => {
  const from = { left: 100, top: 40 };
  const to = { left: 300, top: 40 };

  it('plans nothing under reduced motion', () => {
    expect(planFlight(from, to, true, 'cross-lane')).toBeNull();
    expect(planFlight(from, to, true, 'reorder')).toBeNull();
  });

  it('plans nothing for a card that did not move', () => {
    expect(planFlight(from, { left: 100.5, top: 40.5 }, false, 'cross-lane')).toBeNull();
    expect(planFlight(from, { left: 100.5, top: 40.5 }, false, 'reorder')).toBeNull();
  });

  it('glides a reordered card translate-only over the glide duration', () => {
    const plan = planFlight({ left: 10, top: 80 }, { left: 10, top: 40 }, false, 'reorder');
    expect(plan?.options.duration).toBe(COMPANY_MOTION.glideMs);
    expect(plan?.options.duration).toBe(300);
    expect(plan?.keyframes).toEqual([{ transform: 'translate(0px, 40px)' }, { transform: 'none' }]);
  });

  it('flies a card that changed lane over the flight duration, inside the 650-800ms band', () => {
    const plan = planFlight(from, to, false, 'cross-lane');
    expect(plan?.options.duration).toBe(COMPANY_MOTION.flightMs);
    expect(plan?.options.duration).toBeGreaterThanOrEqual(650);
    expect(plan?.options.duration).toBeLessThanOrEqual(800);
  });

  it('flies a short cross-lane move as an arc too, with no distance split', () => {
    const plan = planFlight({ left: 0, top: 0 }, { left: 30, top: 0 }, false, 'cross-lane');
    expect(plan?.options.duration).toBe(COMPANY_MOTION.flightMs);
    expect(keyframesOf(plan)).toHaveLength(COMPANY_MOTION.flightSteps + 1);
  });

  it('starts scaled down at the old place and lands unscaled at the new one', () => {
    const keyframes = keyframesOf(planFlight(from, to, false, 'cross-lane'));
    expect(keyframes[0]).toEqual({ offset: 0, transform: 'translate(-200px, 0px) scale(0.98)' });
    expect(keyframes[keyframes.length - 1]).toEqual({
      offset: 1,
      transform: 'translate(0px, 0px) scale(1)',
    });
  });

  it('lifts the card 16px off its straight path where the travel is half way, and tints it there', () => {
    const keyframes = keyframesOf(planFlight(from, to, false, 'cross-lane'));
    const top = keyframes[4];
    expect(top?.offset).toBe(0.2);
    expect(top?.backgroundColor).toBe(COMPANY_MOTION.flightTone);
    const [x, y] = translateOf(top);
    expect(x).toBeCloseTo(-102.4, 1);
    expect(y).toBeCloseTo(-COMPANY_MOTION.flightLiftPx, 0);
  });

  it('travels on an ease-out curve: most of the distance is covered by half time', () => {
    const keyframes = keyframesOf(planFlight(from, to, false, 'cross-lane'));
    const [x] = translateOf(keyframes[10]);
    expect(x).toBeCloseTo(-25, 1);
  });

  it('tints only the arc top, and carries no box shadow, tilt or rotation', () => {
    const keyframes = keyframesOf(planFlight(from, to, false, 'cross-lane'));
    expect(keyframes.filter((keyframe) => keyframe.backgroundColor !== undefined)).toHaveLength(1);
    for (const keyframe of keyframes) {
      expect(keyframe).not.toHaveProperty('boxShadow');
      expect(keyframe.transform ?? '').not.toContain('rotate');
    }
  });

  it('glides a reordered card with no tone change and no scale', () => {
    const keyframes = keyframesOf(
      planFlight({ left: 10, top: 80 }, { left: 10, top: 40 }, false, 'reorder'),
    );
    for (const keyframe of keyframes) {
      expect(keyframe).not.toHaveProperty('backgroundColor');
      expect(keyframe.transform ?? '').not.toContain('scale');
    }
  });
});

describe('flyChangedCards', () => {
  it('flies a card that changed lane and glides one that moved within its lane', () => {
    const log: Animated[] = [];
    const previous = new Map<string, FlightMemory>([
      ['a', memory('ready', 0, 0, 0)],
      ['b', memory('running', 0, 300, 0)],
    ]);
    const cards = [
      fakeCard('a', 'running', 0, 300, 0, log),
      fakeCard('b', 'running', 1, 300, 60, log),
    ];
    flyChangedCards(cards, previous, false);
    expect(log.map((entry) => entry.key)).toEqual(['a', 'b']);
    expect(log[0]?.options.duration).toBe(COMPANY_MOTION.flightMs);
    expect(log[1]?.options.duration).toBe(COMPANY_MOTION.glideMs);
    expect(log[1]?.keyframes[0]).toEqual({ transform: 'translate(0px, -60px)' });
  });

  it('starts the cards of one render a stagger step apart, skipping cards that did not move', () => {
    const log: Animated[] = [];
    const previous = new Map<string, FlightMemory>([
      ['a', memory('ready', 0, 0, 0)],
      ['b', memory('ready', 1, 0, 40)],
      ['c', memory('ready', 2, 0, 80)],
      ['d', memory('ready', 3, 0, 120)],
    ]);
    const cards = [
      fakeCard('a', 'ready', 0, 0, 0, log),
      fakeCard('b', 'running', 0, 300, 0, log),
      fakeCard('c', 'running', 1, 300, 40, log),
      fakeCard('d', 'ready', 3, 0, 120, log),
    ];
    flyChangedCards(cards, previous, false);
    expect(log.map((entry) => entry.key)).toEqual(['b', 'c']);
    expect(log.map((entry) => entry.options.delay)).toEqual([0, COMPANY_MOTION.flightStaggerMs]);
    expect(log.map((entry) => entry.options.fill)).toEqual(['backwards', 'backwards']);
  });

  it('flies nothing under reduced motion, and still records where every card sits', () => {
    const log: Animated[] = [];
    const cards = [fakeCard('a', 'running', 0, 300, 0, log)];
    const next = flyChangedCards(cards, new Map([['a', memory('ready', 0, 0, 0)]]), true);
    expect(log).toEqual([]);
    expect(next.get('a')).toEqual(memory('running', 0, 300, 0));
  });

  it('flies nothing on the first render, when no card has a memory yet', () => {
    const log: Animated[] = [];
    const cards = [fakeCard('a', 'ready', 0, 0, 0, log)];
    const next = flyChangedCards(cards, new Map(), false);
    expect(log).toEqual([]);
    expect(next.get('a')).toEqual(memory('ready', 0, 0, 0));
  });

  it('reads a card with no slot as index -1', () => {
    const card: FlightCard = {
      dataset: { flightKey: 'x', lane: 'ready' },
      rect: { left: 0, top: 0 },
      animate: () => undefined,
    };
    expect(flyChangedCards([card], new Map(), false).get('x')?.index).toBe(-1);
  });
});

describe('enterArrivingCards', () => {
  it('fades and rises in only the cards whose keys were not there before', () => {
    const log: Animated[] = [];
    const cards = [
      fakeCard('old', 'ready', 0, 0, 0, log),
      fakeCard('new', 'ready', 1, 0, 40, log),
    ];
    enterArrivingCards(cards, new Map([['old', memory('ready', 0, 0, 0)]]), false);
    expect(log.map((entry) => entry.key)).toEqual(['new']);
    expect(log[0]?.options.duration).toBe(COMPANY_MOTION.enterMs);
    expect(log[0]?.options.duration).toBe(300);
    expect(log[0]?.keyframes).toEqual([
      { transform: 'translateY(8px)', opacity: 0 },
      { transform: 'none', opacity: 1 },
    ]);
  });

  it('rises without scaling', () => {
    const log: Animated[] = [];
    enterArrivingCards([fakeCard('new', 'ready', 0, 0, 0, log)], new Map(), false);
    for (const keyframe of log[0]?.keyframes ?? []) {
      expect(keyframe.transform ?? '').not.toContain('scale');
    }
  });

  it('does nothing under reduced motion', () => {
    const log: Animated[] = [];
    enterArrivingCards([fakeCard('new', 'ready', 0, 0, 0, log)], new Map(), true);
    expect(log).toEqual([]);
  });
});

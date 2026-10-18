import { describe, expect, it } from 'vitest';

import {
  enterArrivingCards,
  type FlightCard,
  type FlightKeyframe,
  type FlightMemory,
  flyChangedCards,
  planFlight,
} from '../src/company/flip.js';

/** One animation a fake card received, so a test can read what it flew or faded. */
interface Animated {
  key: string;
  keyframes: FlightKeyframe[];
  duration: number;
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
    animate: (keyframes, options) => {
      log.push({ key, keyframes, duration: options.duration });
    },
  };
}

describe('planFlight', () => {
  it('plans nothing under reduced motion, however far the card moved', () => {
    expect(planFlight({ left: 0, top: 0 }, { left: 300, top: 0 }, true)).toBeNull();
  });

  it('plans nothing for a card that did not move', () => {
    expect(planFlight({ left: 10, top: 10 }, { left: 10, top: 10 }, false)).toBeNull();
    expect(planFlight({ left: 10, top: 10 }, { left: 10.5, top: 10.4 }, false)).toBeNull();
  });

  it('slides a short move in 260ms without an arc', () => {
    const plan = planFlight({ left: 110, top: 0 }, { left: 100, top: 0 }, false);

    expect(plan?.options.duration).toBe(260);
    expect(plan?.keyframes).toHaveLength(2);
    expect(plan?.keyframes[0]).toMatchObject({ transform: 'translate(10px, 0px)' });
  });

  it('arcs a long move over 720ms, lifting the card at the middle keyframe', () => {
    const plan = planFlight({ left: 0, top: 0 }, { left: 300, top: 0 }, false);
    const middle = plan?.keyframes[1];

    expect(plan?.options.duration).toBe(720);
    expect(plan?.keyframes).toHaveLength(3);
    expect(middle).toMatchObject({ offset: 0.45 });
    expect(middle?.transform).toContain('translate(-150px, -28px)');
    expect(middle?.transform).toContain('scale(1.06)');
  });

  it('tilts a card moving right clockwise and a card moving left back', () => {
    const rightward = planFlight({ left: 0, top: 0 }, { left: 300, top: 0 }, false);
    const leftward = planFlight({ left: 300, top: 0 }, { left: 0, top: 0 }, false);

    expect(rightward?.keyframes[1]?.transform).toContain('rotate(2deg)');
    expect(leftward?.keyframes[1]?.transform).toContain('rotate(-2deg)');
  });
});

describe('flyChangedCards', () => {
  it('flies a card that changed lane and records where every card now sits', () => {
    const log: Animated[] = [];
    const cards = [fakeCard('a', 'running', 0, 300, 0, log), fakeCard('b', 'ready', 0, 0, 0, log)];
    const previous = new Map<string, FlightMemory>([
      ['a', { lane: 'ready', index: 0, rect: { left: 0, top: 0 } }],
      ['b', { lane: 'ready', index: 0, rect: { left: 0, top: 0 } }],
    ]);

    const next = flyChangedCards(cards, previous, false);

    expect(log.map((entry) => entry.key)).toEqual(['a']);
    expect(next.get('a')).toEqual({ lane: 'running', index: 0, rect: { left: 300, top: 0 } });
    expect(next.get('b')).toEqual({ lane: 'ready', index: 0, rect: { left: 0, top: 0 } });
  });

  it('flies a card that moved to another slot in its own lane', () => {
    const log: Animated[] = [];
    const cards = [fakeCard('a', 'ready', 1, 0, 90, log)];
    const previous = new Map<string, FlightMemory>([
      ['a', { lane: 'ready', index: 0, rect: { left: 0, top: 0 } }],
    ]);

    flyChangedCards(cards, previous, false);

    expect(log.map((entry) => entry.key)).toEqual(['a']);
  });

  it('does not fly a card whose lane and slot are unchanged', () => {
    const log: Animated[] = [];
    const cards = [fakeCard('a', 'ready', 0, 0, 0, log)];
    const previous = new Map<string, FlightMemory>([
      ['a', { lane: 'ready', index: 0, rect: { left: 0, top: 0 } }],
    ]);

    flyChangedCards(cards, previous, false);

    expect(log).toEqual([]);
  });

  it('flies nothing under reduced motion, but still records the new layout', () => {
    const log: Animated[] = [];
    const cards = [fakeCard('a', 'running', 0, 300, 0, log)];
    const previous = new Map<string, FlightMemory>([
      ['a', { lane: 'ready', index: 0, rect: { left: 0, top: 0 } }],
    ]);

    const next = flyChangedCards(cards, previous, true);

    expect(log).toEqual([]);
    expect(next.get('a')?.lane).toBe('running');
  });

  it('flies nothing for a card with no earlier position, such as the first render', () => {
    const log: Animated[] = [];
    const cards = [fakeCard('a', 'running', 0, 300, 0, log)];

    flyChangedCards(cards, new Map(), false);

    expect(log).toEqual([]);
  });

  it('reads a card with no slot number as slot -1', () => {
    const card: FlightCard = {
      dataset: { flightKey: 'a', lane: 'ready' },
      rect: { left: 0, top: 0 },
      animate: () => undefined,
    };

    expect(flyChangedCards([card], new Map(), false).get('a')?.index).toBe(-1);
  });
});

describe('enterArrivingCards', () => {
  it('fades and rises in only the cards that were not laid out before', () => {
    const log: Animated[] = [];
    const cards = [fakeCard('a', 'ready', 0, 0, 0, log), fakeCard('b', 'ready', 1, 0, 90, log)];
    const previous = new Map<string, FlightMemory>([
      ['b', { lane: 'ready', index: 1, rect: { left: 0, top: 90 } }],
    ]);

    enterArrivingCards(cards, previous, false);

    expect(log.map((entry) => entry.key)).toEqual(['a']);
    expect(log[0]?.duration).toBe(240);
    expect(log[0]?.keyframes[0]).toMatchObject({ opacity: 0 });
    expect(log[0]?.keyframes[1]).toMatchObject({ opacity: 1 });
  });

  it('enters nothing under reduced motion', () => {
    const log: Animated[] = [];
    const cards = [fakeCard('a', 'ready', 0, 0, 0, log)];

    enterArrivingCards(cards, new Map(), true);

    expect(log).toEqual([]);
  });
});

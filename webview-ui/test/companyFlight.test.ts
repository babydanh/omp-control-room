import { describe, expect, it } from 'vitest';

import {
  type FlightCard,
  type FlightMemory,
  flyChangedCards,
  planFlight,
} from '../src/company/flip.js';

function fakeCard(
  taskId: string,
  lane: string,
  index: number,
  left: number,
  top: number,
  flown: string[],
): FlightCard {
  return {
    dataset: { taskId, lane, index: String(index) },
    offsetLeft: left,
    offsetTop: top,
    animate: () => {
      flown.push(taskId);
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
  it('flies a card that changed lane, and returns where every card now sits', () => {
    const flown: string[] = [];
    const cards = [
      fakeCard('a', 'running', 0, 300, 0, flown),
      fakeCard('b', 'ready', 0, 0, 0, flown),
    ];
    const previous = new Map<string, FlightMemory>([
      ['a', { lane: 'ready', index: 0, rect: { left: 0, top: 0 } }],
      ['b', { lane: 'ready', index: 0, rect: { left: 0, top: 0 } }],
    ]);

    const next = flyChangedCards(cards, previous, false);

    expect(flown).toEqual(['a']);
    expect(next.get('a')).toEqual({ lane: 'running', index: 0, rect: { left: 300, top: 0 } });
    expect(next.get('b')).toEqual({ lane: 'ready', index: 0, rect: { left: 0, top: 0 } });
  });

  it('does not fly a card whose lane and slot are unchanged', () => {
    const flown: string[] = [];
    const cards = [fakeCard('a', 'ready', 0, 0, 0, flown)];
    const previous = new Map<string, FlightMemory>([
      ['a', { lane: 'ready', index: 0, rect: { left: 0, top: 0 } }],
    ]);

    flyChangedCards(cards, previous, false);

    expect(flown).toEqual([]);
  });

  it('flies nothing under reduced motion, but still records the new layout', () => {
    const flown: string[] = [];
    const cards = [fakeCard('a', 'running', 0, 300, 0, flown)];
    const previous = new Map<string, FlightMemory>([
      ['a', { lane: 'ready', index: 0, rect: { left: 0, top: 0 } }],
    ]);

    const next = flyChangedCards(cards, previous, true);

    expect(flown).toEqual([]);
    expect(next.get('a')?.lane).toBe('running');
  });

  it('flies nothing for a card with no earlier position, such as the first render', () => {
    const flown: string[] = [];
    const cards = [fakeCard('a', 'running', 0, 300, 0, flown)];

    flyChangedCards(cards, new Map(), false);

    expect(flown).toEqual([]);
  });
});

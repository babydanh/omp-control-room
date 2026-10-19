/**
 * useFlightLayout: runs the board's card motion over one container after every
 * render. Keyed elements (`data-flight-key`) that moved lane or slot fly to their
 * new place, and new keys fade and rise in. The first render only records
 * positions. Reduced motion is read live, so turning it on stops the motion.
 */

import { type RefObject, useLayoutEffect, useRef } from 'react';

import {
  enterArrivingCards,
  type FlightCard,
  type FlightMemory,
  type FlightRect,
  flyChangedCards,
} from './flip.js';
import { useMediaQuery } from './useMediaQuery.js';

/** The preference the flight and the CSS both honour; one query, so they agree. */
export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

const NO_MEMORY: ReadonlyMap<string, FlightMemory> = new Map();

/**
 * An element's place in layout space: its offsets summed up the offset-parent
 * chain. Each card measures against the page rather than its own lane, so a
 * card that moves between lanes flies the true distance. Transforms are ignored,
 * so a card mid-flight still reports where it belongs.
 */
function layoutRect(element: HTMLElement): FlightRect {
  let left = 0;
  let top = 0;
  let node: HTMLElement | null = element;
  while (node !== null) {
    left += node.offsetLeft;
    top += node.offsetTop;
    node = node.offsetParent instanceof HTMLElement ? node.offsetParent : null;
  }
  return { left, top };
}

export function useFlightLayout(root: RefObject<HTMLElement | null>): void {
  const reducedMotion = useMediaQuery(REDUCED_MOTION_QUERY);
  const memory = useRef<ReadonlyMap<string, FlightMemory> | null>(null);

  // Runs after every commit: the positions are read once the layout is final, so
  // a flight starts exactly where the element was on screen.
  useLayoutEffect(() => {
    const container = root.current;
    if (container === null) return;
    const cards: FlightCard[] = Array.from(
      container.querySelectorAll<HTMLElement>('[data-flight-key]'),
    ).map((element) => ({
      dataset: element.dataset,
      rect: layoutRect(element),
      animate: (keyframes, options) => element.animate(keyframes, options),
    }));
    const previous = memory.current;
    memory.current = flyChangedCards(cards, previous ?? NO_MEMORY, reducedMotion);
    if (previous !== null) enterArrivingCards(cards, previous, reducedMotion);
  });
}

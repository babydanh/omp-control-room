/**
 * useElementWidth: an element's width, kept current by a ResizeObserver. The lanes
 * row measures itself with it, so the lanes pack into the room the row really has.
 * The `key` re-attaches the observer when the element is swapped for another one
 * (the phone and desktop lane rows are different elements).
 */

import { type RefObject, useLayoutEffect, useState } from 'react';

export function useElementWidth(ref: RefObject<HTMLElement | null>, key: string): number {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) return undefined;
    setWidth(element.clientWidth);
    const observer = new ResizeObserver(() => setWidth(element.clientWidth));
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, key]);
  return width;
}

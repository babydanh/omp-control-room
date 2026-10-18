/**
 * useStickToBottom: keeps a scrolling view on its newest line.
 *
 * A view mounts pinned, so it opens at the bottom. While pinned, it moves to the
 * bottom after every render, so lines that arrive land in view. Scrolling up
 * unpins it; scrolling back down re-pins it. The rule lives in scrollPin.ts.
 *
 * Returns the scroll handler to attach to the same element.
 */

import { type RefObject, useLayoutEffect, useRef } from 'react';

import { isPinnedToBottom } from './scrollPin.js';

export function useStickToBottom<T extends HTMLElement>(scroller: RefObject<T | null>): () => void {
  const pinnedRef = useRef(true);

  // No dependency list on purpose: a render is the signal that content may have
  // grown, and a pinned view only moves when it is already at the bottom.
  useLayoutEffect(() => {
    const element = scroller.current;
    if (element !== null && pinnedRef.current) element.scrollTop = element.scrollHeight;
  });

  return () => {
    const element = scroller.current;
    if (element !== null) pinnedRef.current = isPinnedToBottom(element);
  };
}

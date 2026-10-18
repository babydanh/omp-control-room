/**
 * useLayoutMode: the window's width, kept current, and the board layout that width
 * gets. A resize re-lays the board at once, so the phone and tablet layouts never
 * wait on a reload.
 */

import { useEffect, useState } from 'react';

import { type LayoutMode, layoutModeFor } from './layoutMode.js';

/** The window's width, kept current: it bounds how wide the drawer may be. */
export function useViewportWidth(): number {
  const [width, setWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const onResize = (): void => setWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return width;
}

/** The board's layout for the window as it is now. */
export function useLayoutMode(): LayoutMode {
  return layoutModeFor(useViewportWidth());
}

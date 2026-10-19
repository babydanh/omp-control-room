/**
 * useScreenSelection: tells whether a reader is holding or selecting text in a herdr screen, so the
 * screen can stand still meanwhile. It also makes a copy from that text plain: private-use glyphs,
 * which a terminal draws but the clipboard cannot use, are left out. A copy outside the screen is
 * left to the browser.
 */

import type { RefObject } from 'react';
import { useEffect, useReducer } from 'react';

import { isScreenFrozen, reduceScreenFreeze, SCREEN_NOT_FROZEN } from './screenFreeze.js';
import { stripPrivateUse } from './screenText.js';

/** Whether a selection starts, ends, or covers part of the region. */
function selectionTouches(region: HTMLElement, selection: Selection): boolean {
  return (
    region.contains(selection.anchorNode) ||
    region.contains(selection.focusNode) ||
    selection.containsNode(region, true)
  );
}

/** True while the reader holds a press in the region or has text selected inside it. */
export function useScreenSelection(scope: RefObject<HTMLElement | null>): boolean {
  const [state, dispatch] = useReducer(reduceScreenFreeze, SCREEN_NOT_FROZEN);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const region = scope.current;
      if (region !== null && event.target instanceof Node && region.contains(event.target)) {
        dispatch({ type: 'press' });
      }
    };
    const onRelease = () => dispatch({ type: 'release' });
    const onSelectionChange = () => {
      const region = scope.current;
      const selection = document.getSelection();
      const active =
        region !== null &&
        selection !== null &&
        !selection.isCollapsed &&
        selectionTouches(region, selection);
      dispatch({ type: 'selection', active });
    };
    const onCopy = (event: ClipboardEvent) => {
      const region = scope.current;
      const selection = document.getSelection();
      if (region === null || selection === null || selection.isCollapsed) return;
      if (!selectionTouches(region, selection)) return;
      event.clipboardData?.setData('text/plain', stripPrivateUse(selection.toString()));
      event.preventDefault();
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('pointerup', onRelease, true);
    window.addEventListener('pointercancel', onRelease, true);
    document.addEventListener('selectionchange', onSelectionChange);
    document.addEventListener('copy', onCopy);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('pointerup', onRelease, true);
      window.removeEventListener('pointercancel', onRelease, true);
      document.removeEventListener('selectionchange', onSelectionChange);
      document.removeEventListener('copy', onCopy);
    };
  }, [scope]);

  return isScreenFrozen(state);
}

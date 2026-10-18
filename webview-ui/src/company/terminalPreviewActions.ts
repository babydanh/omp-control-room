/**
 * The terminal preview's actions as the rows see them: the context the provider
 * fills, and the trigger helper a row spreads onto its button. They live apart
 * from the provider so the component file exports only components.
 */

import type { FocusEvent, PointerEvent } from 'react';
import { createContext, useContext } from 'react';

import type { PreviewTarget } from './terminalPreview.js';

export interface TerminalPreviewActions {
  /** The pointer reached a row. Opens after a short hover, or at once when one is already open. */
  enter(target: PreviewTarget, element: HTMLElement): void;
  leave(target: PreviewTarget): void;
  /** A press on a row closes its preview; it stays shut until the pointer leaves the row. */
  press(target: PreviewTarget): void;
  /** Keyboard focus reached a row. Only focus that is visible to the keyboard opens a preview. */
  focus(target: PreviewTarget, element: HTMLElement): void;
  blur(target: PreviewTarget): void;
}

const NO_PREVIEW: TerminalPreviewActions = {
  enter: () => undefined,
  leave: () => undefined,
  press: () => undefined,
  focus: () => undefined,
  blur: () => undefined,
};

export const TerminalPreviewContext = createContext<TerminalPreviewActions>(NO_PREVIEW);

/** The preview actions for the nearest provider; a no-op outside one. */
export function useTerminalPreview(): TerminalPreviewActions {
  return useContext(TerminalPreviewContext);
}

/** Pointer and focus handlers that open the preview for one row. */
export function previewTriggers(actions: TerminalPreviewActions, target: PreviewTarget) {
  return {
    onPointerEnter: (event: PointerEvent<HTMLElement>) =>
      actions.enter(target, event.currentTarget),
    onPointerLeave: () => actions.leave(target),
    onPointerDown: () => actions.press(target),
    onFocus: (event: FocusEvent<HTMLElement>) => {
      if (event.currentTarget.matches(':focus-visible')) {
        actions.focus(target, event.currentTarget);
      }
    },
    onBlur: () => actions.blur(target),
  };
}

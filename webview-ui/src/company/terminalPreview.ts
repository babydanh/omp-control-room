/**
 * Hover and focus preview of a board row's terminal, as a pure state machine.
 *
 * The view feeds DOM events in and performs the returned timer effects; nothing
 * here touches timers, the DOM or React. A preview opens after a short hover
 * delay and stays open across a brief pointer gap. Escape dismisses it, and the
 * dismissal holds until the pointer leaves that same row.
 */

import type { DrawerSubject } from './selection.js';

export const PREVIEW_OPEN_DELAY_MS = 350;
export const PREVIEW_CLOSE_GRACE_MS = 120;
export const PREVIEW_WIDTH_PX = 520;
export const PREVIEW_HEIGHT_PX = 300;
export const PREVIEW_GAP_PX = 8;
export const PREVIEW_MARGIN_PX = 8;

export type PreviewTarget =
  | { readonly kind: 'herdr'; readonly paneId: string }
  | { readonly kind: 'session'; readonly sessionId: string };

/** Stable identity of a preview target, used to compare targets. */
export function previewKey(target: PreviewTarget): string {
  return target.kind === 'herdr' ? `herdr:${target.paneId}` : `session:${target.sessionId}`;
}

/**
 * The row a drawer subject stands for, so that row's preview stays shut while the drawer
 * shows it. Herdr panes and sessions have rows; other subjects have none.
 */
export function previewTargetOfSubject(subject: DrawerSubject | null): PreviewTarget | null {
  if (subject === null) return null;
  switch (subject.kind) {
    case 'herdr':
      return { kind: 'herdr', paneId: subject.paneId };
    case 'session':
      return { kind: 'session', sessionId: subject.sessionId };
    default:
      return null;
  }
}

export interface PreviewRect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

export interface PreviewState {
  /** The preview currently shown. */
  readonly target: PreviewTarget | null;
  readonly anchor: PreviewRect | null;
  /** The preview waiting for its open delay to elapse. */
  readonly pending: PreviewTarget | null;
  readonly pendingAnchor: PreviewRect | null;
  /** Key of a row dismissed by Escape or a press; cleared when the pointer leaves that row. */
  readonly dismissed: string | null;
  /** Key of the subject the detail drawer shows; its row gets no preview while it does. */
  readonly drawer: string | null;
}

export const INITIAL_PREVIEW_STATE: PreviewState = {
  target: null,
  anchor: null,
  pending: null,
  pendingAnchor: null,
  dismissed: null,
  drawer: null,
};

export type PreviewTimer = 'open' | 'close';

export type PreviewEvent =
  | {
      readonly type: 'enter' | 'focus';
      readonly target: PreviewTarget;
      readonly anchor: PreviewRect;
    }
  | { readonly type: 'leave' | 'blur'; readonly target: PreviewTarget }
  | { readonly type: 'press'; readonly target: PreviewTarget }
  | { readonly type: 'drawer'; readonly key: string | null }
  | { readonly type: 'escape' }
  // Scroll, resize, or the anchor went away.
  | { readonly type: 'close' }
  | { readonly type: 'timer'; readonly timer: PreviewTimer };

export type PreviewEffect =
  | { readonly type: 'schedule'; readonly timer: PreviewTimer; readonly delayMs: number }
  | { readonly type: 'cancel'; readonly timer: PreviewTimer };

type PreviewStep = { readonly state: PreviewState; readonly effects: readonly PreviewEffect[] };

const cancel = (timer: PreviewTimer): PreviewEffect => ({ type: 'cancel', timer });
const step = (state: PreviewState, effects: readonly PreviewEffect[] = []): PreviewStep => ({
  state,
  effects,
});

function sameTarget(target: PreviewTarget | null, key: string): boolean {
  return target !== null && previewKey(target) === key;
}

/** A row may not open once the user dismissed it or the drawer shows its subject. */
function isSuppressed(state: PreviewState, key: string): boolean {
  return key === state.dismissed || key === state.drawer;
}

/** Key of the row currently open or waiting to open, if any. */
function activeKey(state: PreviewState): string | null {
  if (state.target !== null) return previewKey(state.target);
  if (state.pending !== null) return previewKey(state.pending);
  return null;
}

function onEnter(state: PreviewState, target: PreviewTarget, anchor: PreviewRect): PreviewStep {
  const key = previewKey(target);
  if (sameTarget(state.target, key)) return step(state, [cancel('close')]);
  if (isSuppressed(state, key)) return step(state);
  if (state.target !== null) {
    // Another row is open: switch at once so the preview does not flicker.
    return step({ ...state, target, anchor, pending: null, pendingAnchor: null }, [
      cancel('open'),
      cancel('close'),
    ]);
  }
  return step({ ...state, pending: target, pendingAnchor: anchor }, [
    cancel('open'),
    { type: 'schedule', timer: 'open', delayMs: PREVIEW_OPEN_DELAY_MS },
  ]);
}

function onLeave(state: PreviewState, target: PreviewTarget): PreviewStep {
  const key = previewKey(target);
  let next = state;
  const effects: PreviewEffect[] = [];
  if (state.dismissed === key) next = { ...next, dismissed: null };
  if (sameTarget(state.pending, key)) {
    next = { ...next, pending: null, pendingAnchor: null };
    effects.push(cancel('open'));
  }
  if (sameTarget(state.target, key)) {
    effects.push({ type: 'schedule', timer: 'close', delayMs: PREVIEW_CLOSE_GRACE_MS });
  }
  return step(next, effects);
}

/** A press on a row closes its preview and keeps it shut until the pointer leaves the row. */
function onPress(state: PreviewState, target: PreviewTarget): PreviewStep {
  return step(
    {
      ...state,
      target: null,
      anchor: null,
      pending: null,
      pendingAnchor: null,
      dismissed: previewKey(target),
    },
    [cancel('open'), cancel('close')],
  );
}

/**
 * The drawer now shows `key`. That row's open or pending preview closes, and the row gets
 * no preview while the drawer shows it.
 */
function onDrawer(state: PreviewState, key: string | null): PreviewStep {
  if (key === state.drawer) return step(state);
  const shownRow =
    key !== null && (sameTarget(state.target, key) || sameTarget(state.pending, key));
  if (!shownRow) return step({ ...state, drawer: key });
  return step(
    { ...state, drawer: key, target: null, anchor: null, pending: null, pendingAnchor: null },
    [cancel('open'), cancel('close')],
  );
}

function onTimer(state: PreviewState, timer: PreviewTimer): PreviewStep {
  if (timer === 'open') {
    if (state.pending === null) return step(state);
    return step({
      ...state,
      target: state.pending,
      anchor: state.pendingAnchor,
      pending: null,
      pendingAnchor: null,
    });
  }
  if (state.target === null) return step(state);
  return step({ ...state, target: null, anchor: null });
}

/** Apply one DOM-level event to the preview state; returns the timer effects to perform. */
export function reducePreview(state: PreviewState, event: PreviewEvent): PreviewStep {
  switch (event.type) {
    case 'enter':
    case 'focus':
      return onEnter(state, event.target, event.anchor);
    case 'leave':
    case 'blur':
      return onLeave(state, event.target);
    case 'press':
      return onPress(state, event.target);
    case 'drawer':
      return onDrawer(state, event.key);
    case 'escape':
      // Escape dismisses the row that is open or pending; otherwise the dismissal stays.
      return step(
        {
          ...state,
          target: null,
          anchor: null,
          pending: null,
          pendingAnchor: null,
          dismissed: activeKey(state) ?? state.dismissed,
        },
        [cancel('open'), cancel('close')],
      );
    case 'close':
      return step({ ...state, target: null, anchor: null, pending: null, pendingAnchor: null }, [
        cancel('open'),
        cancel('close'),
      ]);
    case 'timer':
      return onTimer(state, event.timer);
  }
}

interface PreviewBox {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Where the preview sits beside its row: to the right when it fits, otherwise to
 * the left, clamped inside the viewport margin.
 */
export function placePreview(
  anchor: PreviewRect,
  viewport: { readonly width: number; readonly height: number },
): PreviewBox {
  const width = Math.max(0, Math.min(PREVIEW_WIDTH_PX, viewport.width - 2 * PREVIEW_MARGIN_PX));
  const height = Math.max(0, Math.min(PREVIEW_HEIGHT_PX, viewport.height - 2 * PREVIEW_MARGIN_PX));
  let left = anchor.right + PREVIEW_GAP_PX;
  if (left + width > viewport.width - PREVIEW_MARGIN_PX) {
    left = anchor.left - PREVIEW_GAP_PX - width;
  }
  const maxLeft = Math.max(PREVIEW_MARGIN_PX, viewport.width - PREVIEW_MARGIN_PX - width);
  const maxTop = Math.max(PREVIEW_MARGIN_PX, viewport.height - PREVIEW_MARGIN_PX - height);
  return {
    left: Math.min(Math.max(left, PREVIEW_MARGIN_PX), maxLeft),
    top: Math.min(Math.max(anchor.top, PREVIEW_MARGIN_PX), maxTop),
    width,
    height,
  };
}

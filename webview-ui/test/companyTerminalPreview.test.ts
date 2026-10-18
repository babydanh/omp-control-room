import { describe, expect, it } from 'vitest';

import {
  INITIAL_PREVIEW_STATE,
  placePreview,
  type PreviewEvent,
  previewKey,
  type PreviewRect,
  type PreviewState,
  type PreviewTarget,
  previewTargetOfSubject,
  type PreviewTimer,
  reducePreview,
} from '../src/company/terminalPreview.js';

const ROW_A: PreviewTarget = { kind: 'herdr', paneId: 'pane-a' };
const ROW_B: PreviewTarget = { kind: 'session', sessionId: 'sess-b' };
const ANCHOR_A: PreviewRect = { left: 100, top: 50, right: 300, bottom: 80 };
const ANCHOR_B: PreviewRect = { left: 100, top: 120, right: 300, bottom: 150 };
const ESCAPE: PreviewEvent = { type: 'escape' };
const CLOSE: PreviewEvent = { type: 'close' };

const enterRow = (target: PreviewTarget, anchor: PreviewRect = ANCHOR_A): PreviewEvent => ({
  type: 'enter',
  target,
  anchor,
});
const leaveRow = (target: PreviewTarget): PreviewEvent => ({ type: 'leave', target });
const pressRow = (target: PreviewTarget): PreviewEvent => ({ type: 'press', target });
const drawerShows = (key: string | null): PreviewEvent => ({ type: 'drawer', key });
const fire = (timer: PreviewTimer): PreviewEvent => ({ type: 'timer', timer });

/** Apply events in order and return the resulting state. */
function run(state: PreviewState, ...events: PreviewEvent[]): PreviewState {
  return events.reduce((current, event) => reducePreview(current, event).state, state);
}

/** ROW_A after its hover delay has elapsed. */
const OPEN_A = run(INITIAL_PREVIEW_STATE, enterRow(ROW_A), fire('open'));

describe('previewKey', () => {
  it('keys herdr panes and sessions distinctly', () => {
    expect(previewKey(ROW_A)).toBe('herdr:pane-a');
    expect(previewKey(ROW_B)).toBe('session:sess-b');
  });
});

describe('hover open', () => {
  it('schedules a 350 ms open on enter and opens the row when it fires', () => {
    const entered = reducePreview(INITIAL_PREVIEW_STATE, enterRow(ROW_A));
    expect(entered.state.target).toBeNull();
    expect(entered.state.pending).toStrictEqual(ROW_A);
    expect(entered.effects).toStrictEqual([
      { type: 'cancel', timer: 'open' },
      { type: 'schedule', timer: 'open', delayMs: 350 },
    ]);

    const opened = reducePreview(entered.state, fire('open'));
    expect(opened.state).toStrictEqual({
      target: ROW_A,
      anchor: ANCHOR_A,
      pending: null,
      pendingAnchor: null,
      dismissed: null,
      drawer: null,
      pinned: false,
      panelHovered: false,
    });
    expect(opened.effects).toStrictEqual([]);
  });

  it('cancels the pending open when the pointer leaves before the timer', () => {
    const pending = reducePreview(INITIAL_PREVIEW_STATE, enterRow(ROW_A)).state;
    const left = reducePreview(pending, leaveRow(ROW_A));
    expect(left.state).toStrictEqual(INITIAL_PREVIEW_STATE);
    expect(left.effects).toStrictEqual([{ type: 'cancel', timer: 'open' }]);
    expect(reducePreview(left.state, fire('open')).state).toStrictEqual(INITIAL_PREVIEW_STATE);
  });

  it('schedules a 250 ms close when the pointer leaves an open row', () => {
    const left = reducePreview(OPEN_A, leaveRow(ROW_A));
    expect(left.state.target).toStrictEqual(ROW_A);
    expect(left.effects).toStrictEqual([{ type: 'schedule', timer: 'close', delayMs: 250 }]);

    const closed = reducePreview(left.state, fire('close'));
    expect(closed.state.target).toBeNull();
    expect(closed.state.anchor).toBeNull();
    expect(closed.effects).toStrictEqual([]);
  });

  it('cancels the pending close when the pointer re-enters the open row', () => {
    const left = reducePreview(OPEN_A, leaveRow(ROW_A)).state;
    const back = reducePreview(left, enterRow(ROW_A));
    expect(back.state.target).toStrictEqual(ROW_A);
    expect(back.effects).toStrictEqual([{ type: 'cancel', timer: 'close' }]);
  });

  it('opens row B at once when moving from open row A, with no open timer', () => {
    const switched = reducePreview(OPEN_A, enterRow(ROW_B, ANCHOR_B));
    expect(switched.state).toStrictEqual({
      target: ROW_B,
      anchor: ANCHOR_B,
      pending: null,
      pendingAnchor: null,
      dismissed: null,
      drawer: null,
      pinned: false,
      panelHovered: false,
    });
    expect(switched.effects).toStrictEqual([
      { type: 'cancel', timer: 'open' },
      { type: 'cancel', timer: 'close' },
    ]);
  });

  it('treats focus like enter and blur like leave', () => {
    const focused = reducePreview(INITIAL_PREVIEW_STATE, {
      type: 'focus',
      target: ROW_A,
      anchor: ANCHOR_A,
    });
    expect(focused).toStrictEqual(reducePreview(INITIAL_PREVIEW_STATE, enterRow(ROW_A)));
    expect(reducePreview(OPEN_A, { type: 'blur', target: ROW_A })).toStrictEqual(
      reducePreview(OPEN_A, leaveRow(ROW_A)),
    );
  });
});

describe('the open preview takes the pointer', () => {
  it('stays open when the pointer crosses from its row into the preview', () => {
    const left = reducePreview(OPEN_A, leaveRow(ROW_A));
    const inside = reducePreview(left.state, { type: 'panelEnter', target: ROW_A });
    expect(inside.state.target).toStrictEqual(ROW_A);
    expect(inside.effects).toStrictEqual([{ type: 'cancel', timer: 'close' }]);
  });

  it('closes after the grace when the pointer leaves the preview', () => {
    const left = reducePreview(OPEN_A, { type: 'panelLeave', target: ROW_A });
    expect(left.state.target).toStrictEqual(ROW_A);
    expect(left.effects).toStrictEqual([{ type: 'schedule', timer: 'close', delayMs: 250 }]);
    expect(reducePreview(left.state, fire('close')).state.target).toBeNull();
  });

  it('closes once the pointer has left both the row and the preview', () => {
    const away = run(
      OPEN_A,
      leaveRow(ROW_A),
      { type: 'panelEnter', target: ROW_A },
      { type: 'panelLeave', target: ROW_A },
    );
    expect(away.target).toStrictEqual(ROW_A);
    expect(run(away, fire('close')).target).toBeNull();
  });
});

describe('scrolling', () => {
  const insideScroll: PreviewEvent = { type: 'scroll', insidePreview: true, movesRow: false };
  const pageScroll: PreviewEvent = { type: 'scroll', insidePreview: false, movesRow: true };
  const elsewhereScroll: PreviewEvent = { type: 'scroll', insidePreview: false, movesRow: false };

  it('leaves the preview open while its own text scrolls', () => {
    const scrolled = reducePreview(OPEN_A, insideScroll);
    expect(scrolled.state.target).toStrictEqual(ROW_A);
    expect(scrolled.effects).toStrictEqual([]);
  });

  it('closes the preview when the page or the row container moves', () => {
    const scrolled = reducePreview(OPEN_A, pageScroll);
    expect(scrolled.state.target).toBeNull();
    expect(scrolled.state.anchor).toBeNull();
    expect(scrolled.effects).toStrictEqual([
      { type: 'cancel', timer: 'open' },
      { type: 'cancel', timer: 'close' },
    ]);
  });

  it('drops a pending open when the page moves', () => {
    const pending = reducePreview(INITIAL_PREVIEW_STATE, enterRow(ROW_A)).state;
    expect(reducePreview(pending, pageScroll).state).toStrictEqual(INITIAL_PREVIEW_STATE);
  });

  it('ignores a scroll that moves neither the page nor the row', () => {
    expect(reducePreview(OPEN_A, elsewhereScroll)).toStrictEqual({ state: OPEN_A, effects: [] });
  });
});

describe('escape and dismissal', () => {
  it('closes the preview and dismisses its row', () => {
    const escaped = reducePreview(OPEN_A, ESCAPE);
    expect(escaped.state).toStrictEqual({
      target: null,
      anchor: null,
      pending: null,
      pendingAnchor: null,
      dismissed: 'herdr:pane-a',
      drawer: null,
      pinned: false,
      panelHovered: false,
    });
    expect(escaped.effects).toStrictEqual([
      { type: 'cancel', timer: 'open' },
      { type: 'cancel', timer: 'close' },
    ]);
  });

  it('does nothing when the dismissed row is entered again', () => {
    const dismissed = reducePreview(OPEN_A, ESCAPE).state;
    const again = reducePreview(dismissed, enterRow(ROW_A));
    expect(again.state).toStrictEqual(dismissed);
    expect(again.effects).toStrictEqual([]);
  });

  it('dismisses a pending row when Escape arrives before it opens', () => {
    const pending = reducePreview(INITIAL_PREVIEW_STATE, enterRow(ROW_A)).state;
    const escaped = reducePreview(pending, ESCAPE);
    expect(escaped.state).toStrictEqual({ ...INITIAL_PREVIEW_STATE, dismissed: 'herdr:pane-a' });
    expect(escaped.effects).toStrictEqual([
      { type: 'cancel', timer: 'open' },
      { type: 'cancel', timer: 'close' },
    ]);
    expect(reducePreview(escaped.state, fire('open')).state.target).toBeNull();
  });

  it('keeps the earlier dismissal when Escape arrives with nothing open', () => {
    const dismissed = reducePreview(OPEN_A, ESCAPE).state;
    expect(reducePreview(dismissed, ESCAPE).state.dismissed).toBe('herdr:pane-a');
  });

  it('clears the dismissal when the pointer leaves the dismissed row', () => {
    const dismissed = reducePreview(OPEN_A, ESCAPE).state;
    const cleared = reducePreview(dismissed, leaveRow(ROW_A));
    expect(cleared.state.dismissed).toBeNull();
    expect(reducePreview(cleared.state, enterRow(ROW_A)).effects).toStrictEqual([
      { type: 'cancel', timer: 'open' },
      { type: 'schedule', timer: 'open', delayMs: 350 },
    ]);
  });

  it('does not let a dismissed row block a different row', () => {
    const dismissed = reducePreview(OPEN_A, ESCAPE).state;
    expect(reducePreview(dismissed, enterRow(ROW_B, ANCHOR_B)).state.pending).toStrictEqual(ROW_B);
  });
});

describe('close event', () => {
  it('clears the open preview and any pending one', () => {
    const closed = reducePreview(OPEN_A, CLOSE);
    expect(closed.state).toStrictEqual(INITIAL_PREVIEW_STATE);
    expect(closed.effects).toStrictEqual([
      { type: 'cancel', timer: 'open' },
      { type: 'cancel', timer: 'close' },
    ]);

    const pending = reducePreview(INITIAL_PREVIEW_STATE, enterRow(ROW_B, ANCHOR_B)).state;
    expect(reducePreview(pending, CLOSE).state).toStrictEqual(INITIAL_PREVIEW_STATE);
  });

  it('keeps a dismissal', () => {
    const dismissed = reducePreview(OPEN_A, ESCAPE).state;
    const pending = reducePreview(dismissed, enterRow(ROW_B, ANCHOR_B)).state;
    expect(reducePreview(pending, CLOSE).state).toStrictEqual({
      ...INITIAL_PREVIEW_STATE,
      dismissed: 'herdr:pane-a',
    });
  });
});

describe('press and drawer subject', () => {
  it('a press closes the open preview and keeps its row shut', () => {
    const pressed = reducePreview(OPEN_A, pressRow(ROW_A));
    expect(pressed.state).toStrictEqual({ ...INITIAL_PREVIEW_STATE, dismissed: 'herdr:pane-a' });
    expect(pressed.effects).toStrictEqual([
      { type: 'cancel', timer: 'open' },
      { type: 'cancel', timer: 'close' },
    ]);
  });

  it('a press cancels a pending open', () => {
    const pending = reducePreview(INITIAL_PREVIEW_STATE, enterRow(ROW_A)).state;
    const pressed = reducePreview(pending, pressRow(ROW_A)).state;
    expect(pressed.pending).toBeNull();
    expect(run(pressed, fire('open')).target).toBeNull();
  });

  it('a row re-entered after a press stays shut until the pointer leaves it', () => {
    const pressed = reducePreview(OPEN_A, pressRow(ROW_A)).state;
    expect(reducePreview(pressed, enterRow(ROW_A))).toStrictEqual({ state: pressed, effects: [] });
    expect(run(pressed, fire('open')).target).toBeNull();
    expect(run(pressed, leaveRow(ROW_A), enterRow(ROW_A), fire('open')).target).toStrictEqual(
      ROW_A,
    );
  });

  it('a press on one row does not block a different row', () => {
    const pressed = reducePreview(OPEN_A, pressRow(ROW_A)).state;
    expect(reducePreview(pressed, enterRow(ROW_B, ANCHOR_B)).state.pending).toStrictEqual(ROW_B);
  });

  it('closes the open preview when the drawer opens on its subject', () => {
    const shown = reducePreview(OPEN_A, drawerShows('herdr:pane-a'));
    expect(shown.state).toStrictEqual({ ...INITIAL_PREVIEW_STATE, drawer: 'herdr:pane-a' });
    expect(shown.effects).toStrictEqual([
      { type: 'cancel', timer: 'open' },
      { type: 'cancel', timer: 'close' },
    ]);
  });

  it('cancels the pending open when the drawer opens on its subject', () => {
    const pending = reducePreview(INITIAL_PREVIEW_STATE, enterRow(ROW_A)).state;
    const shown = reducePreview(pending, drawerShows('herdr:pane-a')).state;
    expect(shown.pending).toBeNull();
    expect(run(shown, fire('open')).target).toBeNull();
  });

  it('gives no preview to the row the drawer shows', () => {
    const shown = reducePreview(INITIAL_PREVIEW_STATE, drawerShows('herdr:pane-a')).state;
    expect(reducePreview(shown, enterRow(ROW_A))).toStrictEqual({ state: shown, effects: [] });
  });

  it('does not block other rows while the drawer shows a subject', () => {
    const shown = reducePreview(INITIAL_PREVIEW_STATE, drawerShows('herdr:pane-a')).state;
    expect(reducePreview(shown, enterRow(ROW_B, ANCHOR_B)).state.pending).toStrictEqual(ROW_B);
  });

  it('lets the row open again once the drawer shows something else', () => {
    const shown = reducePreview(INITIAL_PREVIEW_STATE, drawerShows('herdr:pane-a')).state;
    const cleared = reducePreview(shown, drawerShows(null)).state;
    expect(cleared.drawer).toBeNull();
    expect(reducePreview(cleared, enterRow(ROW_A)).effects).toStrictEqual([
      { type: 'cancel', timer: 'open' },
      { type: 'schedule', timer: 'open', delayMs: 350 },
    ]);
  });

  it('returns the same state for a drawer event that changes nothing', () => {
    const shown = reducePreview(INITIAL_PREVIEW_STATE, drawerShows('herdr:pane-a')).state;
    expect(reducePreview(shown, drawerShows('herdr:pane-a'))).toStrictEqual({
      state: shown,
      effects: [],
    });
  });

  it('keeps the drawer subject through a press and Escape', () => {
    const shown = reducePreview(INITIAL_PREVIEW_STATE, drawerShows('herdr:pane-a')).state;
    expect(run(shown, pressRow(ROW_B), ESCAPE).drawer).toBe('herdr:pane-a');
  });
});

describe('previewTargetOfSubject', () => {
  it('maps a herdr pane and a session to their rows', () => {
    expect(previewTargetOfSubject({ kind: 'herdr', paneId: 'pane-a' })).toStrictEqual(ROW_A);
    expect(previewTargetOfSubject({ kind: 'session', sessionId: 'sess-b' })).toStrictEqual(ROW_B);
  });

  it('maps no drawer, and no subject that lacks a row, to null', () => {
    expect(previewTargetOfSubject(null)).toBeNull();
    expect(previewTargetOfSubject({ kind: 'task', taskId: 'task-1' })).toBeNull();
    expect(previewTargetOfSubject({ kind: 'files' })).toBeNull();
  });
});

describe('timers that no longer apply', () => {
  it('treats an open timer with nothing pending as a no-op', () => {
    expect(reducePreview(INITIAL_PREVIEW_STATE, fire('open'))).toStrictEqual({
      state: INITIAL_PREVIEW_STATE,
      effects: [],
    });
  });

  it('treats a close timer with nothing open as a no-op', () => {
    expect(reducePreview(INITIAL_PREVIEW_STATE, fire('close'))).toStrictEqual({
      state: INITIAL_PREVIEW_STATE,
      effects: [],
    });
  });
});

describe('placePreview', () => {
  // A board area 1000 px wide and 600 px tall, starting at the window's origin.
  const BOARD: PreviewRect = { left: 0, top: 0, right: 1000, bottom: 600 };

  it('places the preview to the right of its row when there is room', () => {
    expect(placePreview(ANCHOR_A, BOARD)).toStrictEqual({
      left: 308,
      top: 50,
      width: 520,
      height: 300,
    });
  });

  it('flips to the left of its row near the right edge', () => {
    const nearEdge: PreviewRect = { left: 900, top: 50, right: 950, bottom: 70 };
    expect(placePreview(nearEdge, BOARD)).toStrictEqual({
      left: 372,
      top: 50,
      width: 520,
      height: 300,
    });
  });

  it('flips upward when the row sits near the bottom of the board area', () => {
    const lowRow: PreviewRect = { left: 100, top: 540, right: 300, bottom: 560 };
    expect(placePreview(lowRow, BOARD)).toStrictEqual({
      left: 308,
      top: 260,
      width: 520,
      height: 300,
    });
  });

  it('keeps a flipped preview above the bottom margin, clear of the composer', () => {
    const lowRow: PreviewRect = { left: 100, top: 580, right: 300, bottom: 600 };
    const box = placePreview(lowRow, BOARD);
    expect(box.top).toBe(292);
    expect(box.top + box.height).toBeLessThanOrEqual(BOARD.bottom - 8);
  });

  it('clamps the top to the top margin', () => {
    const aboveView: PreviewRect = { left: 100, top: -20, right: 300, bottom: 0 };
    expect(placePreview(aboveView, BOARD).top).toBe(8);
  });

  it('stays inside the board area beside an open drawer', () => {
    // On a 1024 px board the open drawer starts at x = 464, so the preview must end before it.
    const beforeDrawer: PreviewRect = { left: 0, top: 0, right: 464, bottom: 600 };
    const box = placePreview(ANCHOR_A, beforeDrawer);
    expect(box).toStrictEqual({ left: 8, top: 50, width: 448, height: 300 });
    expect(box.left + box.width).toBeLessThanOrEqual(464 - 8);
  });

  it('keeps the preview inside a board area that does not start at the window origin', () => {
    // The sidebar takes 300 px on the left and the top bar 90 px at the top.
    const board: PreviewRect = { left: 300, top: 90, right: 1000, bottom: 600 };
    const row: PreviewRect = { left: 100, top: 40, right: 290, bottom: 60 };
    expect(placePreview(row, board)).toStrictEqual({ left: 308, top: 98, width: 520, height: 300 });
  });

  it('fits a board area smaller than the preview inside the margins', () => {
    const smallAnchor: PreviewRect = { left: 150, top: 100, right: 200, bottom: 120 };
    expect(placePreview(smallAnchor, { left: 0, top: 0, right: 300, bottom: 200 })).toStrictEqual({
      left: 8,
      top: 8,
      width: 284,
      height: 184,
    });
  });

  it('never returns a negative size', () => {
    const tiny: PreviewRect = { left: 1, top: 1, right: 2, bottom: 2 };
    expect(placePreview(tiny, { left: 0, top: 0, right: 4, bottom: 4 })).toStrictEqual({
      left: 8,
      top: 8,
      width: 0,
      height: 0,
    });
  });
});

describe('pinning: an input in use holds the preview open', () => {
  const PINNED_A = run(OPEN_A, { type: 'pin', pinned: true });
  const pageScroll: PreviewEvent = { type: 'scroll', insidePreview: false, movesRow: true };

  it('pinning cancels the grace timer, so a close that was due does not land', () => {
    const left = reducePreview(OPEN_A, leaveRow(ROW_A));
    const pinned = reducePreview(left.state, { type: 'pin', pinned: true });
    expect(pinned.state.pinned).toBe(true);
    expect(pinned.effects).toStrictEqual([{ type: 'cancel', timer: 'close' }]);
    expect(run(pinned.state, fire('close')).target).toStrictEqual(ROW_A);
  });

  it('leaving the pinned row or its panel schedules no close', () => {
    expect(reducePreview(PINNED_A, leaveRow(ROW_A)).effects).toStrictEqual([]);
    const away = reducePreview(PINNED_A, { type: 'panelLeave', target: ROW_A });
    expect(away.state.panelHovered).toBe(false);
    expect(away.effects).toStrictEqual([]);
    expect(run(away.state, fire('close')).target).toStrictEqual(ROW_A);
  });

  it('releasing the pin starts the grace when the pointer is outside the panel', () => {
    const released = reducePreview(PINNED_A, { type: 'pin', pinned: false });
    expect(released.state.pinned).toBe(false);
    expect(released.effects).toStrictEqual([{ type: 'schedule', timer: 'close', delayMs: 250 }]);
    expect(run(released.state, fire('close')).target).toBeNull();
  });

  it('releasing the pin keeps the preview open while the pointer is over its panel', () => {
    const hovering = run(PINNED_A, { type: 'panelEnter', target: ROW_A });
    const released = reducePreview(hovering, { type: 'pin', pinned: false });
    expect(released.effects).toStrictEqual([]);
    expect(released.state.target).toStrictEqual(ROW_A);
  });

  it('ignores scrolls that move its row, resizes, and hovers of other rows', () => {
    expect(reducePreview(PINNED_A, pageScroll).state.target).toStrictEqual(ROW_A);
    expect(reducePreview(PINNED_A, CLOSE)).toStrictEqual({ state: PINNED_A, effects: [] });
    expect(reducePreview(PINNED_A, enterRow(ROW_B, ANCHOR_B))).toStrictEqual({
      state: PINNED_A,
      effects: [],
    });
  });

  it('Escape and a press outside close it and release the pin', () => {
    const escaped = reducePreview(PINNED_A, ESCAPE);
    expect(escaped.state).toStrictEqual({ ...INITIAL_PREVIEW_STATE, dismissed: 'herdr:pane-a' });
    const dismissed = reducePreview(PINNED_A, { type: 'dismiss' });
    expect(dismissed.state).toStrictEqual(INITIAL_PREVIEW_STATE);
    expect(dismissed.effects).toStrictEqual([
      { type: 'cancel', timer: 'open' },
      { type: 'cancel', timer: 'close' },
    ]);
  });

  it('the drawer showing the pinned row still closes it', () => {
    const shown = reducePreview(PINNED_A, drawerShows('herdr:pane-a'));
    expect(shown.state.target).toBeNull();
    expect(shown.state.pinned).toBe(false);
  });

  it('pin events do nothing without an open preview, or when nothing changes', () => {
    expect(reducePreview(INITIAL_PREVIEW_STATE, { type: 'pin', pinned: true })).toStrictEqual({
      state: INITIAL_PREVIEW_STATE,
      effects: [],
    });
    expect(reducePreview(PINNED_A, { type: 'pin', pinned: true })).toStrictEqual({
      state: PINNED_A,
      effects: [],
    });
  });

  it('tracks whether the pointer is over the open panel', () => {
    const hovered = reducePreview(OPEN_A, { type: 'panelEnter', target: ROW_A }).state;
    expect(hovered.panelHovered).toBe(true);
    const left = reducePreview(hovered, { type: 'panelLeave', target: ROW_A }).state;
    expect(left.panelHovered).toBe(false);
  });
});

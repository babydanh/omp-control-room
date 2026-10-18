import { describe, expect, it } from 'vitest';

import {
  defaultActiveLane,
  drawerPresentation,
  isSheetDismissSwipe,
  LANE_SWIPE_THRESHOLD_PX,
  layoutModeFor,
  sidebarPresentation,
  stepActiveLane,
  swipeStep,
} from '../src/company/layoutMode.js';

describe('layoutModeFor', () => {
  it('puts a viewport under 768px on the phone layout', () => {
    expect(layoutModeFor(390)).toBe('phone');
    expect(layoutModeFor(767)).toBe('phone');
  });

  it('puts 768px through 1023px on the tablet layout', () => {
    expect(layoutModeFor(768)).toBe('tablet');
    expect(layoutModeFor(1023)).toBe('tablet');
  });

  it('puts 1024px and up on the desktop layout', () => {
    expect(layoutModeFor(1024)).toBe('desktop');
    expect(layoutModeFor(1568)).toBe('desktop');
  });

  it('treats a width that is not a number as desktop', () => {
    expect(layoutModeFor(Number.NaN)).toBe('desktop');
  });
});

describe('sidebarPresentation', () => {
  it('shows a phone sidebar as a sheet when open and nothing when collapsed', () => {
    expect(sidebarPresentation('phone', false)).toBe('sheet');
    expect(sidebarPresentation('phone', true)).toBe('hidden');
  });

  it('shows a tablet sidebar as a rail when collapsed and an overlay when open', () => {
    expect(sidebarPresentation('tablet', true)).toBe('rail');
    expect(sidebarPresentation('tablet', false)).toBe('overlay');
  });

  it('docks a desktop sidebar beside the lanes, or shrinks it to the rail', () => {
    expect(sidebarPresentation('desktop', false)).toBe('docked');
    expect(sidebarPresentation('desktop', true)).toBe('rail');
  });
});

describe('drawerPresentation', () => {
  it('fills the screen on a phone whatever the maximize pref says', () => {
    expect(drawerPresentation('phone', false)).toBe('fullscreen');
    expect(drawerPresentation('phone', true)).toBe('fullscreen');
  });

  it('floats over the board on a tablet', () => {
    expect(drawerPresentation('tablet', false)).toBe('overlay');
  });

  it('docks on the desktop unless maximized', () => {
    expect(drawerPresentation('desktop', false)).toBe('docked');
    expect(drawerPresentation('desktop', true)).toBe('maximized');
  });
});

describe('defaultActiveLane', () => {
  const order = ['needs_input', 'running', 'done'] as const;

  it('opens on the first lane in attention order that holds a card', () => {
    const lanes = [
      { id: 'done', count: 4 },
      { id: 'running', count: 1 },
      { id: 'needs_input', count: 0 },
    ] as const;
    expect(defaultActiveLane(lanes, order)).toBe('running');
  });

  it('falls back to the first lane when every lane is empty', () => {
    const lanes = [
      { id: 'done', count: 0 },
      { id: 'running', count: 0 },
    ] as const;
    expect(defaultActiveLane(lanes, order)).toBe('done');
  });

  it('returns null when there are no lanes', () => {
    expect(defaultActiveLane([], order)).toBeNull();
  });
});

describe('stepActiveLane', () => {
  const ids = ['planned', 'running', 'done'] as const;

  it('moves one lane in either direction', () => {
    expect(stepActiveLane(ids, 'running', 1)).toBe('done');
    expect(stepActiveLane(ids, 'running', -1)).toBe('planned');
  });

  it('stops at the ends instead of wrapping', () => {
    expect(stepActiveLane(ids, 'done', 1)).toBe('done');
    expect(stepActiveLane(ids, 'planned', -1)).toBe('planned');
  });

  it('starts at the first lane for an unknown current lane, and returns null for none', () => {
    expect(stepActiveLane(ids, 'missing' as 'planned', 1)).toBe('planned');
    expect(stepActiveLane([], 'planned', 1)).toBeNull();
  });
});

describe('swipeStep', () => {
  it('moves forward on a leftward swipe and back on a rightward one', () => {
    expect(swipeStep(-120, 4, LANE_SWIPE_THRESHOLD_PX)).toBe(1);
    expect(swipeStep(120, -4, LANE_SWIPE_THRESHOLD_PX)).toBe(-1);
  });

  it('ignores a drag shorter than the threshold', () => {
    expect(swipeStep(-LANE_SWIPE_THRESHOLD_PX + 1, 0, LANE_SWIPE_THRESHOLD_PX)).toBe(0);
  });

  it('ignores a drag that is more vertical than horizontal, so the list still scrolls', () => {
    expect(swipeStep(-60, -90, LANE_SWIPE_THRESHOLD_PX)).toBe(0);
  });
});

describe('sheet dismiss swipe', () => {
  it('dismisses on a leftward drag past the threshold', () => {
    expect(isSheetDismissSwipe(-LANE_SWIPE_THRESHOLD_PX, 0)).toBe(true);
  });

  it('keeps the sheet for a short drag, a rightward drag, or a mostly vertical one', () => {
    expect(isSheetDismissSwipe(-LANE_SWIPE_THRESHOLD_PX + 1, 0)).toBe(false);
    expect(isSheetDismissSwipe(LANE_SWIPE_THRESHOLD_PX, 0)).toBe(false);
    expect(isSheetDismissSwipe(-60, -90)).toBe(false);
  });
});

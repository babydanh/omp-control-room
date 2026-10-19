import { describe, expect, it } from 'vitest';

import {
  isScreenFrozen,
  reduceScreenFreeze,
  SCREEN_NOT_FROZEN,
} from '../src/company/screenFreeze.js';

describe('screen freeze', () => {
  it('holds while a press or a selection is live, and lifts only when both have ended', () => {
    let state = SCREEN_NOT_FROZEN;
    expect(isScreenFrozen(state)).toBe(false);

    state = reduceScreenFreeze(state, { type: 'press' });
    expect(isScreenFrozen(state)).toBe(true);

    state = reduceScreenFreeze(state, { type: 'selection', active: true });
    state = reduceScreenFreeze(state, { type: 'release' });
    expect(isScreenFrozen(state)).toBe(true);

    state = reduceScreenFreeze(state, { type: 'selection', active: false });
    expect(isScreenFrozen(state)).toBe(false);
  });

  it('lifts a press on release when no selection was made', () => {
    const pressed = reduceScreenFreeze(SCREEN_NOT_FROZEN, { type: 'press' });
    expect(isScreenFrozen(reduceScreenFreeze(pressed, { type: 'release' }))).toBe(false);
  });

  it('returns the same state when an event changes nothing', () => {
    const pressed = reduceScreenFreeze(SCREEN_NOT_FROZEN, { type: 'press' });
    expect(reduceScreenFreeze(pressed, { type: 'press' })).toBe(pressed);
    expect(reduceScreenFreeze(SCREEN_NOT_FROZEN, { type: 'release' })).toBe(SCREEN_NOT_FROZEN);
    expect(reduceScreenFreeze(SCREEN_NOT_FROZEN, { type: 'selection', active: false })).toBe(
      SCREEN_NOT_FROZEN,
    );
  });
});

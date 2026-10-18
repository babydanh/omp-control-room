import { describe, expect, it, vi } from 'vitest';

import {
  createLongPress,
  type LongPressPointer,
  type LongPressTimers,
} from '../src/company/longPress.js';

const DELAY_MS = 500;
const SLOP_PX = 10;

/** Timers driven by hand: nothing fires until the test advances the clock. */
interface FakeTimers extends LongPressTimers<number> {
  advance(ms: number): void;
  /** How many timers are scheduled and not yet cleared or fired. */
  pending(): number;
}

function fakeTimers(): FakeTimers {
  let now = 0;
  let nextHandle = 1;
  const scheduled = new Map<number, { due: number; run: () => void }>();
  return {
    setTimer(run: () => void, ms: number): number {
      const handle = nextHandle;
      nextHandle += 1;
      scheduled.set(handle, { due: now + ms, run });
      return handle;
    },
    clearTimer(handle: number): void {
      scheduled.delete(handle);
    },
    advance(ms: number): void {
      now += ms;
      for (const [handle, timer] of [...scheduled]) {
        // A timer cleared by an earlier callback in this pass must not fire.
        if (timer.due > now || !scheduled.has(handle)) continue;
        scheduled.delete(handle);
        timer.run();
      }
    },
    pending: () => scheduled.size,
  };
}

function touch(clientX = 100, clientY = 100): LongPressPointer {
  return { pointerType: 'touch', clientX, clientY };
}

function setup() {
  const timers = fakeTimers();
  const onLongPress = vi.fn();
  const press = createLongPress({ delayMs: DELAY_MS, slopPx: SLOP_PX, onLongPress, timers });
  return { timers, onLongPress, press };
}

describe('createLongPress', () => {
  it('fires once the touch has been held for delayMs', () => {
    const { timers, onLongPress, press } = setup();

    press.down(touch());
    timers.advance(DELAY_MS - 1);
    expect(onLongPress).not.toHaveBeenCalled();

    timers.advance(1);
    expect(onLongPress).toHaveBeenCalledTimes(1);
  });

  it('fires for a pen as well as a touch', () => {
    const { timers, onLongPress, press } = setup();

    press.down({ pointerType: 'pen', clientX: 100, clientY: 100 });
    timers.advance(DELAY_MS);

    expect(onLongPress).toHaveBeenCalledTimes(1);
  });

  it('never fires for a mouse, which opens its menu on right-click', () => {
    const { timers, onLongPress, press } = setup();

    press.down({ pointerType: 'mouse', clientX: 100, clientY: 100 });
    timers.advance(DELAY_MS * 10);

    expect(onLongPress).not.toHaveBeenCalled();
    expect(timers.pending()).toBe(0);
  });

  it('still fires while the pointer stays within slopPx of where it went down', () => {
    const { timers, onLongPress, press } = setup();

    press.down(touch(100, 100));
    press.move(touch(106, 106)); // about 8.5px away
    press.move(touch(110, 100)); // exactly slopPx away: the boundary still counts as inside

    timers.advance(DELAY_MS);
    expect(onLongPress).toHaveBeenCalledTimes(1);
  });

  it('cancels once the pointer moves beyond slopPx from where it went down', () => {
    const { timers, onLongPress, press } = setup();

    press.down(touch(100, 100));
    press.move(touch(106, 100)); // 6px from the start: still inside
    press.move(touch(112, 100)); // 12px from the start, though only 6px from the last move

    expect(timers.pending()).toBe(0);
    timers.advance(DELAY_MS);
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it('stays cancelled when the pointer drifts back inside the slop', () => {
    const { timers, onLongPress, press } = setup();

    press.down(touch(100, 100));
    press.move(touch(120, 100));
    press.move(touch(100, 100));

    timers.advance(DELAY_MS);
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it('cancels when end() is called', () => {
    const { timers, onLongPress, press } = setup();

    press.down(touch());
    press.end();

    expect(timers.pending()).toBe(0);
    timers.advance(DELAY_MS);
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it('replaces a pending press when a new down starts', () => {
    const { timers, onLongPress, press } = setup();

    press.down(touch(100, 100));
    timers.advance(300);
    press.down(touch(200, 200));
    expect(timers.pending()).toBe(1);
    press.move(touch(205, 200)); // slop is measured from the newest down, not the first

    timers.advance(DELAY_MS - 1); // the first press would have fired at 500ms
    expect(onLongPress).not.toHaveBeenCalled();

    timers.advance(1);
    expect(onLongPress).toHaveBeenCalledTimes(1);
  });

  it('a mouse down cancels a pending touch press', () => {
    const { timers, onLongPress, press } = setup();

    press.down(touch());
    press.down({ pointerType: 'mouse', clientX: 100, clientY: 100 });

    expect(timers.pending()).toBe(0);
    timers.advance(DELAY_MS * 2);
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it('is harmless to call end() after the press has fired', () => {
    const { timers, onLongPress, press } = setup();

    press.down(touch());
    timers.advance(DELAY_MS);
    press.end();
    press.end();
    timers.advance(DELAY_MS);

    expect(onLongPress).toHaveBeenCalledTimes(1);
  });

  it('can start another press after one has fired', () => {
    const { timers, onLongPress, press } = setup();

    press.down(touch());
    timers.advance(DELAY_MS);
    press.down(touch());
    timers.advance(DELAY_MS);

    expect(onLongPress).toHaveBeenCalledTimes(2);
  });
});

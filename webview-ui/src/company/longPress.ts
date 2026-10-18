/**
 * Touch and pen long-press, used to open a context menu. DOM-free: the caller injects the timer
 * functions and feeds pointer samples in, so the logic runs under test without real timers.
 */

/** The pointer fields a press reads: a structural subset of the DOM PointerEvent. */
export interface LongPressPointer {
  pointerType: string;
  clientX: number;
  clientY: number;
}

/** Schedules and cancels the press timer. `Handle` is whatever the host timer returns. */
export interface LongPressTimers<Handle> {
  setTimer(run: () => void, ms: number): Handle;
  clearTimer(handle: Handle): void;
}

export interface LongPressOptions<Handle> {
  /** How long a touch or pen must stay down before the press fires. */
  delayMs: number;
  /** How far, in CSS pixels, the pointer may drift from where it went down. */
  slopPx: number;
  onLongPress: () => void;
  timers: LongPressTimers<Handle>;
}

export interface LongPress {
  /** Starts a press for a touch or pen. Cancels any pending press first, even for a mouse. */
  down(pointer: LongPressPointer): void;
  /** Cancels the pending press once the pointer is more than `slopPx` from where it went down. */
  move(pointer: LongPressPointer): void;
  /** Cancels the pending press, if any. */
  end(): void;
}

interface Press<Handle> {
  readonly startX: number;
  readonly startY: number;
  readonly handle: Handle;
}

/** Creates a long-press tracker. Mouse pointers never start a press; right-click handles those. */
export function createLongPress<Handle>(options: LongPressOptions<Handle>): LongPress {
  const { delayMs, slopPx, onLongPress, timers } = options;
  let press: Press<Handle> | null = null;

  function cancel(): void {
    if (press === null) return;
    const { handle } = press;
    press = null;
    timers.clearTimer(handle);
  }

  return {
    down(pointer) {
      cancel();
      if (pointer.pointerType === 'mouse') return;
      const handle = timers.setTimer(() => {
        press = null;
        onLongPress();
      }, delayMs);
      press = { startX: pointer.clientX, startY: pointer.clientY, handle };
    },
    move(pointer) {
      if (press === null) return;
      const dx = pointer.clientX - press.startX;
      const dy = pointer.clientY - press.startY;
      if (Math.hypot(dx, dy) > slopPx) cancel();
    },
    end: cancel,
  };
}

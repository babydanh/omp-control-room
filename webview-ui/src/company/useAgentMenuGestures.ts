/**
 * useAgentMenuGestures: every way into an agent's menu. A right click or the
 * context-menu key opens it (agentMenuTriggers), and so does a touch or pen held
 * still for LONG_PRESS_MS (createLongPress). A long press anchors the menu where
 * the finger went down. `onPress` runs on every pointer down, so a row's terminal
 * preview still closes on press.
 *
 * Spread this after any preview triggers: its `onPointerDown` replaces theirs, and
 * it calls their press through `onPress` instead.
 */

import { type PointerEvent as ReactPointerEvent, useLayoutEffect, useRef, useState } from 'react';

import {
  type AgentMenuRequest,
  type AgentMenuSubject,
  type AgentMenuTriggers,
  agentMenuTriggers,
  type MenuTarget,
  type Point,
} from './agentMenu.js';
import { createLongPress, type LongPress } from './longPress.js';

/** How long a touch or pen must rest before the menu opens, in milliseconds. */
const LONG_PRESS_MS = 500;

/** How far, in CSS pixels, a resting finger may drift before the press is a scroll. */
const LONG_PRESS_SLOP_PX = 10;

export interface AgentMenuGestures<T extends MenuTarget> extends AgentMenuTriggers<T> {
  onPointerDown: (event: ReactPointerEvent<T>) => void;
  onPointerMove: (event: ReactPointerEvent<T>) => void;
  onPointerUp: () => void;
  onPointerCancel: () => void;
}

/** Where a press began, and the element it began on. */
interface PressOrigin {
  anchor: Point;
  target: MenuTarget;
}

export function useAgentMenuGestures<T extends MenuTarget>(
  subject: AgentMenuSubject,
  open: (request: AgentMenuRequest) => void,
  onPress?: () => void,
): AgentMenuGestures<T> {
  // The latest subject and callbacks, read when a long press fires.
  const latest = useRef({ subject, open, onPress });
  const origin = useRef<PressOrigin | null>(null);
  useLayoutEffect(() => {
    latest.current = { subject, open, onPress };
  });
  const [press] = useState<LongPress>(() =>
    createLongPress<number>({
      delayMs: LONG_PRESS_MS,
      slopPx: LONG_PRESS_SLOP_PX,
      timers: {
        setTimer: window.setTimeout.bind(window),
        clearTimer: window.clearTimeout.bind(window),
      },
      onLongPress: () => {
        const started = origin.current;
        origin.current = null;
        if (started === null) return;
        const current = latest.current;
        current.open({
          subject: current.subject,
          anchor: started.anchor,
          returnFocus: started.target,
        });
      },
    }),
  );

  function onPointerDown(event: ReactPointerEvent<T>): void {
    latest.current.onPress?.();
    origin.current = {
      anchor: { x: event.clientX, y: event.clientY },
      target: event.currentTarget,
    };
    press.down(event);
  }

  return {
    ...agentMenuTriggers<T>(subject, open),
    onPointerDown,
    onPointerMove: press.move,
    onPointerUp: press.end,
    onPointerCancel: press.end,
  };
}

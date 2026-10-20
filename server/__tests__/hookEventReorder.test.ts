import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HOOK_EVENT_TIMESTAMP_FIELD } from '../src/constants.js';
import { HookEventReorderer } from '../src/hookEventReorder.js';

const WINDOW_MS = 100;

function stamped(name: string, ts: number, sessionId = 's1'): Record<string, unknown> {
  return { session_id: sessionId, hook_event_name: name, [HOOK_EVENT_TIMESTAMP_FIELD]: ts };
}

describe('HookEventReorderer', () => {
  let seen: string[];
  let reorder: HookEventReorderer;

  beforeEach(() => {
    vi.useFakeTimers();
    seen = [];
    reorder = new HookEventReorderer(
      (_provider, event) => seen.push(`${String(event.session_id)}:${String(event.hook_event_name)}`),
      WINDOW_MS,
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('dispatches events that arrive inverted within the window in spawn order', () => {
    reorder.push('claude', stamped('PostToolUse', 1_010));
    vi.advanceTimersByTime(30);
    reorder.push('claude', stamped('PreToolUse', 1_000));
    expect(seen).toEqual([]);
    vi.advanceTimersByTime(WINDOW_MS);
    expect(seen).toEqual(['s1:PreToolUse', 's1:PostToolUse']);
  });

  it('keeps sessions independent: one session never holds back another', () => {
    reorder.push('claude', stamped('Stop', 2_000, 'a'));
    vi.advanceTimersByTime(60);
    reorder.push('claude', stamped('Stop', 1_000, 'b'));
    vi.advanceTimersByTime(WINDOW_MS - 60);
    expect(seen).toEqual(['a:Stop']);
    vi.advanceTimersByTime(60);
    expect(seen).toEqual(['a:Stop', 'b:Stop']);
  });

  it('passes unstamped events straight through', () => {
    reorder.push('claude', { session_id: 's1', hook_event_name: 'Stop' });
    expect(seen).toEqual(['s1:Stop']);
  });

  it('a straggler later than the window is still delivered, never dropped', () => {
    reorder.push('claude', stamped('PostToolUse', 1_010));
    vi.advanceTimersByTime(WINDOW_MS);
    reorder.push('claude', stamped('PreToolUse', 1_000));
    vi.advanceTimersByTime(WINDOW_MS);
    expect(seen).toEqual(['s1:PostToolUse', 's1:PreToolUse']);
  });

  it('flush delivers everything still held, in order', () => {
    reorder.push('claude', stamped('SessionEnd', 3_000));
    reorder.push('claude', stamped('Stop', 2_000));
    reorder.flush();
    expect(seen).toEqual(['s1:Stop', 's1:SessionEnd']);
    vi.advanceTimersByTime(WINDOW_MS);
    expect(seen).toHaveLength(2);
  });
});

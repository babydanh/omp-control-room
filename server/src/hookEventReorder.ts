import { HOOK_EVENT_TIMESTAMP_FIELD, HOOK_REORDER_WINDOW_MS } from './constants.js';

type Dispatch = (providerId: string, event: Record<string, unknown>) => void;

interface HeldEvent {
  readonly providerId: string;
  readonly event: Record<string, unknown>;
  readonly ts: number;
  readonly seq: number;
}

/**
 * Restores per-session order of async hook deliveries.
 *
 * Each stamped event waits HOOK_REORDER_WINDOW_MS; when its timer fires it
 * releases every held event of the same session stamped no later than itself,
 * oldest first. An event that arrives after a newer one was already released
 * is dispatched as soon as its own window ends — order cannot be repaired past
 * the window, only bounded. Unstamped events (older hook scripts, other
 * providers) pass straight through.
 */
export class HookEventReorderer {
  private readonly held = new Map<string, HeldEvent[]>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private seq = 0;

  constructor(
    private readonly dispatch: Dispatch,
    private readonly windowMs: number = HOOK_REORDER_WINDOW_MS,
  ) {}

  push(providerId: string, event: Record<string, unknown>): void {
    const ts = event[HOOK_EVENT_TIMESTAMP_FIELD];
    const sessionId = event.session_id;
    if (typeof ts !== 'number' || !Number.isFinite(ts) || typeof sessionId !== 'string') {
      this.dispatch(providerId, event);
      return;
    }
    const entry: HeldEvent = { providerId, event, ts, seq: this.seq++ };
    const queue = this.held.get(sessionId);
    if (queue === undefined) this.held.set(sessionId, [entry]);
    else queue.push(entry);
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      this.release(sessionId, entry);
    }, this.windowMs);
    timer.unref?.();
    this.timers.add(timer);
  }

  /** Dispatches everything still held, in order. Used on shutdown. */
  flush(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    for (const sessionId of [...this.held.keys()]) {
      this.drain(sessionId, () => true);
    }
  }

  private release(sessionId: string, trigger: HeldEvent): void {
    this.drain(
      sessionId,
      (candidate) =>
        candidate.ts < trigger.ts || (candidate.ts === trigger.ts && candidate.seq <= trigger.seq),
    );
  }

  private drain(sessionId: string, due: (candidate: HeldEvent) => boolean): void {
    const queue = this.held.get(sessionId);
    if (queue === undefined) return;
    const ready = queue.filter(due).sort((a, b) => a.ts - b.ts || a.seq - b.seq);
    const rest = queue.filter((candidate) => !due(candidate));
    if (rest.length === 0) this.held.delete(sessionId);
    else this.held.set(sessionId, rest);
    for (const item of ready) this.dispatch(item.providerId, item.event);
  }
}

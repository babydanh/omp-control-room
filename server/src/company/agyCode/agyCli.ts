/** Pure Antigravity CLI argv and stream-json parsing for work-item runs. */

import { isRecord } from '../typeGuards.js';

export const AGY_COMMAND = 'agy';
export const AGY_RUN_TIMEOUT_MS = 30 * 60_000;

/**
 * Prompt goes through stdin (`--input-format text`), so there is no `-p`: agy's `-p` takes the next
 * argument as the prompt, and a bare `-p` before another flag exits 2 without running. A follow-up
 * continues the run's conversation (`--conversation <id>`): a fresh run would get the follow-up text
 * with no task behind it.
 */
export function agyWorkerArgs(timeoutMs = AGY_RUN_TIMEOUT_MS, conversationId?: string): string[] {
  const timeout = timeoutMs === AGY_RUN_TIMEOUT_MS ? '30m' : `${Math.ceil(timeoutMs / 1000)}s`;
  return [
    '--output-format', 'stream-json', '--input-format', 'text', '--print-timeout', timeout,
    ...(conversationId === undefined ? [] : ['--conversation', conversationId]),
  ];
}

/** A tool headless agy refused because its permission rules did not allow it. */
export interface AgyDeniedAction {
  /** The permission kind, as a settings.json rule names it (`command`, `write`, ...). */
  readonly action: string;
  readonly displayName: string;
}

export interface AgyResultEvent {
  readonly kind: 'result';
  readonly status: string;
  readonly response: string;
  readonly usage?: Record<string, unknown>;
  readonly numTurns?: number;
  readonly error?: string;
  readonly deniedActions?: readonly AgyDeniedAction[];
}

export type AgyStreamEvent =
  | { readonly kind: 'init'; readonly conversationId?: string }
  | { readonly kind: 'progress'; readonly text: string }
  | AgyResultEvent;

const MAX_PROGRESS_CHARS = 300;

/** Reads one Antigravity stream-json record. Unknown and malformed lines are ignored. */
export function parseAgyStreamLine(line: string): AgyStreamEvent | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line.trim());
  } catch {
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  if (value['event'] === 'init') {
    // agy 1.x puts conversation_id beside `init`, not in it; both are read.
    const init = value['init'];
    const id = typeof value['conversation_id'] === 'string'
      ? value['conversation_id']
      : isRecord(init) && typeof init['conversation_id'] === 'string' ? init['conversation_id'] : undefined;
    return { kind: 'init', ...(id === undefined ? {} : { conversationId: id }) };
  }
  if (value['event'] === 'step_update') {
    const update = value['step_update'];
    if (!isRecord(update)) return undefined;
    const textDelta = typeof update['text_delta'] === 'string' ? update['text_delta'].trim() : '';
    const stepType = typeof update['step_type'] === 'string' ? update['step_type'].trim() : '';
    const text = textDelta === '' ? stepType : stepType === '' ? textDelta : `${stepType}: ${textDelta}`;
    return text === '' ? undefined : { kind: 'progress', text: clipText(text, MAX_PROGRESS_CHARS) };
  }
  if (value['event'] === 'result') {
    const result = value['result'];
    if (!isRecord(result)) return undefined;
    const denied = Array.isArray(result['denied_actions'])
      ? result['denied_actions'].flatMap((entry): AgyDeniedAction[] =>
        isRecord(entry) && typeof entry['action'] === 'string'
          ? [{ action: entry['action'], displayName: typeof entry['display_name'] === 'string' ? entry['display_name'] : entry['action'] }]
          : [])
      : [];
    return {
      kind: 'result',
      status: typeof result['status'] === 'string' ? result['status'] : '',
      response: typeof result['response'] === 'string' ? result['response'] : '',
      ...(isRecord(result['usage']) ? { usage: result['usage'] } : {}),
      ...(typeof result['num_turns'] === 'number' ? { numTurns: result['num_turns'] } : {}),
      ...(typeof result['error'] === 'string' ? { error: result['error'] } : {}),
      ...(denied.length === 0 ? {} : { deniedActions: denied }),
    };
  }
  return undefined;
}

function clipText(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = 0;
  let count = 0;
  while (end < text.length && count < max) {
    const code = text.codePointAt(end) ?? 0;
    end += code > 0xffff ? 2 : 1;
    count += 1;
  }
  return text.slice(0, end);
}

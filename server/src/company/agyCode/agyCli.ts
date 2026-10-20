/** Pure Antigravity CLI argv and stream-json parsing for work-item runs. */

import { isRecord } from '../typeGuards.js';

export const AGY_COMMAND = 'agy';
export const AGY_RUN_TIMEOUT_MS = 30 * 60_000;

export function agyWorkerArgs(timeoutMs = AGY_RUN_TIMEOUT_MS): string[] {
  const timeout = timeoutMs === AGY_RUN_TIMEOUT_MS ? '30m' : `${Math.ceil(timeoutMs / 1000)}s`;
  return ['-p', '--output-format', 'stream-json', '--input-format', 'text', '--print-timeout', timeout];
}
export interface AgyResultEvent {
  readonly kind: 'result';
  readonly status: string;
  readonly response: string;
  readonly usage?: Record<string, unknown>;
  readonly numTurns?: number;
  readonly error?: string;
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
    const init = value['init'];
    return {
      kind: 'init',
      ...(isRecord(init) && typeof init['conversation_id'] === 'string'
        ? { conversationId: init['conversation_id'] }
        : {}),
    };
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
    return {
      kind: 'result',
      status: typeof result['status'] === 'string' ? result['status'] : '',
      response: typeof result['response'] === 'string' ? result['response'] : '',
      ...(isRecord(result['usage']) ? { usage: result['usage'] } : {}),
      ...(typeof result['num_turns'] === 'number' ? { numTurns: result['num_turns'] } : {}),
      ...(typeof result['error'] === 'string' ? { error: result['error'] } : {}),
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

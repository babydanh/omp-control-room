/**
 * The Claude Code CLI facts the bridge depends on: argv for an item run and for a one-shot turn, the
 * auth status reading, the stream-json lines, and a turn's JSON output. Pure: no I/O and no process,
 * so every rule here is tested without a binary.
 */

import { isRecord } from '../typeGuards.js';

/** The program name. Spawned without a shell, so Windows needs a real `claude.exe` on PATH. */
export const CLAUDE_COMMAND = 'claude';

/** What the auth probe concluded. Matches the state the core `ClaudeCodeStatus` carries. */
export type ClaudeAuthState = 'unknown' | 'missing' | 'signed_out' | 'signed_in';

/** The permission mode an editing run starts in. `auto` lets the classifier review each action. */
export type ClaudePermission = 'auto' | 'acceptEdits';

/** One item run: an editing run or a read-only run, opening or resuming one session. */
export interface ClaudeRunArgs {
  readonly mode: 'edit' | 'read';
  /** The permission mode of an editing run. A read-only run always plans. */
  readonly permission: ClaudePermission;
  /** Tool patterns an editing run may use without asking. A read-only run gets none. */
  readonly allowedTools: readonly string[];
  readonly sessionId: string;
  /** `--resume` continues the session; otherwise `--session-id` opens it. */
  readonly resume: boolean;
  readonly agent?: string;
  readonly maxTurns: number;
  readonly maxBudgetUsd: number;
}

/** One event read from a stream-json line. */
export type ClaudeStreamEvent =
  | { readonly kind: 'init'; readonly sessionId?: string }
  | { readonly kind: 'progress'; readonly text: string }
  | {
      readonly kind: 'result';
      readonly isError: boolean;
      readonly subtype: string;
      readonly resultText: string;
      readonly sessionId?: string;
      readonly permissionDenials: number;
    };

/** A turn's answer, or the reason it has none. */
export type ClaudeTurnParse =
  { readonly ok: true; readonly text: string } | { readonly ok: false; readonly reason: string };

/** Longest progress text kept, in characters, as the work item contract allows. */
const PROGRESS_MAX_CHARS = 300;
/** Longest reason a failed turn carries, in characters. */
const TURN_REASON_MAX_CHARS = 300;

const NO_RESULT_REASON = 'Claude Code không trả về kết quả.';
const EMPTY_RESULT_REASON = 'Claude Code trả về rỗng.';
const ERROR_RESULT_REASON = 'Claude Code gặp lỗi.';

const AUTH_LABELS: Record<ClaudeAuthState, string> = {
  missing: 'Claude Code: chưa cài',
  signed_out: 'Claude Code: chưa đăng nhập — chạy `claude` để đăng nhập',
  signed_in: 'Claude Code: đã đăng nhập (gói Claude)',
  unknown: 'Claude Code: chưa kiểm tra',
};

/** The argv for `claude auth status`. Only the `loggedIn` and `authMethod` of its answer are read. */
export const CLAUDE_AUTH_ARGS: readonly string[] = ['auth', 'status'];

/**
 * The argv for one item run. An editing run starts in its permission mode and may use the allowed
 * tools without asking; a read-only run only plans and gets no allowlist. Permission prompts are
 * off, so a run never waits on a person. The prompt goes on stdin.
 */
export function claudeRunArgs(args: ClaudeRunArgs): string[] {
  const edit = args.mode === 'edit';
  return [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--permission-prompts',
    'none',
    '--permission-mode',
    edit ? args.permission : 'plan',
    '--max-turns',
    String(args.maxTurns),
    '--max-budget-usd',
    String(args.maxBudgetUsd),
    // --allowedTools reads its values up to the next flag, so the flags after it start with `--`.
    ...(edit && args.allowedTools.length > 0 ? ['--allowedTools', ...args.allowedTools] : []),
    ...(args.agent === undefined ? [] : ['--agent', args.agent]),
    ...(args.resume ? ['--resume', args.sessionId] : ['--session-id', args.sessionId]),
  ];
}

/**
 * The argv for one leader or judge turn: print mode, no tools, no saved session, and one answer
 * checked against the schema. Two turns allow for a structured-output retry. The prompt goes on stdin.
 */
export function claudeTurnArgs(input: {
  readonly model: string;
  readonly schemaJson: string;
}): string[] {
  return [
    '-p',
    '--tools',
    '',
    '--no-session-persistence',
    '--output-format',
    'json',
    '--json-schema',
    input.schemaJson,
    '--model',
    input.model,
    '--max-turns',
    '2',
  ];
}

/**
 * Reads the auth probe's outcome from `claude auth status`. Only the answer's `loggedIn` and
 * `authMethod` decide: signed in needs `loggedIn` true and an `authMethod` that names a real method,
 * never `none` or an empty value. The CLI answers signed out with exit 1 and JSON, so the JSON
 * decides. A killed probe (no exit code), or output that is not a JSON object, is unknown.
 */
export function parseAuthStatus(exitCode: number | null, stdout: string): ClaudeAuthState {
  if (exitCode === null) return 'unknown';
  const value = parseJson(stdout.trim());
  if (!isRecord(value)) return 'unknown';
  const method = value['authMethod'];
  const signedIn =
    value['loggedIn'] === true && typeof method === 'string' && method !== '' && method !== 'none';
  return signedIn ? 'signed_in' : 'signed_out';
}

/** The Vietnamese status line the board shows for an auth state. */
export function claudeStatusLabel(state: ClaudeAuthState): string {
  return AUTH_LABELS[state];
}

/**
 * Reads one stream-json line. Progress is the latest assistant text block, or the tool a tool-use
 * block names. Unknown and malformed lines read as nothing.
 */
export function parseStreamLine(line: string): ClaudeStreamEvent | undefined {
  const value = parseJson(line.trim());
  if (!isRecord(value)) return undefined;
  if (value['type'] === 'system') {
    return value['subtype'] === 'init'
      ? { kind: 'init', sessionId: stringField(value, 'session_id') }
      : undefined;
  }
  if (value['type'] === 'assistant') return assistantEvent(value);
  if (value['type'] === 'result') {
    const denials = value['permission_denials'];
    return {
      kind: 'result',
      isError: value['is_error'] === true,
      subtype: stringField(value, 'subtype') ?? '',
      resultText: stringField(value, 'result') ?? '',
      sessionId: stringField(value, 'session_id'),
      permissionDenials: Array.isArray(denials) ? denials.length : 0,
    };
  }
  return undefined;
}

/**
 * Reads a one-shot turn's output. The answer is the last result object. An error result gives its
 * text as the reason. A validated `structured_output` is the answer as JSON; otherwise the plain
 * `result` text is.
 */
export function parseTurnOutput(stdout: string): ClaudeTurnParse {
  const result = turnResultRecord(stdout);
  if (result === undefined) return { ok: false, reason: NO_RESULT_REASON };
  const resultText = (stringField(result, 'result') ?? '').trim();
  if (result['is_error'] === true) {
    const reason = resultText === '' ? ERROR_RESULT_REASON : resultText;
    return { ok: false, reason: clipText(reason, TURN_REASON_MAX_CHARS) };
  }
  const structured = result['structured_output'];
  if (structured !== undefined && structured !== null) {
    return { ok: true, text: JSON.stringify(structured) };
  }
  if (resultText === '') return { ok: false, reason: EMPTY_RESULT_REASON };
  return { ok: true, text: resultText };
}

/**
 * Trims text to at most `max` characters (code points), never splitting a surrogate pair. Text that
 * is already short enough comes back as it is.
 */
export function clipText(text: string, max: number): string {
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

/** The latest text or tool-use block of one assistant message, as a progress line. */
function assistantEvent(value: Record<string, unknown>): ClaudeStreamEvent | undefined {
  const message = value['message'];
  if (!isRecord(message)) return undefined;
  const content = message['content'];
  if (!Array.isArray(content)) return undefined;
  const blocks: unknown[] = content;
  let progress: string | undefined;
  for (const block of blocks) {
    if (!isRecord(block)) continue;
    const text = stringField(block, 'text');
    if (block['type'] === 'text' && text !== undefined && text.trim() !== '') {
      progress = text.trim();
    } else if (block['type'] === 'tool_use') {
      const name = stringField(block, 'name');
      if (name !== undefined) progress = `Dùng công cụ: ${name}`;
    }
  }
  if (progress === undefined) return undefined;
  return { kind: 'progress', text: clipText(progress, PROGRESS_MAX_CHARS) };
}

/**
 * The last result object of a turn's output: from the last non-empty line that parses to a result,
 * or, when the whole output is one multi-line JSON document, from that document.
 */
function turnResultRecord(stdout: string): Record<string, unknown> | undefined {
  for (const line of stdout.split(/\r?\n/).reverse()) {
    const value = parseJson(line.trim());
    if (isTurnResult(value)) return value;
  }
  const whole = parseJson(stdout.trim());
  const items: unknown[] = Array.isArray(whole) ? whole : [whole];
  return items.reverse().find(isTurnResult);
}

function isTurnResult(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && value['type'] === 'result';
}

/** A string field of a record, or undefined when it is absent or not a string. */
function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

/** Parses one JSON document. Undefined when the text is not JSON. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

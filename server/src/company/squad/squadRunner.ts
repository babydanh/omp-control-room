/**
 * Runs one squad turn as a print-mode omp process and reads its final answer. The leader and the
 * judge both run this way. The prompt goes through a private temp file and the process runs without
 * a shell, so no text from the request or the team is ever interpreted by a shell.
 */

import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';

import type { OmpRunnerCommand } from '../ompRunner.js';
import { isRecord } from '../typeGuards.js';
import { clip } from '../workItems/workItemModel.js';
import { SQUAD_TURN_TIMEOUT_MS } from './squadModel.js';

/** Largest stdout one turn may produce before the process is stopped. */
const LEADER_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

/** The name a turn carries in the errors the user reads, when the caller gives none. */
const LEADER_LABEL = 'Đội trưởng';

const execFileAsync = promisify(execFile);

/** A turn failure whose message is shown to the user as it is. */
export class SquadLeaderError extends Error {}

/** What a running turn has produced so far: reasoning is counted, never shown; the answer's tail is. */
export interface LeaderLive {
  readonly phase: 'thinking' | 'writing';
  readonly chars: number;
  readonly text?: string;
}

/** One turn: the prompt in, the final text out. `onLive` hears the turn's progress, when the engine streams it. */
export interface LeaderRunner {
  run(prompt: string, signal: AbortSignal, onLive?: (live: LeaderLive) => void): Promise<string>;
}

/** The last characters of the answer a live update carries. */
const LIVE_TEXT_CHARS = 1500;
/** At most one live update per this many milliseconds. */
const LIVE_INTERVAL_MS = 1000;

/**
 * Reads omp's JSON-lines stdout as it arrives and reports the turn's progress: `thinking_delta`
 * events are counted, `text_delta` events build the answer. Updates are spaced by
 * {@link LIVE_INTERVAL_MS}; `now` is injected for tests.
 */
export function createLiveReader(
  onLive: (live: LeaderLive) => void,
  now: () => number = Date.now,
): (chunk: string) => void {
  let carry = '';
  let thinking = 0;
  let text = '';
  let last = Number.NEGATIVE_INFINITY;
  return (chunk) => {
    const lines = (carry + chunk).split('\n');
    carry = lines.pop() ?? '';
    let changed = false;
    for (const line of lines) {
      if (!line.includes('"message_update"')) continue;
      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      const update = isRecord(event) ? event['assistantMessageEvent'] : undefined;
      if (!isRecord(update) || typeof update['delta'] !== 'string') continue;
      if (update['type'] === 'thinking_delta') thinking += update['delta'].length;
      else if (update['type'] === 'text_delta') text += update['delta'];
      else continue;
      changed = true;
    }
    if (!changed || now() - last < LIVE_INTERVAL_MS) return;
    last = now();
    onLive(text === '' ? { phase: 'thinking', chars: thinking } : { phase: 'writing', chars: text.length, text: text.slice(-LIVE_TEXT_CHARS) });
  };
}

/** What one omp process run needs. `execute` is replaced in tests. */
export interface LeaderProcessRequest {
  readonly file: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
  /** Who the turn is for, in the errors the user reads. */
  readonly who: string;
  /** Hears stdout as it arrives, before the whole output resolves. */
  readonly onStdout?: (chunk: string) => void;
}

/** Runs the process and resolves with its stdout. */
export type LeaderProcess = (request: LeaderProcessRequest) => Promise<string>;

export interface OmpLeaderRunnerOptions {
  /** The host's native omp launch: a Node executable plus its arguments. */
  readonly command: OmpRunnerCommand;
  /** The folder the turn runs in. The turn has no tools, so this only sets its context. */
  readonly cwd: string;
  /** Bare `provider/model` for the role the turn runs under. */
  readonly model: string;
  /** Thinking level, or null to let omp decide. */
  readonly thinking: string | null;
  readonly timeoutMs?: number;
  /** Who the turn is for, in the errors the user reads. Defaults to the squad leader. */
  readonly label?: string;
  readonly execute?: LeaderProcess;
}

/** The argument list for one print-mode turn. */
export function leaderArgs(
  command: OmpRunnerCommand,
  model: string,
  thinking: string | null,
  promptPath: string,
): string[] {
  return [
    ...command.args,
    '-p',
    '--no-session',
    '--no-tools',
    '--no-extensions',
    '--no-skills',
    '--no-rules',
    '--no-title',
    '--mode',
    'json',
    '--model',
    model,
    ...(thinking === null ? [] : ['--thinking', thinking]),
    `@${promptPath}`,
  ];
}

/**
 * Reads the final text from omp's JSON-lines output: the last `agent_end` event carries the whole
 * conversation, and the last assistant message holds the answer. Throws a user-facing error, named
 * by `who`, when omp reports a failure or the answer is empty.
 */
export function leaderTextFromOutput(stdout: string, who = LEADER_LABEL): string {
  let messages: readonly unknown[] | undefined;
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let event: unknown;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (isRecord(event) && event['type'] === 'agent_end' && Array.isArray(event['messages'])) {
      messages = event['messages'];
    }
  }
  if (messages === undefined) {
    throw new SquadLeaderError(`${who} không trả lời. Thử lại.`);
  }
  let assistant: Record<string, unknown> | undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (isRecord(message) && message['role'] === 'assistant') {
      assistant = message;
      break;
    }
  }
  if (assistant === undefined) {
    throw new SquadLeaderError(`${who} không trả lời. Thử lại.`);
  }
  const stopReason = assistant['stopReason'];
  if (stopReason === 'error' || stopReason === 'aborted') {
    const rawDetail = assistant['errorMessage'];
    const detail = typeof rawDetail === 'string' ? clip(rawDetail, 300) : '';
    throw new SquadLeaderError(
      detail === '' ? `${who} gặp lỗi. Thử lại.` : `${who} gặp lỗi: ${detail}. Thử lại.`,
    );
  }
  const content = assistant['content'];
  const text = Array.isArray(content)
    ? content
        .flatMap((part: unknown) =>
          isRecord(part) && part['type'] === 'text' && typeof part['text'] === 'string'
            ? [part['text']]
            : [],
        )
        .join('')
        .trim()
    : '';
  if (text === '') {
    throw new SquadLeaderError(`${who} trả về rỗng. Thử lại.`);
  }
  return text;
}

/** Runs omp with the given arguments, no shell, stdin closed, and a bounded stdout. */
export async function execLeaderProcess(request: LeaderProcessRequest): Promise<string> {
  const child = execFileAsync(request.file, [...request.args], {
    cwd: request.cwd,
    timeout: request.timeoutMs,
    killSignal: 'SIGTERM',
    maxBuffer: LEADER_MAX_OUTPUT_BYTES,
    windowsHide: true,
    signal: request.signal,
    encoding: 'utf8',
  });
  child.child.stdin?.end();
  if (request.onStdout !== undefined) {
    child.child.stdout?.on('data', (chunk: Buffer | string) => request.onStdout?.(chunk.toString()));
  }
  try {
    const { stdout } = await child;
    return stdout;
  } catch (error) {
    throw leaderProcessError(error, request.signal.aborted, request.who);
  }
}

/** Creates the runner the squad service calls for each turn. */
export function createOmpLeaderRunner(options: OmpLeaderRunnerOptions): LeaderRunner {
  const execute = options.execute ?? execLeaderProcess;
  const timeoutMs = options.timeoutMs ?? SQUAD_TURN_TIMEOUT_MS;
  const who = options.label ?? LEADER_LABEL;
  return {
    async run(prompt, signal, onLive) {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'squad-leader-'));
      try {
        const promptPath = path.join(dir, 'prompt.md');
        await fs.writeFile(promptPath, prompt, { encoding: 'utf8', mode: 0o600 });
        const stdout = await execute({
          file: options.command.file,
          args: leaderArgs(options.command, options.model, options.thinking, promptPath),
          cwd: options.cwd,
          timeoutMs,
          signal,
          who,
          ...(onLive === undefined ? {} : { onStdout: createLiveReader(onLive) }),
        });
        return leaderTextFromOutput(stdout, who);
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    },
  };
}

function leaderProcessError(error: unknown, aborted: boolean, who: string): SquadLeaderError {
  if (aborted) return new SquadLeaderError(`${who} đã dừng.`);
  if (isRecord(error) && error['killed'] === true) {
    return new SquadLeaderError(`${who} trả lời quá lâu (hơn 4 phút). Thử lại.`);
  }
  const rawStderr = isRecord(error) ? error['stderr'] : undefined;
  const stderr = typeof rawStderr === 'string' ? rawStderr.trim() : '';
  const message = error instanceof Error ? error.message : String(error);
  return new SquadLeaderError(
    `${who} không chạy được: ${clip(stderr === '' ? message : stderr, 300)}`,
  );
}

/**
 * Runs one squad leader turn as a print-mode omp process and reads its final answer. The prompt
 * goes through a private temp file and the process runs without a shell, so no text from the
 * request or the team is ever interpreted by a shell.
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

/** Largest stdout one leader turn may produce before the process is stopped. */
const LEADER_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

const execFileAsync = promisify(execFile);

/** A leader failure whose message is shown to the user as it is. */
export class SquadLeaderError extends Error {}

/** One leader turn: the prompt in, the leader's final text out. */
export interface LeaderRunner {
  run(prompt: string, signal: AbortSignal): Promise<string>;
}

/** What one omp process run needs. `execute` is replaced in tests. */
export interface LeaderProcessRequest {
  readonly file: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
}

/** Runs the process and resolves with its stdout. */
export type LeaderProcess = (request: LeaderProcessRequest) => Promise<string>;

export interface OmpLeaderRunnerOptions {
  /** The host's native omp launch: a Node executable plus its arguments. */
  readonly command: OmpRunnerCommand;
  /** The folder the leader runs in. The leader has no tools, so this only sets its context. */
  readonly cwd: string;
  /** Bare `provider/model` for the Director role. */
  readonly model: string;
  /** Thinking level, or null to let omp decide. */
  readonly thinking: string | null;
  readonly timeoutMs?: number;
  readonly execute?: LeaderProcess;
}

/** The argument list for one print-mode leader turn. */
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
 * Reads the leader's final text from omp's JSON-lines output: the last `agent_end` event carries
 * the whole conversation, and the last assistant message holds the answer. Throws a user-facing
 * error when omp reports a failure or the answer is empty.
 */
export function leaderTextFromOutput(stdout: string): string {
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
    throw new SquadLeaderError('Đội trưởng không trả lời. Thử lại.');
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
    throw new SquadLeaderError('Đội trưởng không trả lời. Thử lại.');
  }
  const stopReason = assistant['stopReason'];
  if (stopReason === 'error' || stopReason === 'aborted') {
    const rawDetail = assistant['errorMessage'];
    const detail = typeof rawDetail === 'string' ? clip(rawDetail, 300) : '';
    throw new SquadLeaderError(
      detail === '' ? 'Đội trưởng gặp lỗi. Thử lại.' : `Đội trưởng gặp lỗi: ${detail}. Thử lại.`,
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
    throw new SquadLeaderError('Đội trưởng trả về rỗng. Thử lại.');
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
  try {
    const { stdout } = await child;
    return stdout;
  } catch (error) {
    throw leaderProcessError(error, request.signal.aborted);
  }
}

/** Creates the runner the squad service calls for each leader turn. */
export function createOmpLeaderRunner(options: OmpLeaderRunnerOptions): LeaderRunner {
  const execute = options.execute ?? execLeaderProcess;
  const timeoutMs = options.timeoutMs ?? SQUAD_TURN_TIMEOUT_MS;
  return {
    async run(prompt, signal) {
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
        });
        return leaderTextFromOutput(stdout);
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    },
  };
}

function leaderProcessError(error: unknown, aborted: boolean): SquadLeaderError {
  if (aborted) return new SquadLeaderError('Đội trưởng đã dừng.');
  if (isRecord(error) && error['killed'] === true) {
    return new SquadLeaderError('Đội trưởng trả lời quá lâu (hơn 4 phút). Thử lại.');
  }
  const rawStderr = isRecord(error) ? error['stderr'] : undefined;
  const stderr = typeof rawStderr === 'string' ? rawStderr.trim() : '';
  const message = error instanceof Error ? error.message : String(error);
  return new SquadLeaderError(
    `Đội trưởng không chạy được: ${clip(stderr === '' ? message : stderr, 300)}`,
  );
}

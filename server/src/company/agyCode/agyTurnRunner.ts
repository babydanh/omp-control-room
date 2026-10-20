import { clipText } from '../claudeCode/claudeCli.js';
import type {
  ClaudeClearTimer,
  ClaudeSetTimer,
  ClaudeSpawn,
  ClaudeTurnOutcome,
} from '../claudeCode/claudeProcess.js';
import {
  CLAUDE_SPAWN_ENOENT,
  defaultClaudeSpawn,
  runClaudeTurn,
} from '../claudeCode/claudeProcess.js';
import type { LeaderRunner } from '../squad/squadRunner.js';
import { SquadLeaderError } from '../squad/squadRunner.js';
import { isRecord } from '../typeGuards.js';
const AGY_COMMAND = 'agy';
const AGY_TIMEOUT_MS = 4 * 60_000;
const AGY_PRINT_TIMEOUT = '4m';
const AGY_MISSING_MESSAGE = 'Không tìm thấy Antigravity CLI (lệnh agy). Cài Antigravity CLI rồi thử lại.';
const AGY_TIMEOUT_MESSAGE = 'Antigravity CLI quá 4 phút chưa trả lời. Thử lại.';

export interface AgyTurnRunnerOptions {
  readonly cwd: string;
  readonly label: string;
  readonly schema: object;
  readonly timeoutMs?: number;
  readonly spawn?: ClaudeSpawn;
  readonly setTimer?: ClaudeSetTimer;
  readonly clearTimer?: ClaudeClearTimer;
}

/** Runs one leader or judge turn through agy, returning its schema-constrained response text. */
export function createAgyTurnRunner(options: AgyTurnRunnerOptions): LeaderRunner {
  const spawn = options.spawn ?? defaultClaudeSpawn();
  const schemaJson = JSON.stringify(options.schema);
  return {
    async run(prompt, signal) {
      const outcome = await runClaudeTurn({
        spawn,
        file: AGY_COMMAND,
        cwd: options.cwd,
        args: [
          '-p',
          '--output-format',
          'json',
          '--json-schema',
          schemaJson,
          '--input-format',
          'text',
          '--print-timeout',
          AGY_PRINT_TIMEOUT,
        ],
        prompt,
        timeoutMs: options.timeoutMs ?? AGY_TIMEOUT_MS,
        signal,
        setTimer: options.setTimer,
        clearTimer: options.clearTimer,
      });
      return turnText(outcome, options.label, signal.aborted);
    },
  };
}

function turnText(outcome: ClaudeTurnOutcome, label: string, aborted: boolean): string {
  if (outcome.timedOut) throw new SquadLeaderError(AGY_TIMEOUT_MESSAGE);
  if (outcome.spawnError !== undefined) {
    if (outcome.spawnError === CLAUDE_SPAWN_ENOENT) {
      throw new SquadLeaderError(AGY_MISSING_MESSAGE);
    }
    throw new SquadLeaderError(`${label} không chạy được: ${clipText(outcome.spawnError, 300)}`);
  }
  if (aborted) throw new SquadLeaderError(`${label} đã dừng.`);

  let result: unknown;
  try {
    result = JSON.parse(outcome.stdout);
  } catch {
    throw new SquadLeaderError(`${label} nhận kết quả không phải JSON từ Antigravity CLI. Thử lại.`);
  }
  if (!isRecord(result)) {
    throw new SquadLeaderError(`${label} nhận kết quả không phải JSON hợp lệ từ Antigravity CLI. Thử lại.`);
  }
  if (outcome.exitCode === 0 && result['status'] === 'SUCCESS') {
    const response = result['response'];
    if (typeof response === 'string' && response.trim() !== '') return response;
    throw new SquadLeaderError(`${label} không trả về câu trả lời. Thử lại.`);
  }
  const error = typeof result['error'] === 'string' ? result['error'].trim() : '';
  const status = typeof result['status'] === 'string' ? result['status'] : 'không rõ';
  const detail = error === '' ? `trạng thái ${status}` : clipText(error, 300);
  throw new SquadLeaderError(`${label} chạy Antigravity CLI gặp lỗi: ${detail}. Thử lại.`);
}

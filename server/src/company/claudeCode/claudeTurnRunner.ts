/**
 * Runs the squad's leader and judge turns through Claude Code in print mode, answering a JSON
 * schema. The engine switch sends each turn to omp or to Claude Code, read at the moment of the
 * turn, so the squad service holds one runner.
 */

import type { LeaderRunner } from '../squad/squadRunner.js';
import { SquadLeaderError } from '../squad/squadRunner.js';
import type { SquadEngine } from '../workItems/squadSettings.js';
import { claudeTurnArgs, clipText, parseTurnOutput } from './claudeCli.js';
import type {
  ClaudeClearTimer,
  ClaudeSetTimer,
  ClaudeSpawn,
  ClaudeTurnOutcome,
} from './claudeProcess.js';
import { CLAUDE_SPAWN_ENOENT, defaultClaudeSpawn, runClaudeTurn } from './claudeProcess.js';
const TURN_MISSING_MESSAGE =
  'Không tìm thấy Claude Code (lệnh claude). Cài Claude Code rồi thử lại.';
const TURN_TIMEOUT_MESSAGE = 'Claude Code quá 4 phút chưa trả lời. Thử lại.';
const TURN_FALLBACK_REASON = 'Claude Code kết thúc lỗi.';
const TURN_DETAIL_MAX_CHARS = 300;
/** Longest a leader or judge turn may run before its process tree is stopped: four minutes. */
const TURN_TIMEOUT_MS = 4 * 60_000;

export interface ClaudeTurnRunnerOptions {
  /** The folder the turn runs in. The turn has no tools, so this only sets its context. */
  readonly cwd: string;
  /** Who the turn is for, in the errors the user reads: Đội trưởng or Giám khảo. */
  readonly label: string;
  /** Bare model alias or id, read on every turn. */
  readonly model: () => string;
  /** The JSON schema the answer must match. */
  readonly schema: object;
  /** Longest the turn may run. Defaults to four minutes, the wait the error message names. */
  readonly timeoutMs?: number;
  readonly spawn?: ClaudeSpawn;
  readonly setTimer?: ClaudeSetTimer;
  readonly clearTimer?: ClaudeClearTimer;
}

/** One leader or judge turn through Claude Code. */
export function createClaudeTurnRunner(options: ClaudeTurnRunnerOptions): LeaderRunner {
  const spawn = options.spawn ?? defaultClaudeSpawn();
  const schemaJson = JSON.stringify(options.schema);
  return {
    async run(prompt, signal) {
      const outcome = await runClaudeTurn({
        spawn,
        cwd: options.cwd,
        args: claudeTurnArgs({ model: options.model(), schemaJson }),
        prompt,
        timeoutMs: options.timeoutMs ?? TURN_TIMEOUT_MS,
        signal,
        setTimer: options.setTimer,
        clearTimer: options.clearTimer,
      });
      return turnText(outcome, options.label, signal.aborted);
    },
  };
}

/** Routes each turn to the engine the settings name when the turn starts. */
export function createEngineRunner(options: {
  readonly engine: () => SquadEngine;
  readonly omp: LeaderRunner;
  readonly claude: LeaderRunner;
  readonly agy: LeaderRunner;
}): LeaderRunner {
  return {
    run(prompt, signal, onLive) {
      // Only the omp runner streams; Claude and agy runs ignore onLive.
      return options[options.engine()].run(prompt, signal, onLive);
    },
  };
}

/** The answer of one finished turn, or the Vietnamese error the user reads. */
function turnText(outcome: ClaudeTurnOutcome, label: string, aborted: boolean): string {
  if (outcome.timedOut) throw new SquadLeaderError(TURN_TIMEOUT_MESSAGE);
  if (outcome.spawnError !== undefined) {
    if (outcome.spawnError === CLAUDE_SPAWN_ENOENT) {
      throw new SquadLeaderError(TURN_MISSING_MESSAGE);
    }
    const detail = clipText(outcome.spawnError, TURN_DETAIL_MAX_CHARS);
    throw new SquadLeaderError(`${label} không chạy được: ${detail}`);
  }
  const parsed = parseTurnOutput(outcome.stdout);
  if (outcome.exitCode === 0 && parsed.ok) return parsed.text;
  if (aborted) throw new SquadLeaderError(`${label} đã dừng.`);
  // Reached only on a failure: a non-zero exit, or exit 0 with no usable answer.
  const exitFailed = outcome.exitCode !== 0;
  const stderr = clipText(outcome.stderr.trim(), TURN_DETAIL_MAX_CHARS);
  const cause =
    exitFailed && stderr !== '' ? stderr : parsed.ok ? TURN_FALLBACK_REASON : parsed.reason;
  const codeText = outcome.exitCode === null ? 'không rõ' : String(outcome.exitCode);
  const head = exitFailed ? `${label} gặp lỗi (mã thoát ${codeText})` : `${label} gặp lỗi`;
  const period = /[.!?]$/u.test(cause) ? '' : '.';
  throw new SquadLeaderError(`${head}: ${cause}${period} Thử lại.`);
}

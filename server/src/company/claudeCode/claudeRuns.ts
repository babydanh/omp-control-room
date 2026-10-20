/**
 * Runs Claude Code in stream-json mode for one work item at a time and tracks each run for the
 * board. Output is read line by line and only the latest progress and the final result are kept,
 * so a long run never grows memory. Every run ends once: exit, error, timeout, or kill all go
 * through the same end path, which clears the timer and notifies listeners.
 */

import { CLAUDE_COMMAND, claudeRunArgs, clipText, parseStreamLine } from './claudeCli.js';
import {
  type ClaudeChildProcess,
  type ClaudeClearTimer,
  type ClaudeSetTimer,
  type ClaudeSpawn,
  type ClaudeTimerHandle,
  createLineSplitter,
  createTextCapture,
  defaultClaudeSpawn,
  defaultClearTimer,
  defaultSetTimer,
  isSpawnNotFound,
  killClaudeTree,
  sendPrompt,
} from './claudeProcess.js';

/** Longest a run may go before its process tree is stopped: 30 minutes. */
const CLAUDE_RUN_TIMEOUT_MS = 30 * 60_000;
/** Longest final result kept on a run, in characters. */
const CLAUDE_RUN_RESULT_MAX_CHARS = 4000;
/** Longest error detail kept on a run, in characters. */
const RUN_ERROR_DETAIL_MAX_CHARS = 300;
/** Longest single stream line read; a longer line is dropped whole. */
const RUN_LINE_MAX_CHARS = 4 * 1024 * 1024;
/** Stderr kept from one run; the rest is dropped. */
const RUN_STDERR_MAX_BYTES = 64 * 1024;

const RUN_MISSING_MESSAGE = 'Không tìm thấy lệnh claude. Cài Claude Code rồi chạy lại.';
const RUN_TIMEOUT_MESSAGE = 'Claude Code chạy quá lâu và đã bị dừng.';
const RUN_NO_RESULT_MESSAGE = 'Claude Code kết thúc nhưng không trả về kết quả.';
const RUN_ERROR_RESULT_MESSAGE = 'Claude Code gặp lỗi.';

export type ClaudeRunState = 'running' | 'finished' | 'failed' | 'timeout' | 'killed';

export interface ClaudeRunStart {
  readonly cwd: string;
  readonly prompt: string;
  readonly mode: 'edit' | 'read';
  readonly sessionId: string;
  readonly resume: boolean;
  readonly agent?: string;
  readonly maxTurns: number;
  readonly maxBudgetUsd: number;
}

export interface ClaudeRunView {
  readonly runId: string;
  readonly state: ClaudeRunState;
  readonly sessionId: string;
  /** True once the first non-blank stream line arrived, which means the CLI opened the session. */
  readonly started: boolean;
  readonly pid?: number;
  readonly progress?: string;
  readonly result?: string;
  readonly error?: string;
}

export interface ClaudeRuns {
  start(input: ClaudeRunStart): { readonly runId: string; readonly pid?: number };
  view(runId: string): ClaudeRunView | undefined;
  /** Stops a running run's process tree. A run that already ended is left as it is. */
  kill(runId: string): void;
  /** Removes a run. A run still running is killed first, so no process outlives its record. */
  forget(runId: string): void;
  onChange(listener: () => void): () => void;
}

export interface ClaudeRunsOptions {
  readonly spawn?: ClaudeSpawn;
  readonly killTree?: (pid: number) => void;
  readonly newRunId: () => string;
  readonly timeoutMs?: number;
  readonly setTimer?: ClaudeSetTimer;
  readonly clearTimer?: ClaudeClearTimer;
  readonly resultMaxChars?: number;
}

interface RunEntry {
  readonly runId: string;
  readonly sessionId: string;
  state: ClaudeRunState;
  started: boolean;
  pid: number | undefined;
  progress: string | undefined;
  result: string | undefined;
  error: string | undefined;
  child: ClaudeChildProcess | undefined;
  timer: ClaudeTimerHandle | undefined;
  /** The stream's result event, once it arrived. */
  ended: { readonly isError: boolean; readonly resultText: string } | undefined;
}

export function createClaudeRuns(options: ClaudeRunsOptions): ClaudeRuns {
  const spawn = options.spawn ?? defaultClaudeSpawn();
  const killTree = options.killTree ?? ((pid: number) => killClaudeTree(pid));
  const timeoutMs = options.timeoutMs ?? CLAUDE_RUN_TIMEOUT_MS;
  const setTimer = options.setTimer ?? defaultSetTimer;
  const clearTimer = options.clearTimer ?? defaultClearTimer;
  const resultMaxChars = options.resultMaxChars ?? CLAUDE_RUN_RESULT_MAX_CHARS;
  const runs = new Map<string, RunEntry>();
  const listeners = new Set<() => void>();

  function notify(): void {
    for (const listener of [...listeners]) listener();
  }

  /** Stops the run's process: its tree when the pid is known, otherwise the child itself. */
  function stopProcess(entry: RunEntry): void {
    if (entry.pid !== undefined) killTree(entry.pid);
    else entry.child?.kill();
  }

  /** Ends a running run once: clears its timer, drops its process, and notifies. */
  function end(
    entry: RunEntry,
    state: ClaudeRunState,
    outcome: { readonly result?: string; readonly error?: string } = {},
  ): void {
    if (entry.state !== 'running') return;
    if (entry.timer !== undefined) clearTimer(entry.timer);
    entry.timer = undefined;
    entry.child = undefined;
    entry.state = state;
    entry.result = outcome.result;
    entry.error = outcome.error;
    notify();
  }

  function killRun(entry: RunEntry): void {
    if (entry.state !== 'running') return;
    stopProcess(entry);
    end(entry, 'killed');
  }

  function onTimeout(entry: RunEntry): void {
    if (entry.state !== 'running') return;
    stopProcess(entry);
    end(entry, 'timeout', { error: RUN_TIMEOUT_MESSAGE });
  }

  function onLine(entry: RunEntry, line: string): void {
    if (entry.state !== 'running') return;
    if (!entry.started && line.trim() !== '') {
      entry.started = true;
      notify();
    }
    const event = parseStreamLine(line);
    if (event === undefined) return;
    if (event.kind === 'progress') {
      if (event.text !== entry.progress) {
        entry.progress = event.text;
        notify();
      }
    } else if (event.kind === 'result') {
      entry.ended = { isError: event.isError, resultText: event.resultText };
    }
  }

  function onError(entry: RunEntry, error: unknown): void {
    if (entry.state !== 'running') return;
    stopProcess(entry);
    end(entry, 'failed', { error: spawnFailureMessage(error) });
  }

  /** Decides the end state once the process closed: result first, then exit code, then a missing result. */
  function onClose(entry: RunEntry, code: number | null, stderrText: string): void {
    if (entry.state !== 'running') return;
    const ended = entry.ended;
    if (ended !== undefined && ended.isError) {
      const detail = ended.resultText.trim() === '' ? RUN_ERROR_RESULT_MESSAGE : ended.resultText;
      end(entry, 'failed', { error: clipText(detail, resultMaxChars) });
    } else if (code !== 0) {
      end(entry, 'failed', { error: exitMessage(code, stderrText) });
    } else if (ended === undefined) {
      end(entry, 'failed', { error: RUN_NO_RESULT_MESSAGE });
    } else {
      end(entry, 'finished', { result: clipText(ended.resultText, resultMaxChars) });
    }
  }

  /** Reads the child's output and close, so the decision waits for every byte. */
  function wire(entry: RunEntry, child: ClaudeChildProcess): void {
    const stderr = createTextCapture(RUN_STDERR_MAX_BYTES);
    const lines = createLineSplitter(RUN_LINE_MAX_CHARS, (line) => onLine(entry, line));
    child.stdout?.on('data', (chunk) => lines.push(chunk));
    child.stderr?.on('data', (chunk) => {
      stderr.push(chunk);
    });
    child.on('error', (error) => onError(entry, error));
    child.on('close', (code) => {
      lines.end();
      onClose(entry, code, stderr.text());
    });
  }

  return {
    start(input) {
      const runId = options.newRunId();
      const entry: RunEntry = {
        runId,
        sessionId: input.sessionId,
        state: 'running',
        started: false,
        pid: undefined,
        progress: undefined,
        result: undefined,
        error: undefined,
        child: undefined,
        timer: undefined,
        ended: undefined,
      };
      runs.set(runId, entry);
      let child: ClaudeChildProcess;
      try {
        child = spawn(
          CLAUDE_COMMAND,
          claudeRunArgs({
            mode: input.mode,
            sessionId: input.sessionId,
            resume: input.resume,
            agent: input.agent,
            maxTurns: input.maxTurns,
            maxBudgetUsd: input.maxBudgetUsd,
          }),
          { cwd: input.cwd },
        );
      } catch (error) {
        end(entry, 'failed', { error: spawnFailureMessage(error) });
        return { runId };
      }
      entry.child = child;
      entry.pid = child.pid;
      entry.timer = setTimer(() => onTimeout(entry), timeoutMs);
      wire(entry, child);
      sendPrompt(child, input.prompt);
      notify();
      return { runId, pid: child.pid };
    },

    view(runId) {
      const entry = runs.get(runId);
      if (entry === undefined) return undefined;
      return {
        runId: entry.runId,
        state: entry.state,
        sessionId: entry.sessionId,
        started: entry.started,
        pid: entry.pid,
        progress: entry.progress,
        result: entry.result,
        error: entry.error,
      };
    },

    kill(runId) {
      const entry = runs.get(runId);
      if (entry !== undefined) killRun(entry);
    },

    forget(runId) {
      const entry = runs.get(runId);
      if (entry === undefined) return;
      killRun(entry);
      runs.delete(runId);
      notify();
    },

    onChange(listener) {
      const subscribed = (): void => listener();
      listeners.add(subscribed);
      return () => {
        listeners.delete(subscribed);
      };
    },
  };
}

/** The message a run shows when its process could not start. */
function spawnFailureMessage(error: unknown): string {
  if (isSpawnNotFound(error)) return RUN_MISSING_MESSAGE;
  const detail = error instanceof Error ? error.message : String(error);
  return `Claude Code không chạy được: ${clipText(detail, RUN_ERROR_DETAIL_MAX_CHARS)}`;
}

/** The message for a process that exited without a usable result, with its code and stderr tail. */
function exitMessage(code: number | null, stderrText: string): string {
  const detail = clipText(stderrText.trim(), RUN_ERROR_DETAIL_MAX_CHARS);
  const codeText = code === null ? 'không rõ' : String(code);
  return detail === ''
    ? `Claude Code thoát với mã ${codeText}.`
    : `Claude Code thoát với mã ${codeText}: ${detail}`;
}

/** Runs Antigravity in stream-json mode and retains bounded board-facing progress/results. */

import {
  type ClaudeChildProcess,
  type ClaudeClearTimer,
  type ClaudeSetTimer,
  type ClaudeSpawn,
  type ClaudeTimerHandle,
  createLineSplitter,
  defaultClaudeSpawn,
  defaultClearTimer,
  defaultSetTimer,
  isSpawnNotFound,
  killClaudeTree,
  sendPrompt,
  spawnFailureText,
} from '../claudeCode/claudeProcess.js';
import {
  AGY_COMMAND,
  AGY_RUN_TIMEOUT_MS,
  type AgyDeniedAction,
  type AgyResultEvent,
  agyWorkerArgs,
  parseAgyStreamLine,
} from './agyCli.js';

const AGY_TIMEOUT_MESSAGE = 'Antigravity chạy quá lâu và đã bị dừng.';
const AGY_NO_RESULT_MESSAGE = 'Antigravity kết thúc nhưng không trả về kết quả.';
const AGY_ERROR_RESULT_MESSAGE = 'Antigravity gặp lỗi.';
/**
 * Headless agy soft-denies a tool that needs approval and still exits 0 with SUCCESS, an empty
 * response and no change on disk (seen 20/10/2026 writing outside the allowed `*.worktrees`).
 */
const AGY_EMPTY_RESPONSE_MESSAGE =
  'Antigravity không trả lời gì, thường do bị từ chối quyền ghi file hoặc chạy lệnh ở thư mục này. ' +
  'Quyền của agy nằm trong ~/.gemini/antigravity-cli/settings.json.';
const AGY_MISSING_MESSAGE = 'Không tìm thấy lệnh agy. Cài Antigravity CLI rồi chạy lại.';
const AGY_SETTINGS_PATH = '~/.gemini/antigravity-cli/settings.json';

/**
 * The empty-response failure, naming what agy refused when it says so (`denied_actions`):
 * the permission kind is what a `permissions.allow` rule in its settings names.
 */
export function agyDeniedMessage(denied: readonly AgyDeniedAction[]): string {
  if (denied.length === 0) return AGY_EMPTY_RESPONSE_MESSAGE;
  const kinds = [...new Set(denied.map((entry) => entry.action))];
  const names = [...new Set(denied.map((entry) => entry.displayName))].join(', ');
  // A blanket `command(*)` would let a worker run anything; the rule names the command it needs.
  return `Antigravity bị chặn quyền ${names} nên không làm được gì. Cho phép đúng lệnh cần chạy trong permissions.allow của ${AGY_SETTINGS_PATH}, dạng ${kinds.map((kind) => `"${kind}(<lệnh>)" hoặc "${kind}(regex:...)"`).join(', ')}.`;
}
const RESULT_MAX_CHARS = 4000;
const ERROR_MAX_CHARS = 300;
const LINE_MAX_CHARS = 4 * 1024 * 1024;
const STDOUT_MAX_BYTES = 4 * 1024 * 1024;

export type AgyRunState = 'running' | 'finished' | 'failed' | 'timeout' | 'killed';

export interface AgyRunStart {
  readonly cwd: string;
  readonly prompt: string;
  /** Continue this agy conversation instead of opening a new one. */
  readonly conversationId?: string;
}

export interface AgyRunView {
  readonly runId: string;
  readonly state: AgyRunState;
  readonly started: boolean;
  readonly pid?: number;
  readonly progress?: string;
  readonly result?: string;
  readonly error?: string;
  /** The conversation agy opened (or continued), once its init line arrives. */
  readonly conversationId?: string;
}

export interface AgyRuns {
  start(input: AgyRunStart): { readonly runId: string; readonly pid?: number };
  view(runId: string): AgyRunView | undefined;
  kill(runId: string): void;
  forget(runId: string): void;
  onChange(listener: () => void): () => void;
}

export interface AgyRunsOptions {
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
  state: AgyRunState;
  started: boolean;
  pid: number | undefined;
  progress: string | undefined;
  result: string | undefined;
  error: string | undefined;
  child: ClaudeChildProcess | undefined;
  timer: ClaudeTimerHandle | undefined;
  ended: AgyResultEvent | undefined;
  conversationId: string | undefined;
}

export function createAgyRuns(options: AgyRunsOptions): AgyRuns {
  const spawn = options.spawn ?? defaultClaudeSpawn();
  const killTree = options.killTree ?? killClaudeTree;
  const timeoutMs = options.timeoutMs ?? AGY_RUN_TIMEOUT_MS;
  const setTimer = options.setTimer ?? defaultSetTimer;
  const clearTimer = options.clearTimer ?? defaultClearTimer;
  const resultMaxChars = options.resultMaxChars ?? RESULT_MAX_CHARS;
  const runs = new Map<string, RunEntry>();
  const listeners = new Set<() => void>();

  function notify(): void {
    for (const listener of [...listeners]) listener();
  }

  function stopProcess(entry: RunEntry): void {
    if (entry.pid !== undefined) killTree(entry.pid);
    else entry.child?.kill();
  }

  function end(entry: RunEntry, state: AgyRunState, result?: string, error?: string): void {
    if (entry.state !== 'running') return;
    if (entry.timer !== undefined) clearTimer(entry.timer);
    entry.timer = undefined;
    entry.child = undefined;
    entry.state = state;
    entry.result = result;
    entry.error = error;
    notify();
  }

  function fail(entry: RunEntry, error: unknown): void {
    stopProcess(entry);
    const detail = isSpawnNotFound(error) ? AGY_MISSING_MESSAGE : spawnFailureText(error);
    end(entry, 'failed', undefined, clip(detail, ERROR_MAX_CHARS));
  }

  function onLine(entry: RunEntry, line: string): void {
    if (entry.state !== 'running') return;
    if (!entry.started && line.trim() !== '') {
      entry.started = true;
      notify();
    }
    const event = parseAgyStreamLine(line);
    if (event?.kind === 'progress' && event.text !== entry.progress) {
      entry.progress = event.text;
      notify();
    } else if (event?.kind === 'result') {
      entry.ended = event;
    } else if (event?.kind === 'init' && event.conversationId !== undefined) {
      entry.conversationId = event.conversationId;
    }
  }

  function onClose(entry: RunEntry, code: number | null): void {
    if (entry.state !== 'running') return;
    const ended = entry.ended;
    if (code === 0 && ended?.status === 'SUCCESS') {
      const response = ended.response.trim();
      if (response === '') end(entry, 'failed', undefined, agyDeniedMessage(ended.deniedActions ?? []));
      else end(entry, 'finished', clip(response, resultMaxChars));
      return;
    }
    const reason = ended?.error ?? (ended?.status && ended.status !== 'SUCCESS'
      ? `${AGY_ERROR_RESULT_MESSAGE} ${ended.status}`
      : AGY_NO_RESULT_MESSAGE);
    end(entry, 'failed', undefined, clip(reason, ERROR_MAX_CHARS));
  }

  function start(input: AgyRunStart): { readonly runId: string; readonly pid?: number } {
    const runId = options.newRunId();
    const entry: RunEntry = {
      runId,
      state: 'running',
      started: false,
      pid: undefined,
      progress: undefined,
      result: undefined,
      error: undefined,
      child: undefined,
      timer: undefined,
      ended: undefined,
      conversationId: input.conversationId,
    };
    runs.set(runId, entry);
    try {
      const child = spawn(AGY_COMMAND, agyWorkerArgs(timeoutMs, input.conversationId), { cwd: input.cwd });
      entry.child = child;
      entry.pid = child.pid;
      const lines = createLineSplitter(LINE_MAX_CHARS, (line) => onLine(entry, line));
      let stdoutBytes = 0;
      entry.timer = setTimer(() => {
        if (entry.state !== 'running') return;
        stopProcess(entry);
        end(entry, 'timeout', undefined, AGY_TIMEOUT_MESSAGE);
      }, timeoutMs);
      child.stdout?.on('data', (chunk: Buffer) => {
        if (entry.state !== 'running') return;
        stdoutBytes += chunk.length;
        if (stdoutBytes > STDOUT_MAX_BYTES) {
          stopProcess(entry);
          end(entry, 'failed', undefined, AGY_ERROR_RESULT_MESSAGE);
          return;
        }
        lines.push(chunk);
      });
      child.on('error', (error) => fail(entry, error));
      child.on('close', (code) => {
        lines.end();
        onClose(entry, code);
      });
      sendPrompt(child, input.prompt);
      notify();
    } catch (error) {
      fail(entry, error);
    }
    return entry.pid === undefined ? { runId } : { runId, pid: entry.pid };
  }

  return {
    start,
    view(runId) {
      const entry = runs.get(runId);
      if (entry === undefined) return undefined;
      return {
        runId: entry.runId,
        state: entry.state,
        started: entry.started,
        ...(entry.pid === undefined ? {} : { pid: entry.pid }),
        ...(entry.progress === undefined ? {} : { progress: entry.progress }),
        ...(entry.result === undefined ? {} : { result: entry.result }),
        ...(entry.error === undefined ? {} : { error: entry.error }),
        ...(entry.conversationId === undefined ? {} : { conversationId: entry.conversationId }),
      };
    },
    kill(runId) {
      const entry = runs.get(runId);
      if (entry?.state !== 'running') return;
      stopProcess(entry);
      end(entry, 'killed');
    },
    forget(runId) {
      const entry = runs.get(runId);
      if (entry?.state === 'running') {
        stopProcess(entry);
        end(entry, 'killed');
      }
      runs.delete(runId);
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function clip(text: string, max: number): string {
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

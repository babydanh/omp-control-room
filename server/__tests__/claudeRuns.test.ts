import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import { claudeRunArgs } from '../src/company/claudeCode/claudeCli.js';
import {
  type ClaudeRunsOptions,
  type ClaudeRunStart,
  createClaudeRuns,
} from '../src/company/claudeCode/claudeRuns.js';

const SESSION = '6f1c2b1e-0000-4000-8000-000000000001';
const START: ClaudeRunStart = {
  cwd: 'V:/repo/wt',
  prompt: 'Sửa lỗi',
  mode: 'edit',
  permission: 'auto',
  allowedTools: ['Bash(npm test*)'],
  sessionId: SESSION,
  resume: false,
  maxTurns: 40,
  maxBudgetUsd: 3,
};
const RUN_MISSING = 'Không tìm thấy lệnh claude. Cài Claude Code rồi chạy lại.';

class FakeStdin extends EventEmitter {
  readonly chunks: string[] = [];
  ended = false;

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }

  end(): void {
    this.ended = true;
  }
}

/** A child process stand-in. It carries no pid, so tests never reach a real process tree. */
class FakeChild extends EventEmitter {
  readonly stdin = new FakeStdin();
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly pid: number | undefined;
  readonly kill = vi.fn((): boolean => true);

  constructor(pid: number | undefined) {
    super();
    this.pid = pid;
  }
}

/** Timers the test fires by hand. Nothing waits on the real clock. */
class ManualTimers {
  private readonly pending = new Map<unknown, () => void>();

  readonly set = (callback: () => void): unknown => {
    const handle = {};
    this.pending.set(handle, callback);
    return handle;
  };

  readonly clear = (handle: unknown): void => {
    this.pending.delete(handle);
  };

  get pendingCount(): number {
    return this.pending.size;
  }

  /** Runs every timer still pending, as if its delay had passed. */
  fire(): void {
    for (const [handle, callback] of [...this.pending]) {
      this.pending.delete(handle);
      callback();
    }
  }
}

interface SpawnCall {
  readonly file: string;
  readonly args: readonly string[];
  readonly cwd: string;
}

function harness(extra: Partial<ClaudeRunsOptions> = {}) {
  const spawns: SpawnCall[] = [];
  const child = new FakeChild(4321);
  const killed: number[] = [];
  const timers = new ManualTimers();
  let nextId = 0;
  const runs = createClaudeRuns({
    spawn: (file, args, options) => {
      spawns.push({ file, args: [...args], cwd: options.cwd });
      return child;
    },
    killTree: (pid) => {
      killed.push(pid);
    },
    newRunId: () => {
      nextId += 1;
      return `run-${nextId}`;
    },
    timeoutMs: 60_000,
    setTimer: timers.set,
    clearTimer: timers.clear,
    ...extra,
  });
  return { runs, child, spawns, killed, timers };
}

function toolUse(name: string): string {
  return `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name }] } })}\n`;
}

function resultLine(result: string, isError = false): string {
  const value = {
    type: 'result',
    subtype: isError ? 'error_during_execution' : 'success',
    is_error: isError,
    result,
    session_id: SESSION,
  };
  return `${JSON.stringify(value)}\n`;
}

describe('createClaudeRuns start', () => {
  it('spawns claude with the run argv, the cwd, and the prompt on stdin', () => {
    const { runs, child, spawns } = harness();
    const started = runs.start(START);

    expect(spawns).toEqual([
      {
        file: 'claude',
        args: claudeRunArgs({
          mode: 'edit',
          permission: 'auto',
          allowedTools: ['Bash(npm test*)'],
          sessionId: SESSION,
          resume: false,
          maxTurns: 40,
          maxBudgetUsd: 3,
        }),
        cwd: 'V:/repo/wt',
      },
    ]);
    expect(child.stdin.chunks).toEqual(['Sửa lỗi']);
    expect(child.stdin.ended).toBe(true);
    expect(started).toEqual({ runId: 'run-1', pid: 4321 });
    expect(runs.view('run-1')).toMatchObject({
      state: 'running',
      sessionId: SESSION,
      pid: 4321,
      started: false,
    });
  });

  it('spawns a read run in plan mode with no allowlist', () => {
    const { runs, spawns } = harness();
    runs.start({ ...START, mode: 'read' });
    const args = claudeRunArgs({
      mode: 'read',
      permission: 'auto',
      allowedTools: ['Bash(npm test*)'],
      sessionId: SESSION,
      resume: false,
      maxTurns: 40,
      maxBudgetUsd: 3,
    });
    expect(spawns).toEqual([{ file: 'claude', args, cwd: 'V:/repo/wt' }]);
    expect(args).not.toContain('--allowedTools');
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('plan');
  });

  it('reports a spawn that throws at once as failed, with no pid', () => {
    const { runs } = harness({
      spawn: () => {
        throw Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' });
      },
    });
    const started = runs.start(START);
    expect(started.pid).toBeUndefined();
    expect(runs.view(started.runId)).toMatchObject({ state: 'failed', error: RUN_MISSING });
  });
});

describe('createClaudeRuns outcomes', () => {
  it('finishes with the result when the run exits 0 after a successful result', () => {
    const { runs, child } = harness();
    const { runId } = runs.start(START);
    child.stdout.emit('data', Buffer.from(resultLine('xong')));
    child.emit('close', 0);
    expect(runs.view(runId)).toMatchObject({ state: 'finished', result: 'xong', started: true });
  });

  it('reads a final line that has no newline when the process closes', () => {
    const { runs, child } = harness();
    const { runId } = runs.start(START);
    const bare = resultLine('ok').trimEnd();
    child.stdout.emit('data', Buffer.from(bare));
    child.emit('close', 0);
    expect(runs.view(runId)).toMatchObject({ state: 'finished', result: 'ok' });
  });

  it('joins a stream line split across two chunks', () => {
    const { runs, child } = harness();
    const { runId } = runs.start(START);
    const full = resultLine('ghép');
    child.stdout.emit('data', Buffer.from(full.slice(0, 20)));
    expect(runs.view(runId)?.state).toBe('running');
    child.stdout.emit('data', Buffer.from(full.slice(20)));
    child.emit('close', 0);
    expect(runs.view(runId)).toMatchObject({ state: 'finished', result: 'ghép' });
  });

  it('fails with the result text when the result says is_error', () => {
    const { runs, child } = harness();
    const { runId } = runs.start(START);
    child.stdout.emit('data', Buffer.from(resultLine('lỗi API', true)));
    child.emit('close', 0);
    expect(runs.view(runId)).toMatchObject({ state: 'failed', error: 'lỗi API' });
  });

  it('fails with the exit code and stderr when claude exits non-zero', () => {
    const { runs, child } = harness();
    const { runId } = runs.start(START);
    child.stdout.emit('data', Buffer.from(resultLine('xong')));
    child.stderr.emit('data', Buffer.from('boom'));
    child.emit('close', 1);
    expect(runs.view(runId)).toMatchObject({
      state: 'failed',
      error: 'Claude Code thoát với mã 1: boom',
    });
  });

  it('fails when the run exits 0 but never produced a result', () => {
    const { runs, child } = harness();
    const { runId } = runs.start(START);
    child.emit('close', 0);
    expect(runs.view(runId)).toMatchObject({
      state: 'failed',
      error: 'Claude Code kết thúc nhưng không trả về kết quả.',
    });
  });

  it('reports a missing claude command with the install message, and stays failed on close', () => {
    const { runs, child } = harness();
    const { runId } = runs.start(START);
    child.emit('error', Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }));
    child.emit('close', null);
    expect(runs.view(runId)).toMatchObject({ state: 'failed', error: RUN_MISSING });
  });

  it('times out and stops the process tree, then ignores a late close', () => {
    const { runs, child, killed, timers } = harness();
    const { runId } = runs.start(START);
    timers.fire();
    expect(runs.view(runId)).toMatchObject({
      state: 'timeout',
      error: 'Claude Code chạy quá lâu và đã bị dừng.',
    });
    expect(killed).toEqual([4321]);
    child.emit('close', 0);
    expect(runs.view(runId)?.state).toBe('timeout');
  });

  it('kills a running run, and a second kill changes nothing', () => {
    const { runs, child, killed } = harness();
    const { runId } = runs.start(START);
    runs.kill(runId);
    expect(runs.view(runId)?.state).toBe('killed');
    runs.kill(runId);
    child.emit('close', 0);
    expect(killed).toEqual([4321]);
    expect(runs.view(runId)?.state).toBe('killed');
  });

  it('clears the timer when the run ends', () => {
    const { runs, child, timers } = harness();
    runs.start(START);
    expect(timers.pendingCount).toBe(1);
    child.stdout.emit('data', Buffer.from(resultLine('xong')));
    child.emit('close', 0);
    expect(timers.pendingCount).toBe(0);
  });

  it('clips the final result to resultMaxChars', () => {
    const { runs, child } = harness({ resultMaxChars: 10 });
    const { runId } = runs.start(START);
    child.stdout.emit('data', Buffer.from(resultLine('a'.repeat(50))));
    child.emit('close', 0);
    expect(runs.view(runId)?.result).toBe('a'.repeat(10));
  });
});

describe('createClaudeRuns progress and listeners', () => {
  it('updates progress from assistant text and tool use', () => {
    const { runs, child } = harness();
    const { runId } = runs.start(START);
    const text = {
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Đang đọc tệp' }] },
    };
    child.stdout.emit('data', Buffer.from(`${JSON.stringify(text)}\n`));
    expect(runs.view(runId)?.progress).toBe('Đang đọc tệp');
    child.stdout.emit('data', Buffer.from(toolUse('Edit')));
    expect(runs.view(runId)?.progress).toBe('Dùng công cụ: Edit');
  });

  it('marks the run started on the first non-blank line only', () => {
    const { runs, child } = harness();
    const { runId } = runs.start(START);
    child.stdout.emit('data', Buffer.from('\n'));
    expect(runs.view(runId)?.started).toBe(false);
    child.stdout.emit('data', Buffer.from(toolUse('Read')));
    expect(runs.view(runId)?.started).toBe(true);
  });

  it('notifies listeners on each change, and not when the same progress repeats', () => {
    const { runs, child } = harness();
    const { runId } = runs.start(START);
    const listener = vi.fn();
    runs.onChange(listener);

    child.stdout.emit('data', Buffer.from(toolUse('Edit')));
    const afterFirst = listener.mock.calls.length;
    expect(afterFirst).toBeGreaterThan(0);

    child.stdout.emit('data', Buffer.from(toolUse('Edit')));
    expect(listener.mock.calls.length).toBe(afterFirst);

    runs.kill(runId);
    expect(listener.mock.calls.length).toBeGreaterThan(afterFirst);
  });

  it('stops notifying a listener after it unsubscribes', () => {
    const { runs, child } = harness();
    const { runId } = runs.start(START);
    const listener = vi.fn();
    const unsubscribe = runs.onChange(listener);
    unsubscribe();
    runs.kill(runId);
    child.stdout.emit('data', Buffer.from(toolUse('Edit')));
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('createClaudeRuns forget', () => {
  it('removes a finished run from the record', () => {
    const { runs, child } = harness();
    const { runId } = runs.start(START);
    child.stdout.emit('data', Buffer.from(resultLine('xong')));
    child.emit('close', 0);
    runs.forget(runId);
    expect(runs.view(runId)).toBeUndefined();
  });

  it('kills a running run before removing it, so no process outlives its record', () => {
    const { runs, killed } = harness();
    const { runId } = runs.start(START);
    runs.forget(runId);
    expect(killed).toEqual([4321]);
    expect(runs.view(runId)).toBeUndefined();
  });
});

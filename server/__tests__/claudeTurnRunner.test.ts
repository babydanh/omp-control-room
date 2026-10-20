import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import { claudeTurnArgs } from '../src/company/claudeCode/claudeCli.js';
import {
  type ClaudeTurnRunnerOptions,
  createClaudeTurnRunner,
  createEngineRunner,
} from '../src/company/claudeCode/claudeTurnRunner.js';
import type { LeaderRunner } from '../src/company/squad/squadRunner.js';
import { SquadLeaderError } from '../src/company/squad/squadRunner.js';

const SCHEMA = { type: 'object', properties: {} };
const SCHEMA_JSON = JSON.stringify(SCHEMA);
const TIMEOUT_MESSAGE = 'Claude Code quá 4 phút chưa trả lời. Thử lại.';
const MISSING_MESSAGE = 'Không tìm thấy Claude Code (lệnh claude). Cài Claude Code rồi thử lại.';

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

/**
 * A child process stand-in. It carries no pid on purpose: the turn runner then stops it through
 * `kill`, never through a real process tree.
 */
class FakeChild extends EventEmitter {
  readonly stdin = new FakeStdin();
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly pid: number | undefined = undefined;
  readonly kill = vi.fn((): boolean => true);
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

function harness(extra: Partial<ClaudeTurnRunnerOptions> = {}) {
  const spawns: SpawnCall[] = [];
  const child = new FakeChild();
  const timers = new ManualTimers();
  const runner = createClaudeTurnRunner({
    cwd: 'V:/repo',
    label: 'Giám khảo',
    model: () => 'sonnet',
    schema: SCHEMA,
    timeoutMs: 240_000,
    spawn: (file, args, options) => {
      spawns.push({ file, args: [...args], cwd: options.cwd });
      return child;
    },
    setTimer: timers.set,
    clearTimer: timers.clear,
    ...extra,
  });
  return { runner, child, spawns, timers };
}

/** The error a rejected turn carries; fails the test when the turn succeeded. */
async function failureOf(promise: Promise<string>): Promise<SquadLeaderError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof SquadLeaderError) return error;
    throw error;
  }
  throw new Error('expected the turn to fail');
}

function resultLine(value: Record<string, unknown>): string {
  return `${JSON.stringify({ type: 'result', ...value })}\n`;
}

describe('createClaudeTurnRunner', () => {
  it('runs one print-mode turn with the model, the schema, the cwd, and the prompt on stdin', async () => {
    const { runner, child, spawns } = harness();
    const promise = runner.run('Lập kế hoạch', new AbortController().signal);
    child.stdout.emit('data', Buffer.from(resultLine({ is_error: false, result: 'Kế hoạch' })));
    child.emit('close', 0);
    expect(await promise).toBe('Kế hoạch');

    expect(spawns).toEqual([
      {
        file: 'claude',
        args: claudeTurnArgs({ model: 'sonnet', schemaJson: SCHEMA_JSON }),
        cwd: 'V:/repo',
      },
    ]);
    expect(child.stdin.chunks).toEqual(['Lập kế hoạch']);
    expect(child.stdin.ended).toBe(true);
  });

  it('returns the structured output as JSON when the schema was answered', async () => {
    const { runner, child } = harness();
    const promise = runner.run('Đánh giá', new AbortController().signal);
    child.stdout.emit(
      'data',
      Buffer.from(resultLine({ is_error: false, result: '', structured_output: { ok: true } })),
    );
    child.emit('close', 0);
    expect(await promise).toBe('{"ok":true}');
  });

  it('throws a labelled Vietnamese error when claude reports is_error', async () => {
    const { runner, child } = harness();
    const promise = runner.run('Đánh giá', new AbortController().signal);
    child.stdout.emit('data', Buffer.from(resultLine({ is_error: true, result: 'API lỗi' })));
    child.emit('close', 0);
    const error = await failureOf(promise);
    expect(error).toBeInstanceOf(SquadLeaderError);
    expect(error.message).toBe('Giám khảo gặp lỗi: API lỗi. Thử lại.');
  });

  it('throws with the exit code and stderr when the process exits non-zero', async () => {
    const { runner, child } = harness();
    const promise = runner.run('Đánh giá', new AbortController().signal);
    child.stderr.emit('data', Buffer.from('bad flag'));
    child.emit('close', 2);
    expect((await failureOf(promise)).message).toBe(
      'Giám khảo gặp lỗi (mã thoát 2): bad flag. Thử lại.',
    );
  });

  it('throws when the output carries no result at all', async () => {
    const { runner, child } = harness();
    const promise = runner.run('Đánh giá', new AbortController().signal);
    child.emit('close', 0);
    expect((await failureOf(promise)).message).toBe(
      'Giám khảo gặp lỗi: Claude Code không trả về kết quả. Thử lại.',
    );
  });

  it('throws the install message when the claude command is missing', async () => {
    const { runner, child } = harness();
    const promise = runner.run('Đánh giá', new AbortController().signal);
    child.emit('error', Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }));
    child.emit('close', null);
    expect((await failureOf(promise)).message).toBe(MISSING_MESSAGE);
  });

  it('throws the timeout message and stops the process when the turn runs too long', async () => {
    const { runner, child, timers } = harness();
    const promise = runner.run('Đánh giá', new AbortController().signal);
    timers.fire();
    expect((await failureOf(promise)).message).toBe(TIMEOUT_MESSAGE);
    expect(child.kill).toHaveBeenCalled();
  });

  it('throws the stopped message when the turn is aborted', async () => {
    const { runner, child } = harness();
    const controller = new AbortController();
    const promise = runner.run('Đánh giá', controller.signal);
    controller.abort();
    expect((await failureOf(promise)).message).toBe('Giám khảo đã dừng.');
    expect(child.kill).toHaveBeenCalled();
  });

  it('names other spawn failures with their message', async () => {
    const { runner, child } = harness();
    const promise = runner.run('Đánh giá', new AbortController().signal);
    child.emit('error', Object.assign(new Error('spawn EACCES'), { code: 'EACCES' }));
    expect((await failureOf(promise)).message).toBe('Giám khảo không chạy được: spawn EACCES');
  });

  it('names the leader in its errors when it is the leader label', async () => {
    const { runner, child } = harness({ label: 'Đội trưởng' });
    const promise = runner.run('Lập kế hoạch', new AbortController().signal);
    child.emit('close', 0);
    expect((await failureOf(promise)).message).toBe(
      'Đội trưởng gặp lỗi: Claude Code không trả về kết quả. Thử lại.',
    );
  });
});

describe('createEngineRunner', () => {
  it('sends each turn to the engine named when the turn starts', async () => {
    let engine: 'omp' | 'claude' | 'agy' = 'omp';
    const calls: Record<'omp' | 'claude' | 'agy', string[]> = {
      omp: [],
      claude: [],
      agy: [],
    };
    const runnerFor = (name: 'omp' | 'claude' | 'agy'): LeaderRunner => ({
      run: (prompt) => {
        calls[name].push(prompt);
        return Promise.resolve(`${name}: ${prompt}`);
      },
    });
    const runner = createEngineRunner({
      engine: () => engine,
      omp: runnerFor('omp'),
      claude: runnerFor('claude'),
      agy: runnerFor('agy'),
    });
    const signal = new AbortController().signal;

    expect(await runner.run('một', signal)).toBe('omp: một');
    engine = 'claude';
    expect(await runner.run('hai', signal)).toBe('claude: hai');
    engine = 'agy';
    expect(await runner.run('ba', signal)).toBe('agy: ba');
    engine = 'omp';
    expect(await runner.run('bốn', signal)).toBe('omp: bốn');
    expect(calls).toEqual({ omp: ['một', 'bốn'], claude: ['hai'], agy: ['ba'] });
  });
});

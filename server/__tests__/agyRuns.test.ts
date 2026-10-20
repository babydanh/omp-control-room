import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import { type AgyRunsOptions,createAgyRuns } from '../src/company/agyCode/agyRuns.js';

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

class FakeChild extends EventEmitter {
  readonly stdin = new FakeStdin();
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly pid = 4321;
  readonly kill = vi.fn((): boolean => true);
}

function harness(extra: Partial<AgyRunsOptions> = {}) {
  const child = new FakeChild();
  const spawns: { file: string; args: readonly string[]; cwd: string }[] = [];
  const killed: number[] = [];
  const timers = new Map<unknown, () => void>();
  const runs = createAgyRuns({
    spawn: (file, args, options) => {
      spawns.push({ file, args: [...args], cwd: options.cwd });
      return child;
    },
    killTree: (pid) => killed.push(pid),
    newRunId: () => 'run-1',
    setTimer: (callback) => {
      const handle = {};
      timers.set(handle, callback);
      return handle;
    },
    clearTimer: (handle) => timers.delete(handle),
    ...extra,
  });
  return { runs, child, spawns, killed, timers };
}

describe('createAgyRuns', () => {
  it('spawns agy in the worktree and writes the prompt to stdin', () => {
    const { runs, child, spawns } = harness();
    const started = runs.start({ cwd: 'V:/repo/worktree', prompt: 'Sửa lỗi' });

    expect(spawns[0]).toMatchObject({ file: 'agy', cwd: 'V:/repo/worktree' });
    expect(spawns[0]?.args).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--input-format',
      'text',
      '--print-timeout',
      '30m',
    ]);
    expect(child.stdin.chunks).toEqual(['Sửa lỗi']);
    expect(child.stdin.ended).toBe(true);
    expect(started).toEqual({ runId: 'run-1', pid: 4321 });
    expect(runs.view('run-1')).toMatchObject({ state: 'running', pid: 4321 });
  });

  it('fails when the CLI result reports an error', () => {
    const { runs, child } = harness();
    runs.start({ cwd: 'V:/repo', prompt: 'Làm' });
    child.stdout.emit(
      'data',
      Buffer.from(
        `${JSON.stringify({ event: 'result', result: { status: 'ERROR', response: '', error: 'Không thể tiếp tục' } })}\n`,
      ),
    );
    child.stdout.emit('end');
    child.emit('close', 1);

    expect(runs.view('run-1')).toMatchObject({
      state: 'failed',
      error: 'Không thể tiếp tục',
    });
  });

  it('tracks stream progress and settles a successful result', () => {
    const { runs, child, timers } = harness();
    runs.start({ cwd: 'V:/repo', prompt: 'Làm' });
    child.stdout.emit(
      'data',
      Buffer.from(
        `${JSON.stringify({ event: 'step_update', step_update: { step_type: 'agent_response', text_delta: 'Đang làm' } })}\n${JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'Đã xong' } })}\n`,
      ),
    );
    child.stdout.emit('end');
    child.emit('close', 0);

    expect(runs.view('run-1')).toMatchObject({ state: 'finished', result: 'Đã xong' });
    expect([...timers]).toHaveLength(0);
  });

  it('kills the process tree when the run is cancelled', () => {
    const { runs, killed } = harness();
    runs.start({ cwd: 'V:/repo', prompt: 'Dừng' });

    runs.kill('run-1');

    expect(killed).toEqual([4321]);
    expect(runs.view('run-1')?.state).toBe('killed');
  });

  it('marks a run timed out and stops its process tree', () => {
    const { runs, timers, killed } = harness();
    runs.start({ cwd: 'V:/repo', prompt: 'Chờ' });
    for (const callback of timers.values()) callback();

    expect(killed).toEqual([4321]);
    expect(runs.view('run-1')).toMatchObject({ state: 'timeout' });
  });
});

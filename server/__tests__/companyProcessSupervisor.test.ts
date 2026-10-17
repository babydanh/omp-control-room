import { type ChildProcess, spawn } from 'node:child_process';

import { describe, expect, it } from 'vitest';

import {
  type ProcessProbeResult,
  ProcessSupervisor,
  type RegisterRunInput,
  type SupervisedRunPorts,
  type SupervisedRunRecord,
} from '../src/company/processSupervisor.js';

/**
 * A real process is the only honest witness for "we killed what we own" and
 * "we left a stranger alone", so the kill and refusal tests drive real
 * children. Everything about ORDER, deadlines and refusal policy runs against
 * injected OS facts, so a scheduling flake cannot masquerade as a policy bug.
 *
 * The only real waits are process events (a child's exit) and the two
 * supervisor deadlines under test -- the pause deadline and the shutdown grace
 * -- which the module must bound by wall clock by definition. Every other
 * ordering is asserted from recorded call order, never from a sleep.
 */
const PROCESS_TEST_TIMEOUT_MS = 30_000;

function spawnChild(): ChildProcess {
  return spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
    windowsHide: true,
  });
}

/** Must be called BEFORE anything can kill the child. */
function childExit(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    child.once('exit', () => resolve());
  });
}

function running(
  pid: number,
  imageName: string,
  startTime: number | null,
  processGroupId: number | null = null,
): ProcessProbeResult {
  return { kind: 'running', identity: { pid, imageName, startTime, processGroupId } };
}

interface Harness {
  readonly supervisor: ProcessSupervisor;
  /** Port calls, in the order they happened. Never includes a kill. */
  readonly calls: string[];
  /**
   * PIDs the supervisor actually signalled, normalised across both kill paths
   * (POSIX signals, Windows `taskkill /T /F`), so the assertions do not encode
   * a platform's process model.
   */
  readonly terminations: number[];
  /** Change what the OS reports about a PID, as a PID reuse would. */
  facts(overrides: Record<number, ProcessProbeResult>): void;
  /**
   * `registerRun` with the recording ports attached. Every run under test must
   * go through this: a run registered without ports gets the no-op defaults,
   * and the ordering guarantees would then be asserted against nothing.
   */
  register(
    input: Omit<RegisterRunInput, 'ports'> & { ports?: Partial<SupervisedRunPorts> },
  ): SupervisedRunRecord;
}

/**
 * `probe` maps a PID to the OS fact about it; every other PID reads as absent,
 * which is also what a stale persisted PID looks like after a crash.
 */
function harness(
  options: {
    probe?: Record<number, ProcessProbeResult>;
    ports?: Partial<SupervisedRunPorts>;
    role?: 'owner' | 'follower';
    shutdownGraceMs?: number;
    terminateGraceMs?: number;
  } = {},
): Harness {
  const calls: string[] = [];
  const terminations: number[] = [];
  const table = new Map<number, ProcessProbeResult>();
  for (const [pid, fact] of Object.entries(options.probe ?? {})) table.set(Number(pid), fact);
  const ports: SupervisedRunPorts = {
    persist: async () => {
      calls.push('persist');
    },
    shutdownBridge: async () => {
      calls.push('shutdownBridge');
    },
    abort: async () => {
      calls.push('abort');
    },
    closePty: async () => {
      calls.push('closePty');
    },
    isQuiescent: async () => {
      calls.push('isQuiescent');
      return true;
    },
    ...options.ports,
  };
  const supervisor = new ProcessSupervisor({
    probe: async (pid) => table.get(pid) ?? { kind: 'absent' },
    role: options.role,
    ...(options.shutdownGraceMs === undefined ? {} : { shutdownGraceMs: options.shutdownGraceMs }),
    ...(options.terminateGraceMs === undefined
      ? {}
      : { terminateGraceMs: options.terminateGraceMs }),
    signal: (target) => {
      terminations.push(Math.abs(target));
    },
    exec: async (file, args) => {
      if (file === 'taskkill') terminations.push(Number(args[1]));
      return { ok: true, stdout: '', stderr: '' };
    },
  });
  return {
    supervisor,
    calls,
    terminations,
    facts: (overrides) => {
      for (const [pid, result] of Object.entries(overrides)) table.set(Number(pid), result);
    },
    register: (input) => supervisor.registerRun({ ...input, ports: { ...ports, ...input.ports } }),
  };
}

/** A baseline that must hold after every terminal path. */
function expectCleanBaseline(supervisor: ProcessSupervisor): void {
  expect(supervisor.resources).toEqual({
    trackedProcesses: 0,
    runs: 0,
    exitWaiters: 0,
    pendingCaptures: 0,
  });
}

describe('owned process kill', () => {
  it(
    'kills a lineage-verified tree, advances the epoch, and never respawns it',
    async () => {
      const child = spawnChild();
      const exited = childExit(child);
      const supervisor = new ProcessSupervisor({ terminateGraceMs: 3_000 });
      try {
        const pid = child.pid as number;
        const ref = await supervisor.captureProcess({ pid, imageName: process.execPath });
        // The OS start time is what makes the kill provable; without it the
        // supervisor refuses, which is the very next test.
        expect(ref.startTime).not.toBeNull();
        expect(await supervisor.verify(ref)).toBe('owned');

        supervisor.registerRun({
          runId: 'run-owned',
          sessionId: 'session-1',
          runEpoch: 7,
          pid,
          imageName: process.execPath,
          startTime: ref.startTime,
        });
        const record = await supervisor.kill('run-owned', 7);

        expect(record.state).toBe('stopped');
        expect(record.runEpoch).toBe(8);
        expect(record.interrupted).toBe(true);
        expect(record.interruptionReason).toBe('killed');
        await exited;
        expect(supervisor.trackedCount).toBe(0);

        // A killed run stays killed: the supervisor owns no spawn path, so a
        // late command against the old epoch is refused, not retried.
        await expect(supervisor.kill('run-owned', 7)).rejects.toThrow(/epoch/i);
        expect(supervisor.getRun('run-owned')?.pid).toBeNull();

        await supervisor.dispose();
        expectCleanBaseline(supervisor);
      } finally {
        child.kill();
      }
    },
    PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    'refuses a recycled PID and leaves the process now holding it alive',
    async () => {
      const child = spawnChild();
      const pid = child.pid as number;
      // Same image, different process: the classic recycled-PID case.
      const { supervisor, calls, terminations, register } = harness({
        probe: { [pid]: running(pid, 'omp.exe', 9_999) },
      });
      try {
        const ref = supervisor.track(pid, 'omp.exe', 1_000);
        expect(await supervisor.verify(ref)).toBe('conflict');
        expect(await supervisor.terminateTree(ref)).toBe('conflict');

        expect(calls).toEqual([]);
        expect(terminations).toEqual([]);
        expect(child.exitCode).toBeNull();
        // Refused, not forgotten: the entry stays so an operator can see it.
        expect(supervisor.trackedPids).toContain(pid);
        register({
          runId: 'run-recycled',
          sessionId: 'session-2',
          runEpoch: 1,
          pid,
          imageName: 'omp.exe',
          startTime: 1_000,
        });
        // A run registered over a PID we cannot prove is refused at kill time
        // too, and its PTY is never closed.
        await expect(supervisor.kill('run-recycled', 1)).rejects.toThrow(/ownership/i);
        expect(supervisor.getRun('run-recycled')?.state).toBe('blocked');

        await supervisor.disposeAll();
        child.kill();
      } finally {
        child.kill();
      }
    },
    PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    'blocks rather than kills when the identity cannot be read at all',
    async () => {
      const child = spawnChild();
      const pid = child.pid as number;
      const { supervisor, calls, terminations, register } = harness({
        probe: { [pid]: { kind: 'unknown', reason: 'probe denied' } },
      });
      try {
        register({
          runId: 'run-unproven',
          sessionId: 'session-3',
          runEpoch: 3,
          pid,
          imageName: process.execPath,
          startTime: 1_000,
        });

        await expect(supervisor.kill('run-unproven', 3)).rejects.toThrow(/ownership/i);
        const record = supervisor.getRun('run-unproven');
        expect(record?.state).toBe('blocked');
        expect(record?.blockedReason?.code).toBe('ownership_unproven');
        // The epoch did not move, so queued work from the old generation can
        // never be mistaken for the new one.
        expect(record?.runEpoch).toBe(3);

        expect(calls).toEqual([]);
        expect(terminations).toEqual([]);
        expect(child.exitCode).toBeNull();

        child.kill();
        await supervisor.dispose();
        expectCleanBaseline(supervisor);
      } finally {
        child.kill();
      }
    },
    PROCESS_TEST_TIMEOUT_MS,
  );

  it('treats a process that already exited as nothing to do', async () => {
    const { supervisor, calls, terminations } = harness({ probe: { 700: { kind: 'absent' } } });
    const ref = await supervisor.captureProcess({ pid: 700, imageName: 'omp.exe' });
    expect(ref.startTime).toBeNull();

    expect(await supervisor.verify(ref)).toBe('gone');
    expect(await supervisor.terminateTree(ref)).toBe('gone');
    expect(calls).toEqual([]);
    expect(terminations).toEqual([]);
    expect(supervisor.trackedCount).toBe(0);
    expectCleanBaseline(supervisor);
  });
});

describe('child exit reaping', () => {
  it(
    'reports an unexpected exit as an interruption and frees the handle',
    async () => {
      const child = spawnChild();
      const pid = child.pid as number;
      const { supervisor, facts, register } = harness({
        probe: { [pid]: running(pid, 'omp.exe', 1_000) },
      });
      register({
        runId: 'run-exit',
        sessionId: 'session-4',
        runEpoch: 1,
        pid,
        imageName: 'omp.exe',
        startTime: 1_000,
      });

      const exited = childExit(child);
      child.kill();
      await exited;
      // The OS fact flips because the process really ended; nothing announced
      // it, so awaitExit has to learn it from the OS or a dead process would
      // look like it was still running until the deadline.
      facts({ [pid]: { kind: 'absent' } });

      expect(await supervisor.awaitExit('run-exit', 5_000)).toBe(true);
      const record = supervisor.notifyExit('run-exit', { signal: 9 });
      expect(record?.state).toBe('stopped');
      expect(record?.interrupted).toBe(true);
      expect(record?.interruptionReason).toBe('signal 9');
      expect(record?.pid).toBeNull();
      expect(supervisor.trackedCount).toBe(0);
      expectCleanBaseline(supervisor);
    },
    PROCESS_TEST_TIMEOUT_MS,
  );

  it('does not call a planned stop an interruption', () => {
    const { supervisor, register } = harness({ probe: { 800: running(800, 'omp.exe', 1_000) } });
    register({
      runId: 'run-expected',
      sessionId: 'session-5',
      runEpoch: 2,
      pid: 800,
      imageName: 'omp.exe',
      startTime: 1_000,
    });

    const record = supervisor.notifyExit('run-expected', { exitCode: 0, expected: true });
    expect(record?.interrupted).toBe(false);
    expect(supervisor.notifyExit('run-missing')).toBeUndefined();
  });

  it('resolves awaitExit false on a deadline and leaves no waiter behind', async () => {
    const { supervisor, register } = harness({ probe: { 900: running(900, 'omp.exe', 1_000) } });
    register({
      runId: 'run-timeout',
      sessionId: 'session-6',
      runEpoch: 1,
      pid: 900,
      imageName: 'omp.exe',
      startTime: 1_000,
    });

    expect(await supervisor.awaitExit('run-timeout', 40)).toBe(false);
    expect(supervisor.resources.exitWaiters).toBe(0);
  });
});

describe('tracking lifecycle', () => {
  it(
    'releases a process without signalling it, on the spawn-failure path',
    async () => {
      const child = spawnChild();
      const pid = child.pid as number;
      const { supervisor, calls, terminations, register } = harness({
        probe: { [pid]: running(pid, 'node.exe', 1_000) },
      });
      try {
        register({
          runId: 'run-release',
          sessionId: 'session-7',
          runEpoch: 1,
          pid,
          imageName: 'node.exe',
          startTime: 1_000,
        });
        expect(supervisor.trackedPids).toContain(pid);

        expect(supervisor.release(pid)).toBe(true);
        expect(supervisor.release(pid)).toBe(false);
        expect(calls).toEqual([]);
        expect(terminations).toEqual([]);
        // Release is not a kill: the process is still running.
        expect(child.exitCode).toBeNull();

        await supervisor.dispose();
        expectCleanBaseline(supervisor);
      } finally {
        child.kill();
      }
    },
    PROCESS_TEST_TIMEOUT_MS,
  );

  it('returns the owned-process baseline to zero after disposal', async () => {
    const { supervisor, register } = harness({
      terminateGraceMs: 40,
      probe: {
        1100: running(1100, 'omp.exe', 1_000),
        1101: running(1101, 'omp.exe', 2_000),
        1102: running(1102, 'omp.exe', 3_000),
      },
    });
    for (const [index, pid] of [1100, 1101, 1102].entries()) {
      register({
        runId: `run-baseline-${index}`,
        sessionId: 'session-8',
        runEpoch: 1,
        pid,
        imageName: 'omp.exe',
        startTime: 1_000 + index * 1_000,
      });
    }
    expect(supervisor.trackedCount).toBe(3);
    expect(supervisor.runCount).toBe(3);

    await supervisor.dispose();
    expectCleanBaseline(supervisor);
  });

  it('is idempotent: a second dispose returns the same report', async () => {
    const { supervisor, register } = harness({ probe: { 1200: { kind: 'absent' } } });
    register({
      runId: 'run-idempotent',
      sessionId: 'session-9',
      runEpoch: 1,
      pid: 1200,
      imageName: 'omp.exe',
      startTime: 1_000,
    });

    const first = await supervisor.dispose();
    const second = await supervisor.dispose();
    expect(second).toBe(first);
    expect(first.terminated).toEqual(['run-idempotent']);
    expectCleanBaseline(supervisor);
  });

  it('refuses a stale epoch without touching the process', async () => {
    const { supervisor, calls, terminations, register } = harness({
      probe: { 1300: running(1300, 'omp.exe', 1_000) },
    });
    register({
      runId: 'run-stale',
      sessionId: 'session-10',
      runEpoch: 5,
      pid: 1300,
      imageName: 'omp.exe',
      startTime: 1_000,
    });

    await expect(supervisor.kill('run-stale', 4)).rejects.toThrow(/epoch/i);
    await expect(supervisor.pause('run-stale', 4)).rejects.toThrow(/epoch/i);
    await expect(supervisor.restart('run-unknown', 5)).rejects.toThrow(/unknown company run/i);
    expect(calls).toEqual([]);
    expect(terminations).toEqual([]);
    expect(supervisor.getRun('run-stale')?.state).toBe('starting');
  });
});

describe('ownership preflight before a durable mutation', () => {
  it(
    'proves the ORIGINAL lineage, so a recycled PID is caught before any side effect',
    async () => {
      const child = spawnChild();
      const pid = child.pid as number;
      const { supervisor, calls, terminations, facts, register } = harness({
        probe: { [pid]: running(pid, 'omp.exe', 1_000) },
      });
      try {
        register({
          runId: 'run-preflight',
          sessionId: 'session-11',
          runEpoch: 4,
          pid,
          imageName: 'omp.exe',
          startTime: 1_000,
        });
        expect(await supervisor.verifyRunOwnership('run-preflight', 4)).toBe('owned');

        // The PID is recycled: the SAME image, a different process. A preflight
        // that re-read the PID now would answer 'owned' and certify the
        // stranger -- that is precisely the bug this boundary exists to catch.
        facts({ [pid]: running(pid, 'omp.exe', 9_999) });
        expect(await supervisor.verifyRunOwnership('run-preflight', 4)).toBe('conflict');

        // A preflight is a pure read: nothing was closed, signalled or moved.
        expect(calls).toEqual([]);
        expect(terminations).toEqual([]);
        expect(child.exitCode).toBeNull();
        expect(supervisor.getRun('run-preflight')?.state).toBe('starting');
        expect(supervisor.getRun('run-preflight')?.runEpoch).toBe(4);
      } finally {
        child.kill();
      }
    },
    PROCESS_TEST_TIMEOUT_MS,
  );

  it('refuses when the OS will not answer, and when the run has no process', async () => {
    const { supervisor, calls, terminations, facts, register } = harness({
      probe: {
        2400: running(2400, 'omp.exe', 1_000),
        2401: { kind: 'absent' },
      },
    });
    register({
      runId: 'run-preflight-unproven',
      sessionId: 'session-12',
      runEpoch: 1,
      pid: 2400,
      imageName: 'omp.exe',
      startTime: 1_000,
    });
    register({
      runId: 'run-preflight-gone',
      sessionId: 'session-12',
      runEpoch: 1,
      pid: 2401,
      imageName: 'omp.exe',
      startTime: 1_000,
    });

    facts({ 2400: { kind: 'unknown', reason: 'access denied' } });
    expect(await supervisor.verifyRunOwnership('run-preflight-unproven', 1)).toBe('unproven');

    // An unreadable identity also blocks the kill itself, without closing the
    // PTY: a process we cannot vouch for is not even hung up.
    await expect(supervisor.kill('run-preflight-unproven', 1)).rejects.toThrow(/ownership/i);
    expect(supervisor.getRun('run-preflight-unproven')?.runEpoch).toBe(1);
    expect(calls).toEqual([]);
    expect(terminations).toEqual([]);

    // A run with no live process is unproven too, never a permissive "nothing
    // to check, so allow"; and the killed epoch no longer verifies.
    await supervisor.kill('run-preflight-gone', 1);
    expect(supervisor.getRun('run-preflight-gone')?.pid).toBeNull();
    expect(await supervisor.verifyRunOwnership('run-preflight-gone', 2)).toBe('unproven');
    await expect(supervisor.verifyRunOwnership('run-preflight-gone', 1)).rejects.toThrow(/epoch/i);
    expect(calls).toEqual(['closePty']);
    expect(terminations).toEqual([]);
  });

  it('rejects an unknown run and a stale epoch instead of guessing', async () => {
    const { supervisor, register } = harness({ probe: { 2500: running(2500, 'omp.exe', 1_000) } });
    register({
      runId: 'run-preflight-stale',
      sessionId: 'session-13',
      runEpoch: 6,
      pid: 2500,
      imageName: 'omp.exe',
      startTime: 1_000,
    });

    await expect(supervisor.verifyRunOwnership('run-nowhere', 6)).rejects.toThrow(
      /unknown company run/i,
    );
    await expect(supervisor.verifyRunOwnership('run-preflight-stale', 5)).rejects.toThrow(/epoch/i);
  });
});

describe('pause, restart and shutdown ordering', () => {
  it('restarts as quiesce, persist, close PTY, kill, then epoch', async () => {
    const { supervisor, calls, terminations, register } = harness({
      probe: { 1400: running(1400, 'omp.exe', 1_000) },
    });
    register({
      runId: 'run-restart',
      sessionId: 'session-14',
      runEpoch: 3,
      pid: 1400,
      imageName: 'omp.exe',
      startTime: 1_000,
    });

    const record = await supervisor.restart('run-restart', 3);

    expect(calls).toEqual(['abort', 'isQuiescent', 'persist', 'closePty']);
    expect(terminations).toEqual([1400]);
    expect(record.runEpoch).toBe(4);
    expect(record.state).toBe('stopped');
    expect(record.interrupted).toBe(true);
    expect(supervisor.trackedCount).toBe(0);
  });

  it('abandons a restart whose persist failed, without killing or bumping', async () => {
    const { supervisor, calls, terminations, register } = harness({
      probe: { 1500: running(1500, 'omp.exe', 1_000) },
      ports: {
        persist: async () => {
          throw new Error('disk full');
        },
      },
    });
    register({
      runId: 'run-persist-fail',
      sessionId: 'session-15',
      runEpoch: 3,
      pid: 1500,
      imageName: 'omp.exe',
      startTime: 1_000,
    });

    const record = await supervisor.restart('run-persist-fail', 3);

    expect(record.state).toBe('blocked');
    expect(record.blockedReason?.code).toBe('restart_failed');
    expect(record.runEpoch).toBe(3);
    expect(terminations).toEqual([]);
    expect(calls).not.toContain('closePty');
  });

  it('pauses without killing, and blocks a session that will not go quiet', async () => {
    const { supervisor, calls, terminations, register } = harness({
      probe: { 1600: running(1600, 'omp.exe', 1_000) },
      ports: { isQuiescent: async () => false },
    });
    register({
      runId: 'run-pause',
      sessionId: 'session-16',
      runEpoch: 1,
      pid: 1600,
      imageName: 'omp.exe',
      startTime: 1_000,
    });

    const record = await supervisor.pause('run-pause', 1, { quiesceTimeoutMs: 40 });

    expect(record.state).toBe('blocked');
    expect(record.blockedReason?.code).toBe('quiesce_timeout');
    expect(calls).toEqual(['abort']);
    expect(terminations).toEqual([]);
    expect(supervisor.trackedCount).toBe(1);
  });

  it('pauses to a quiesced state and resumes on a new epoch', async () => {
    const { supervisor, register } = harness({ probe: { 1700: running(1700, 'omp.exe', 1_000) } });
    register({
      runId: 'run-pause-ok',
      sessionId: 'session-17',
      runEpoch: 2,
      pid: 1700,
      imageName: 'omp.exe',
      startTime: 1_000,
    });

    const paused = await supervisor.pause('run-pause-ok', 2, { quiesceTimeoutMs: 1_000 });
    expect(paused.state).toBe('paused');

    const resumed = await supervisor.resume('run-pause-ok', 2);
    expect(resumed.state).toBe('running');
    expect(resumed.runEpoch).toBe(3);
  });

  it(
    'stops the bridge first, and forces a kill only after the grace expires',
    async () => {
      const { supervisor, calls, terminations, register } = harness({
        probe: { 1800: running(1800, 'omp.exe', 1_000) },
        shutdownGraceMs: 40,
        terminateGraceMs: 40,
        // A bridge that never answers: the deadline must bound this, not hang.
        ports: { shutdownBridge: () => new Promise<void>(() => undefined) },
      });
      register({
        runId: 'run-hung-bridge',
        sessionId: 'session-18',
        runEpoch: 1,
        pid: 1800,
        imageName: 'omp.exe',
        startTime: 1_000,
      });

      const report = await supervisor.dispose();

      expect(calls).toEqual(['closePty']);
      expect(terminations.length).toBeGreaterThan(0);
      expect(terminations.every((pid) => pid === 1800)).toBe(true);
      expect(report.blocked.map((entry) => entry.code)).toContain('shutdown_timeout');
      expect(report.terminated).toEqual(['run-hung-bridge']);
      expectCleanBaseline(supervisor);
    },
    PROCESS_TEST_TIMEOUT_MS,
  );

  it('reports a shutdown it refused as blocked instead of terminated', async () => {
    const { supervisor, calls, terminations, register } = harness({
      probe: { 1900: { kind: 'unknown', reason: 'denied' } },
    });
    register({
      runId: 'run-refused',
      sessionId: 'session-19',
      runEpoch: 1,
      pid: 1900,
      imageName: 'omp.exe',
      startTime: 1_000,
    });

    const report = await supervisor.dispose();

    expect(report.terminated).toEqual([]);
    expect(report.blocked.map((entry) => entry.code)).toEqual(['ownership_unproven']);
    // Refused before anything was closed: the run is left as it was found.
    expect(calls).toEqual([]);
    expect(terminations).toEqual([]);
    expectCleanBaseline(supervisor);
  });
});

describe('follower detachment', () => {
  it(
    "never signals the owner's processes, and drops its handles",
    async () => {
      const child = spawnChild();
      const pid = child.pid as number;
      const { supervisor, calls, terminations, register } = harness({
        probe: { [pid]: running(pid, 'node.exe', 1_000) },
        role: 'follower',
      });
      try {
        register({
          runId: 'run-owner-side',
          sessionId: 'session-20',
          runEpoch: 1,
          pid,
          imageName: 'node.exe',
          startTime: 1_000,
        });

        const report = await supervisor.detachFollower();
        expect(report.role).toBe('follower');
        expect(report.terminated).toEqual([]);
        expect(report.skipped).toEqual(['run-owner-side']);
        expect(calls).toEqual([]);
        expect(terminations).toEqual([]);
        expect(child.exitCode).toBeNull();
        expectCleanBaseline(supervisor);

        // Even an ordinary dispose must not reach the owner's process.
        const afterDispose = await supervisor.dispose();
        expect(afterDispose.role).toBe('follower');
        expect(terminations).toEqual([]);
        expect(child.exitCode).toBeNull();
      } finally {
        child.kill();
      }
    },
    PROCESS_TEST_TIMEOUT_MS,
  );
});

describe('startup reconciliation', () => {
  it('classifies dead, owned and foreign PIDs, and kills nothing', async () => {
    const { supervisor, calls, terminations } = harness({
      probe: {
        2100: { kind: 'absent' },
        2200: running(2200, 'omp.exe', 5_000),
        2300: running(2300, 'omp.exe', 9_999),
      },
    });

    const report = await supervisor.reconcile([
      {
        runId: 'dead',
        sessionId: 'session-21',
        runEpoch: 4,
        pid: 2100,
        imageName: 'omp.exe',
        startTime: 1_000,
        state: 'running',
      },
      {
        runId: 'no-start-time',
        sessionId: 'session-22',
        runEpoch: 4,
        pid: 2200,
        imageName: 'omp.exe',
        startTime: null,
        state: 'running',
      },
      {
        runId: 'still-ours',
        sessionId: 'session-23',
        runEpoch: 4,
        pid: 2200,
        imageName: 'omp.exe',
        startTime: 5_000,
        state: 'running',
      },
      {
        runId: 'recycled',
        sessionId: 'session-24',
        runEpoch: 4,
        pid: 2300,
        imageName: 'omp.exe',
        startTime: 1_000,
        state: 'running',
      },
    ]);

    expect(report.crashed).toEqual(['dead']);
    expect(report.owned).toEqual(['still-ours']);
    expect(report.interrupted).toEqual(['dead', 'no-start-time', 'still-ours', 'recycled']);
    expect(report.blocked.map((entry) => `${entry.runId}:${entry.code}`)).toEqual([
      'no-start-time:ownership_unproven',
      'recycled:ownership_conflict',
    ]);

    // Reconciliation only reports. A dead owner must not turn into a retried
    // side effect, so nothing here is signalled.
    expect(calls).toEqual([]);
    expect(terminations).toEqual([]);
    expect(supervisor.trackedPids).toEqual([2200]);
    expect(supervisor.getRun('still-ours')?.state).toBe('crashed');
    expect(supervisor.getRun('still-ours')?.interrupted).toBe(true);

    await supervisor.dispose();
    expectCleanBaseline(supervisor);
  });

  it('refuses a live PID when the OS reports no start time to compare', async () => {
    const { supervisor, terminations } = harness({
      probe: { 2600: running(2600, 'omp.exe', null) },
    });

    const report = await supervisor.reconcile([
      {
        runId: 'unreadable',
        sessionId: 'session-25',
        runEpoch: 1,
        pid: 2600,
        imageName: 'omp.exe',
        startTime: 1_000,
        state: 'running',
      },
    ]);

    // Same image, live PID, but nothing to compare against: unproven, not owned.
    expect(report.owned).toEqual([]);
    expect(report.blocked.map((entry) => `${entry.runId}:${entry.code}`)).toEqual([
      'unreadable:ownership_unproven',
    ]);
    expect(terminations).toEqual([]);
    expect(supervisor.trackedCount).toBe(0);
  });
});

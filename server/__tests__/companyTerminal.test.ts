import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { COMPANY_MAX_LIVE_RUNNERS } from '../src/company/constants.js';
import { ProcessSupervisor } from '../src/company/processSupervisor.js';
import { PtyClient } from '../src/company/ptyClient.js';
import type { PtySpawnSpec } from '../src/company/ptyHost.js';
import { TerminalSessions } from '../src/company/terminalSessions.js';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PTY_HOST_SOURCE = path.join(REPO_ROOT, 'server', 'src', 'company', 'ptyHost.ts');

/** The shell this suite drives; both branches spawn a real PTY. */
const SHELL = process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : '/bin/sh';
const SHELL_ARGS: string[] = process.platform === 'win32' ? [] : ['-i'];

/**
 * Deferred without `Promise.withResolvers`, which this project's ES2022 lib
 * does not declare. Every wait below settles on a real process event.
 */
function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/**
 * Every wait below resolves on a real process event (a PTY frame, a child
 * exit); the per-test timeout is only the guard that turns a hang into a
 * failure, never the thing being waited for.
 */
const TEST_TIMEOUT_MS = 20_000;

let bundleDir: string;
let bundlePath: string;

/** Decode a terminal frame the way TerminalConsole does before writing it. */
function decodeFrame(base64: string): string {
  return Buffer.from(base64, 'base64').toString('utf-8');
}

function spec(): PtySpawnSpec {
  return {
    file: SHELL,
    args: SHELL_ARGS,
    cwd: REPO_ROOT,
    env: { ...process.env, TERM: 'xterm-256color' } as Record<string, string>,
    cols: 80,
    rows: 24,
    term: 'xterm-256color',
  };
}

describe('native PTY terminal', () => {
  let client: PtyClient;
  let onData: (sessionId: string, data: string) => void = () => undefined;

  beforeAll(async () => {
    // Bundle the helper exactly as esbuild.js does, then run it under a real
    // Node: the same boundary the shipped build uses, native addon included.
    const esbuild = await import('esbuild');
    // Inside the repo, not os.tmpdir(): the bundle keeps `node-pty` external,
    // and Node resolves that from the bundle's own directory upwards.
    bundleDir = await fs.promises.mkdtemp(path.join(REPO_ROOT, '.tmp-pty-'));
    bundlePath = path.join(bundleDir, 'company-pty-host.js');
    await esbuild.build({
      entryPoints: [PTY_HOST_SOURCE],
      outfile: bundlePath,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node20',
      external: ['node-pty', '@xterm/headless', '@xterm/addon-serialize'],
      logLevel: 'silent',
    });
    client = await PtyClient.start({ nodeExecutable: process.execPath, helperScript: bundlePath });
    client.onEvent((event) => {
      if (event.type === 'data') onData(event.sessionId, event.data);
    });
  }, 60_000);

  afterAll(async () => {
    await client?.dispose();
    if (bundleDir) await fs.promises.rm(bundleDir, { recursive: true, force: true });
  });

  it(
    'spawns a real PTY, echoes input and serializes the framebuffer',
    async () => {
      const ptySessionId = randomUUID();
      let output = '';
      const { promise, resolve } = deferred();
      onData = (sessionId, data) => {
        if (sessionId !== ptySessionId) return;
        output += decodeFrame(data);
        if (output.includes('pty-round-trip')) resolve();
      };

      const identity = await client.spawnPty(ptySessionId, spec());

      // The helper must report the process it actually started, because the
      // host cannot learn a PTY child's pid any other way, and ownership is
      // only ever claimed for a pid whose image it can verify.
      expect(identity.pid).toBeGreaterThan(0);
      expect(identity.imageName).toBe(path.basename(SHELL).toLowerCase());
      await client.write(ptySessionId, 'echo pty-round-trip\r');
      await promise;

      // The wire carries base64, exactly as the browser will decode it.
      expect(decodeFrame(await client.snapshot(ptySessionId))).toContain('pty-round-trip');

      await client.kill(ptySessionId);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'refuses to exceed the live PTY bound',
    async () => {
      const ids = Array.from({ length: COMPANY_MAX_LIVE_RUNNERS }, () => randomUUID());
      for (const id of ids) await client.spawnPty(id, spec());

      await expect(client.spawnPty(randomUUID(), spec())).rejects.toMatchObject({
        code: 'pty_capacity_reached',
      });

      for (const id of ids) await client.kill(id);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'rejects writes against a stale run epoch',
    async () => {
      const sessions = new TerminalSessions({ client, resolveSpawnSpec: async () => spec() });
      const sessionId = randomUUID();

      const handle = await sessions.attach(sessionId, 1);
      expect(handle.leaseId).toMatch(/^[0-9a-f-]{36}$/);

      await sessions.write(sessionId, 1, 'echo ok\r', handle.leaseId);
      await expect(
        sessions.write(sessionId, 0, 'echo stale\r', handle.leaseId),
      ).rejects.toMatchObject({
        code: 'stale_terminal_epoch',
      });

      await sessions.dispose();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'refuses terminal input when its control lease was superseded',
    async () => {
      const sessions = new TerminalSessions({ client, resolveSpawnSpec: async () => spec() });
      const sessionId = randomUUID();
      const controller = await sessions.attach(sessionId, 4);
      await sessions.attach(sessionId, 4);

      await expect(
        sessions.write(sessionId, 4, 'echo unauthorized\r', controller.leaseId),
      ).rejects.toMatchObject({ code: 'invalid_terminal_lease' });

      await sessions.dispose();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'rejects resize when the controller lease has been superseded',
    async () => {
      const sessions = new TerminalSessions({ client, resolveSpawnSpec: async () => spec() });
      const sessionId = randomUUID();
      const controller = await sessions.attach(sessionId, 5);
      const replacement = await sessions.attach(sessionId, 5);

      await expect(
        sessions.resize(sessionId, 5, 100, 30, controller.leaseId),
      ).rejects.toMatchObject({
        code: 'invalid_terminal_lease',
      });
      await sessions.resize(sessionId, 5, 100, 30, replacement.leaseId);
      await sessions.dispose();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'rejects detach when the controller lease has been superseded',
    async () => {
      const sessions = new TerminalSessions({ client, resolveSpawnSpec: async () => spec() });
      const sessionId = randomUUID();
      const controller = await sessions.attach(sessionId, 6);
      const replacement = await sessions.attach(sessionId, 6);

      await expect(sessions.detach(sessionId, 6, controller.leaseId)).rejects.toMatchObject({
        code: 'invalid_terminal_lease',
      });
      expect(sessions.liveCount).toBe(1);
      await sessions.detach(sessionId, 6, replacement.leaseId);
      expect(sessions.liveCount).toBe(0);
      await sessions.dispose();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'keeps one PTY per session when a second viewer attaches',
    async () => {
      let spawns = 0;
      const sessions = new TerminalSessions({
        client,
        resolveSpawnSpec: async () => {
          spawns += 1;
          return spec();
        },
      });
      const sessionId = randomUUID();

      let grantedLease: string | null = null;
      const first = await sessions.attach(sessionId, 3);
      const second = await sessions.attach(sessionId, 3, undefined, undefined, (leaseId) => {
        grantedLease = leaseId;
      });
      expect(spawns).toBe(1);
      expect(second.leaseId).not.toBe(first.leaseId);
      expect(grantedLease).toBe(second.leaseId);
      expect(sessions.liveCount).toBe(1);

      await sessions.dispose();
      expect(sessions.liveCount).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'streams sequenced output and releases the session when the PTY dies',
    async () => {
      const outputs: Array<{ seq: number; data: string }> = [];
      const closed: Array<{ sessionId: string; reason: string }> = [];
      const sessionId = randomUUID();
      const sessions = new TerminalSessions({
        client,
        resolveSpawnSpec: async () => spec(),
        onOutput: (event) => outputs.push({ seq: event.seq, data: event.data }),
        onClosed: (event) => closed.push({ sessionId: event.sessionId, reason: event.reason }),
      });

      // Accumulate the raw stream here rather than reading the frames
      // TerminalSessions has already dispatched: both listeners see the same
      // frame, and this one runs first.
      let stream = '';
      const sawOutput = deferred();
      onData = (_sessionId, data) => {
        stream += decodeFrame(data);
        if (stream.includes('closing-now')) sawOutput.resolve();
      };

      const handle = await sessions.attach(sessionId, 0);
      await sessions.write(sessionId, 0, 'echo closing-now\r', handle.leaseId);
      await sawOutput.promise;

      expect(outputs.length).toBeGreaterThan(0);
      expect(outputs.every((entry) => entry.seq > 0)).toBe(true);

      await sessions.detach(sessionId, 0, handle.leaseId);
      expect(sessions.liveCount).toBe(0);
      expect(closed.every((entry) => entry.sessionId === sessionId)).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );
});

describe('process supervisor lineage', () => {
  it(
    'terminates a process it started and refuses a PID running another image',
    async () => {
      const supervisor = new ProcessSupervisor();
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      const pid = child.pid as number;
      const ref = supervisor.track(pid, process.execPath);

      expect(await supervisor.verify(ref)).toBe('owned');

      const exited = deferred();
      child.on('exit', () => exited.resolve());
      expect(await supervisor.terminateTree(ref)).toBe('terminated');
      await exited.promise;
      // A live PID running an image we never started is refused, not killed.
      const other = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      const stranger = supervisor.track(other.pid as number, 'definitely-not-this-binary.exe');
      expect(await supervisor.verify(stranger)).toBe('conflict');
      expect(await supervisor.terminateTree(stranger)).toBe('conflict');
      // The supervisor refused to kill it, so the test cleans up after itself.
      other.kill();

      // A PID that no longer exists is simply gone: nothing to do, nothing killed.
      expect(await supervisor.verify(ref)).toBe('gone');
      expect(supervisor.trackedCount).toBe(1); // the terminated one was released
      await supervisor.disposeAll();
      expect(supervisor.trackedCount).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );
});

import { describe, expect, it } from 'vitest';

import { BROWSER_REAPER_GRACE_MS } from '../../core/src/constants.js';
import type { BrowserReaperStatusMessage } from '../../core/src/messages.js';
import {
  BROWSER_REAPER_DAEMON_NAME,
  browserReaperEnabled,
  countPageTargets,
  createBrowserReaper,
  devToolsPort,
  isStopTimedOut,
  type OmpCommandOutcome,
  parseHeadlessBrowsers,
} from '../src/company/browserReaper.js';
import type { OmpRunnerCommand } from '../src/company/ompRunner.js';
import { BROWSER_REAPER_CHECK_INTERVAL_MS } from '../src/constants.js';

const START = 1_700_000_000_000;
const MIN = 60_000;
const MB = 1024 * 1024;
const COMMAND: OmpRunnerCommand = { file: 'node', args: ['/omp/cli.js'] };
const SUCCESS: OmpCommandOutcome = { stdout: '', stderr: '', exitCode: 0, timedOut: false };
const DIR_A = 'V:/work/project-a';
const DIR_B = 'V:/work/project-b';

interface FakeBrowser {
  readonly id: string;
  readonly pid: number;
  readonly projectDir: string;
  readonly port: number;
  readonly startedAt: number;
  readonly host: string;
  pages: number;
  ready: boolean;
}

/** How a fake `omp ps stop` answers. The reply may stop the browser, or not. */
type StopReply = (browser: FakeBrowser) => OmpCommandOutcome;

const stopAndSucceed: StopReply = (browser) => {
  browser.ready = false;
  return SUCCESS;
};
const stopTimesOut: StopReply = () => ({
  stdout: '',
  stderr: 'Daemon stop request timed out',
  exitCode: 1,
  timedOut: false,
});
const stopHitsDeadline: StopReply = () => ({
  stdout: '',
  stderr: '',
  exitCode: null,
  timedOut: true,
});
const stopFails: StopReply = () => ({
  stdout: '',
  stderr: 'no such daemon',
  exitCode: 1,
  timedOut: false,
});

/** A stop that times out after omp has already begun to end the daemon. */
const stopTimesOutAndExits: StopReply = (browser) => {
  browser.ready = false;
  return { stdout: '', stderr: 'Daemon stop request timed out', exitCode: 1, timedOut: false };
};

/** An omp that lists daemons like `omp ps --all --json` and answers stops, in memory. */
class FakeOmp {
  readonly browsers = new Map<string, FakeBrowser>();
  /** Extra listing entries (persistent, detached, global, other daemons) the reaper must skip. */
  readonly extras: unknown[] = [];
  /** Ports whose DevTools endpoint refuses, even though the daemon is ready. */
  readonly unreachablePorts = new Set<number>();
  /** Replies to the next stop requests, in order. */
  readonly stopReplies: StopReply[] = [];
  /** Used once `stopReplies` is empty. */
  stopByDefault: StopReply = stopAndSucceed;
  readonly stopArgv: string[][] = [];
  readonly infoArgv: string[][] = [];
  /** Makes `omp ps info` fail, as when omp cannot read the daemon. */
  infoFails = false;
  /** Runs before every OMP request, so a test can change the browser between two steps. */
  beforeCall: (argv: readonly string[]) => void = () => undefined;
  readonly probedPorts: number[] = [];
  listCalls = 0;
  listingFails = false;

  add(
    id: string,
    fields: { pid: number; projectDir: string; port: number; pages: number; host?: string },
  ): FakeBrowser {
    const browser: FakeBrowser = {
      id,
      pid: fields.pid,
      projectDir: fields.projectDir,
      port: fields.port,
      startedAt: START,
      host: fields.host ?? '127.0.0.1',
      pages: fields.pages,
      ready: true,
    };
    this.browsers.set(id, browser);
    return browser;
  }

  listing(): unknown[] {
    const projects = [...this.browsers.values()].map((browser) => ({
      kind: 'project',
      projectDir: browser.projectDir,
      runtimeDir: `${browser.projectDir}/.omp`,
      brokerPid: browser.pid + 1,
      daemons: [browser.ready ? readyDaemon(browser) : exitedDaemon(browser)],
    }));
    return [...projects, ...this.extras];
  }

  async runOmp(command: OmpRunnerCommand, argv: readonly string[]): Promise<OmpCommandOutcome> {
    if (command !== COMMAND) throw new Error('reaper ran an unexpected OMP command');
    this.beforeCall(argv);
    if (argv[0] === 'ps' && argv[1] === '--all') {
      this.listCalls += 1;
      if (this.listingFails) {
        return { stdout: '', stderr: 'omp: not found', exitCode: 1, timedOut: false };
      }
      return { stdout: JSON.stringify(this.listing()), stderr: '', exitCode: 0, timedOut: false };
    }
    if (argv[0] === 'ps' && argv[1] === 'info') {
      this.infoArgv.push([...argv]);
      if (this.infoFails) {
        return { stdout: '', stderr: 'omp: not found', exitCode: 1, timedOut: false };
      }
      const projectDir = argv[argv.indexOf('--dir') + 1];
      const browser = [...this.browsers.values()].find(
        (candidate) => candidate.projectDir === projectDir,
      );
      if (browser === undefined) {
        return { stdout: '', stderr: 'no such daemon', exitCode: 1, timedOut: false };
      }
      const daemon = browser.ready ? readyDaemon(browser) : exitedDaemon(browser);
      return { stdout: JSON.stringify(daemon), stderr: '', exitCode: 0, timedOut: false };
    }
    if (argv[0] === 'ps' && argv[1] === 'stop') {
      this.stopArgv.push([...argv]);
      const projectDir = argv[argv.indexOf('--dir') + 1];
      const browser = [...this.browsers.values()].find(
        (candidate) => candidate.projectDir === projectDir && candidate.ready,
      );
      const reply = this.stopReplies.shift() ?? this.stopByDefault;
      if (browser === undefined) {
        return { stdout: '', stderr: 'no such daemon', exitCode: 1, timedOut: false };
      }
      return reply(browser);
    }
    throw new Error(`unexpected omp argv: ${argv.join(' ')}`);
  }

  async fetchJson(url: string): Promise<unknown> {
    const target = new URL(url);
    const port = Number(target.port);
    this.probedPorts.push(port);
    const browser = [...this.browsers.values()].find((candidate) => candidate.port === port);
    if (
      target.hostname !== '127.0.0.1' ||
      browser === undefined ||
      !browser.ready ||
      this.unreachablePorts.has(port)
    ) {
      throw new Error(`connect ECONNREFUSED ${target.host}`);
    }
    const pages = Array.from({ length: browser.pages }, () => ({ type: 'page' }));
    return [...pages, { type: 'service_worker' }];
  }
}

function readyDaemon(browser: FakeBrowser): Record<string, unknown> {
  return {
    name: BROWSER_REAPER_DAEMON_NAME,
    id: browser.id,
    state: 'ready',
    pid: browser.pid,
    startedAt: browser.startedAt,
    readyMatch: `DevTools listening on ws://${browser.host}:${browser.port}/devtools/browser/${browser.id}`,
    persist: false,
    detached: false,
    supervised: true,
  };
}

function exitedDaemon(browser: FakeBrowser): Record<string, unknown> {
  return {
    name: BROWSER_REAPER_DAEMON_NAME,
    id: browser.id,
    state: 'exited',
    startedAt: browser.startedAt,
    readyMatch: `DevTools listening on ws://${browser.host}:${browser.port}/devtools/browser/${browser.id}`,
    persist: false,
    detached: false,
    supervised: true,
  };
}

function harness(enabled = true) {
  const omp = new FakeOmp();
  const clock = { t: START };
  const timers: { run?: () => void; everyMs?: number; cancelled: boolean } = { cancelled: false };
  const published: BrowserReaperStatusMessage[] = [];
  const logs: string[] = [];
  const warnings: string[] = [];
  const reaper = createBrowserReaper({
    enabled,
    deps: {
      resolveCommand: () => COMMAND,
      runOmp: (command, argv) => omp.runOmp(command, argv),
      fetchJson: (url) => omp.fetchJson(url),
      treeMemoryBytes: async () => 300 * MB,
      now: () => clock.t,
      schedule: (run, everyMs) => {
        timers.run = run;
        timers.everyMs = everyMs;
        timers.cancelled = false;
        return () => {
          timers.cancelled = true;
        };
      },
      publish: (message) => {
        published.push(message);
      },
      log: (message) => {
        logs.push(message);
      },
      warn: (message) => {
        warnings.push(message);
      },
    },
  });
  return { omp, reaper, clock, timers, published, logs, warnings };
}

function stopCommand(projectDir: string): string[] {
  return ['ps', 'stop', BROWSER_REAPER_DAEMON_NAME, '--dir', projectDir, '--timeout', '5'];
}

function infoCommand(projectDir: string): string[] {
  return ['ps', 'info', BROWSER_REAPER_DAEMON_NAME, '--dir', projectDir, '--json'];
}

describe('browser reaper: grace period', () => {
  it('stops a zero-page browser only after ten minutes of zero pages on every check', async () => {
    const h = harness();
    h.omp.add('a', { pid: 101, projectDir: DIR_A, port: 9001, pages: 0 });

    h.clock.t = START;
    await h.reaper.check();
    h.clock.t = START + BROWSER_REAPER_GRACE_MS - MIN;
    await h.reaper.check();
    expect(h.omp.stopArgv).toEqual([]);

    h.clock.t = START + BROWSER_REAPER_GRACE_MS;
    await h.reaper.check();
    expect(h.omp.stopArgv).toEqual([stopCommand(DIR_A)]);

    // The next listing shows the daemon gone: the reap is confirmed and counted.
    h.clock.t = START + BROWSER_REAPER_GRACE_MS + BROWSER_REAPER_CHECK_INTERVAL_MS;
    await h.reaper.check();
    const status = h.reaper.snapshot();
    expect(status.reapedCount).toBe(1);
    expect(status.freedMb).toBe(300);
    expect(status.browsers).toEqual([]);
    expect(h.logs.some((line) => line.includes(DIR_A) && line.includes('freed about 300 MB'))).toBe(
      true,
    );
  });

  it('restarts the grace period when a page opens and closes', async () => {
    const h = harness();
    const browserA = h.omp.add('a', { pid: 101, projectDir: DIR_A, port: 9001, pages: 0 });

    h.clock.t = START;
    await h.reaper.check();
    h.clock.t = START + 5 * MIN;
    browserA.pages = 1;
    await h.reaper.check();
    expect(h.reaper.snapshot().browsers[0]).toMatchObject({ pages: 1, idleSince: null });

    h.clock.t = START + 6 * MIN;
    browserA.pages = 0;
    await h.reaper.check();
    const idleSince = new Date(START + 6 * MIN).toISOString();
    expect(h.reaper.snapshot().browsers[0]).toMatchObject({ pages: 0, idleSince });

    // Ten minutes from the page closing, not from the first zero.
    h.clock.t = START + 15 * MIN;
    await h.reaper.check();
    expect(h.omp.stopArgv).toEqual([]);

    h.clock.t = START + 16 * MIN;
    await h.reaper.check();
    expect(h.omp.stopArgv).toEqual([stopCommand(DIR_A)]);
  });

  it('never stops a browser that has pages, even on a manual reap', async () => {
    const h = harness();
    h.omp.add('a', { pid: 101, projectDir: DIR_A, port: 9001, pages: 2 });
    h.omp.add('b', { pid: 102, projectDir: DIR_B, port: 9002, pages: 0 });

    h.clock.t = START;
    await h.reaper.check();
    h.clock.t = START + MIN;
    await h.reaper.reapNow();

    expect(h.omp.stopArgv).toEqual([stopCommand(DIR_B)]);
    expect(h.reaper.snapshot().browsers.find((b) => b.projectDir === DIR_A)?.pages).toBe(2);
  });
});

describe('browser reaper: what it may touch', () => {
  it('skips persistent, detached, global, exited and non-headless daemons', async () => {
    const h = harness();
    h.omp.extras.push(
      {
        kind: 'project',
        projectDir: 'V:/work/persistent',
        daemons: [
          {
            name: BROWSER_REAPER_DAEMON_NAME,
            id: 'p1',
            state: 'ready',
            pid: 201,
            readyMatch: 'DevTools listening on ws://127.0.0.1:9100/devtools/browser/p1',
            persist: true,
            detached: false,
          },
        ],
      },
      {
        kind: 'project',
        projectDir: 'V:/work/detached',
        daemons: [
          {
            name: BROWSER_REAPER_DAEMON_NAME,
            id: 'd1',
            state: 'ready',
            pid: 202,
            readyMatch: 'DevTools listening on ws://127.0.0.1:9101/devtools/browser/d1',
            persist: false,
            detached: true,
          },
        ],
      },
      {
        kind: 'project',
        projectDir: 'V:/work/other-daemon',
        daemons: [
          {
            name: 'omp.lsp',
            id: 'l1',
            state: 'ready',
            pid: 203,
            readyMatch: 'DevTools listening on ws://127.0.0.1:9103/devtools/browser/l1',
            persist: false,
            detached: false,
          },
        ],
      },
      {
        kind: 'global',
        service: 'browser-relay',
        daemons: [
          {
            name: 'omp.browser.relay',
            id: 'g1',
            state: 'ready',
            pid: 204,
            readyMatch: 'DevTools listening on ws://127.0.0.1:9102/devtools/browser/g1',
            persist: false,
            detached: false,
          },
        ],
      },
    );
    h.omp.add('gone', { pid: 205, projectDir: 'V:/work/gone', port: 9104, pages: 0 }).ready = false;

    h.clock.t = START + 30 * MIN;
    await h.reaper.check();
    await h.reaper.reapNow();

    expect(h.omp.stopArgv).toEqual([]);
    expect(h.omp.probedPorts).toEqual([]);
    expect(h.reaper.snapshot().browsers).toEqual([]);
  });

  it('refuses a DevTools endpoint that is not 127.0.0.1, and warns once', async () => {
    const h = harness();
    h.omp.add('remote', { pid: 301, projectDir: DIR_A, port: 9001, pages: 0, host: '10.0.0.5' });

    h.clock.t = START;
    await h.reaper.check();
    h.clock.t = START + 30 * MIN;
    await h.reaper.reapNow();

    expect(h.omp.probedPorts).toEqual([]);
    expect(h.omp.stopArgv).toEqual([]);
    expect(h.warnings.filter((line) => line.includes('refused'))).toHaveLength(1);
  });
});

describe('browser reaper: stop attempts', () => {
  it('retries once when omp reports a stop timeout, then confirms on the next listing', async () => {
    const h = harness();
    h.omp.add('a', { pid: 101, projectDir: DIR_A, port: 9001, pages: 0 });
    h.omp.stopReplies.push(stopTimesOut);

    await h.reaper.reapNow();
    expect(h.omp.stopArgv).toEqual([stopCommand(DIR_A), stopCommand(DIR_A)]);

    h.clock.t = START + MIN;
    await h.reaper.check();
    expect(h.reaper.snapshot().reapedCount).toBe(1);
    expect(h.warnings).toEqual([]);
  });

  it('also retries when the stop hits its own deadline', async () => {
    const h = harness();
    h.omp.add('a', { pid: 101, projectDir: DIR_A, port: 9001, pages: 0 });
    h.omp.stopReplies.push(stopHitsDeadline);

    await h.reaper.reapNow();
    expect(h.omp.stopArgv).toHaveLength(2);
  });

  it('gives up after two attempts and starts the grace period again', async () => {
    const h = harness();
    h.omp.add('a', { pid: 101, projectDir: DIR_A, port: 9001, pages: 0 });
    h.omp.stopByDefault = stopFails;

    h.clock.t = START;
    await h.reaper.check();
    h.clock.t = START + BROWSER_REAPER_GRACE_MS;
    await h.reaper.check(); // attempt 1
    h.clock.t = START + BROWSER_REAPER_GRACE_MS + BROWSER_REAPER_CHECK_INTERVAL_MS;
    await h.reaper.check(); // attempt 2
    expect(h.omp.stopArgv).toHaveLength(2);

    // Both attempts spent: the next check gives up without another stop.
    h.clock.t = START + BROWSER_REAPER_GRACE_MS + 2 * BROWSER_REAPER_CHECK_INTERVAL_MS;
    await h.reaper.check();
    expect(h.omp.stopArgv).toHaveLength(2);
    expect(h.warnings.some((line) => line.includes('grace period starts again'))).toBe(true);

    // The grace period restarts at the give-up: still no stop a check later...
    h.clock.t = START + BROWSER_REAPER_GRACE_MS + 3 * BROWSER_REAPER_CHECK_INTERVAL_MS;
    await h.reaper.check();
    expect(h.omp.stopArgv).toHaveLength(2);

    // ...and a fresh reap ten minutes after the give-up.
    h.omp.stopByDefault = stopAndSucceed;
    h.clock.t = START + 2 * BROWSER_REAPER_GRACE_MS + 2 * BROWSER_REAPER_CHECK_INTERVAL_MS;
    await h.reaper.check();
    expect(h.omp.stopArgv).toHaveLength(3);
  });
});

describe('browser reaper: "Dọn ngay"', () => {
  it('bypasses the grace period for zero-page browsers only', async () => {
    const h = harness();
    h.omp.add('a', { pid: 101, projectDir: DIR_A, port: 9001, pages: 0 });
    h.omp.add('b', { pid: 102, projectDir: DIR_B, port: 9002, pages: 4 });

    h.clock.t = START;
    await h.reaper.check();
    h.clock.t = START + MIN;
    await h.reaper.reapNow();

    expect(h.omp.stopArgv).toEqual([stopCommand(DIR_A)]);
  });
});

describe('browser reaper: off switch', () => {
  it('lists, probes, stops and schedules nothing when disabled', async () => {
    const h = harness(false);
    h.omp.add('a', { pid: 101, projectDir: DIR_A, port: 9001, pages: 0 });

    h.reaper.start();
    await h.reaper.check();
    await h.reaper.reapNow();

    expect(h.timers.run).toBeUndefined();
    expect(h.omp.listCalls).toBe(0);
    expect(h.omp.stopArgv).toEqual([]);
    expect(h.published).toEqual([
      { type: 'browserReaperStatus', enabled: false, browsers: [], reapedCount: 0, freedMb: 0 },
    ]);
  });

  it('honours the flag and the environment switch', () => {
    expect(browserReaperEnabled(true, {})).toBe(true);
    expect(browserReaperEnabled(true, { PIXEL_AGENTS_BROWSER_REAPER: '1' })).toBe(true);
    expect(browserReaperEnabled(true, { PIXEL_AGENTS_BROWSER_REAPER: '0' })).toBe(false);
    expect(browserReaperEnabled(false, {})).toBe(false);
  });
});

describe('browser reaper: scheduling', () => {
  it('runs a check every check interval and cancels it on stop', async () => {
    const h = harness();
    h.omp.add('a', { pid: 101, projectDir: DIR_A, port: 9001, pages: 0 });

    h.reaper.start();
    expect(h.timers.everyMs).toBe(BROWSER_REAPER_CHECK_INTERVAL_MS);
    h.timers.run?.();
    await h.reaper.check();
    expect(h.reaper.snapshot().browsers).toHaveLength(1);

    h.reaper.stop();
    expect(h.timers.cancelled).toBe(true);
  });
});

describe('browser reaper: failures skip the check', () => {
  it('warns once and stops nothing when the listing fails', async () => {
    const h = harness();
    h.omp.add('a', { pid: 101, projectDir: DIR_A, port: 9001, pages: 0 });
    h.omp.listingFails = true;

    h.clock.t = START + 30 * MIN;
    await h.reaper.check();
    await h.reaper.check();

    expect(h.warnings).toHaveLength(1);
    expect(h.warnings[0]).toContain('skipped this check');
    expect(h.omp.stopArgv).toEqual([]);
    expect(h.published).toEqual([]);
  });

  it('does not count an unreachable DevTools endpoint as zero pages', async () => {
    const h = harness();
    h.omp.add('a', { pid: 101, projectDir: DIR_A, port: 9001, pages: 0 });
    h.omp.unreachablePorts.add(9001);

    h.clock.t = START;
    await h.reaper.check();
    h.clock.t = START + 30 * MIN;
    await h.reaper.check();

    expect(h.reaper.snapshot().browsers).toEqual([]);
    expect(h.omp.stopArgv).toEqual([]);
    expect(h.warnings.some((line) => line.includes('could not count pages'))).toBe(true);
  });
});

describe('browser reaper: parsing', () => {
  it('keeps only ready, non-persistent, non-detached omp.browser.headless daemons', () => {
    const listing = [
      {
        kind: 'project',
        projectDir: 'V:/Duancanhan/Project_QuanLyGiaiDau/HethongFrontEndApp_QLgiaidau',
        runtimeDir: 'V:/Duancanhan/.omp',
        brokerPid: 28000,
        daemons: [
          {
            name: BROWSER_REAPER_DAEMON_NAME,
            id: 'h1',
            state: 'ready',
            pid: 28876,
            startedAt: START,
            readyMatch: 'DevTools listening on ws://127.0.0.1:51417/devtools/browser/h1',
            persist: false,
            detached: false,
            supervised: true,
            command: ['chrome'],
          },
        ],
      },
      {
        kind: 'project',
        projectDir: 'D:/work',
        daemons: [
          {
            name: BROWSER_REAPER_DAEMON_NAME,
            id: 'h2',
            state: 'ready',
            pid: 33432,
            startedAt: START,
            readyMatch: 'DevTools listening on ws://127.0.0.1:64519/devtools/browser/h2',
            persist: true,
            detached: false,
          },
          {
            name: BROWSER_REAPER_DAEMON_NAME,
            id: 'h3',
            state: 'exited',
            startedAt: START,
            readyMatch: 'DevTools listening on ws://127.0.0.1:1/devtools/browser/h3',
            persist: false,
            detached: false,
          },
        ],
      },
      {
        kind: 'global',
        service: 'browser-relay',
        daemons: [
          {
            name: 'omp.browser.relay',
            id: 'g1',
            state: 'ready',
            pid: 1,
            readyMatch: 'DevTools listening on ws://127.0.0.1:2/devtools/browser/g1',
            persist: false,
            detached: false,
          },
        ],
      },
    ];

    expect(parseHeadlessBrowsers(listing)).toEqual([
      {
        id: 'h1',
        pid: 28876,
        projectDir: 'V:/Duancanhan/Project_QuanLyGiaiDau/HethongFrontEndApp_QLgiaidau',
        startedAt: START,
        readyMatch: 'DevTools listening on ws://127.0.0.1:51417/devtools/browser/h1',
      },
    ]);
  });

  it('rejects a listing that is not an array', () => {
    expect(() => parseHeadlessBrowsers({ kind: 'project' })).toThrow(TypeError);
  });

  it('reads the loopback DevTools port only for exactly 127.0.0.1', () => {
    expect(devToolsPort('DevTools listening on ws://127.0.0.1:51417/devtools/browser/x')).toBe(
      51417,
    );
    expect(devToolsPort('DevTools listening on ws://10.0.0.5:9222/devtools/browser/x')).toBeNull();
    expect(devToolsPort('DevTools listening on ws://localhost:9222/devtools/browser/x')).toBeNull();
    expect(
      devToolsPort('DevTools listening on ws://127.0.0.1:99999/devtools/browser/x'),
    ).toBeNull();
    expect(devToolsPort('no endpoint here')).toBeNull();
  });

  it('counts only page targets', () => {
    expect(countPageTargets([])).toBe(0);
    expect(countPageTargets([{ type: 'page' }, { type: 'service_worker' }, { type: 'page' }])).toBe(
      2,
    );
    expect(() => countPageTargets({ type: 'page' })).toThrow(TypeError);
  });

  it('recognises a stop that timed out, by deadline or by its own words', () => {
    expect(isStopTimedOut({ stdout: '', stderr: '', exitCode: null, timedOut: true })).toBe(true);
    expect(
      isStopTimedOut({
        stdout: '',
        stderr: 'Daemon stop request timed out',
        exitCode: 1,
        timedOut: false,
      }),
    ).toBe(true);
    expect(isStopTimedOut(SUCCESS)).toBe(false);
  });
});

describe('browser reaper: re-check before every stop', () => {
  it('stops a browser whose identity is unchanged and that has no page', async () => {
    const h = harness();
    h.omp.add('a', { pid: 101, projectDir: DIR_A, port: 9001, pages: 0 });

    h.clock.t = START;
    await h.reaper.check();
    h.clock.t = START + BROWSER_REAPER_GRACE_MS;
    await h.reaper.check();

    expect(h.omp.infoArgv).toEqual([infoCommand(DIR_A)]);
    expect(h.omp.stopArgv).toEqual([stopCommand(DIR_A)]);
  });

  it('does not stop a daemon that was replaced between the probe and the stop', async () => {
    const h = harness();
    h.omp.add('a', { pid: 101, projectDir: DIR_A, port: 9001, pages: 0 });
    let swapped = false;
    h.omp.beforeCall = (argv) => {
      if (argv[1] !== 'info' || swapped) return;
      swapped = true;
      h.omp.browsers.delete('a');
      h.omp.add('b', { pid: 202, projectDir: DIR_A, port: 9002, pages: 0 });
    };

    h.clock.t = START;
    await h.reaper.check();
    h.clock.t = START + BROWSER_REAPER_GRACE_MS;
    await h.reaper.check();
    expect(h.omp.stopArgv).toEqual([]);
    expect(h.reaper.snapshot().browsers).toEqual([]);

    // The replacement is tracked afresh: its own grace period starts now.
    h.clock.t = START + BROWSER_REAPER_GRACE_MS + BROWSER_REAPER_CHECK_INTERVAL_MS;
    await h.reaper.check();
    expect(h.omp.stopArgv).toEqual([]);
    expect(h.reaper.snapshot().browsers).toEqual([
      expect.objectContaining({ projectDir: DIR_A, pages: 0, idleSince: expect.any(String) }),
    ]);
  });

  it('does not stop a browser whose page opened between the probe and the stop', async () => {
    const h = harness();
    const browserA = h.omp.add('a', { pid: 101, projectDir: DIR_A, port: 9001, pages: 0 });
    h.clock.t = START;
    await h.reaper.check();

    h.clock.t = START + BROWSER_REAPER_GRACE_MS;
    h.omp.beforeCall = (argv) => {
      if (argv[1] === 'info') browserA.pages = 1;
    };
    await h.reaper.check();

    expect(h.omp.stopArgv).toEqual([]);
    expect(h.reaper.snapshot().browsers).toEqual([
      expect.objectContaining({ pages: 1, idleSince: null }),
    ]);
  });

  it('does not retry a timed-out stop when a page opened in between', async () => {
    const h = harness();
    const browserA = h.omp.add('a', { pid: 101, projectDir: DIR_A, port: 9001, pages: 0 });
    h.omp.stopReplies.push(stopTimesOut);
    let infoCalls = 0;
    h.omp.beforeCall = (argv) => {
      if (argv[1] !== 'info') return;
      infoCalls += 1;
      // The second re-read is the one before the retry.
      if (infoCalls === 2) browserA.pages = 1;
    };

    await h.reaper.reapNow();

    expect(infoCalls).toBe(2);
    expect(h.omp.stopArgv).toEqual([stopCommand(DIR_A)]);
    expect(h.reaper.snapshot().browsers).toEqual([
      expect.objectContaining({ pages: 1, idleSince: null }),
    ]);
  });

  it('"Dọn ngay" uses the same guard: a page opened before the stop keeps the browser', async () => {
    const h = harness();
    const browserA = h.omp.add('a', { pid: 101, projectDir: DIR_A, port: 9001, pages: 0 });
    h.omp.beforeCall = (argv) => {
      if (argv[1] === 'info') browserA.pages = 1;
    };

    await h.reaper.reapNow();

    expect(h.omp.stopArgv).toEqual([]);
  });

  it('does not stop again a daemon that exits during a timed-out stop; counts it once it is gone', async () => {
    const h = harness();
    h.omp.add('a', { pid: 101, projectDir: DIR_A, port: 9001, pages: 0 });
    h.omp.stopReplies.push(stopTimesOutAndExits);

    await h.reaper.reapNow();
    expect(h.omp.stopArgv).toEqual([stopCommand(DIR_A)]);
    expect(h.omp.infoArgv).toHaveLength(2);

    h.clock.t = START + MIN;
    await h.reaper.check();
    expect(h.reaper.snapshot().reapedCount).toBe(1);
    expect(h.warnings).toEqual([]);
  });

  it('does not stop when omp cannot re-read the daemon', async () => {
    const h = harness();
    h.omp.add('a', { pid: 101, projectDir: DIR_A, port: 9001, pages: 0 });
    h.omp.infoFails = true;

    await h.reaper.reapNow();

    expect(h.omp.stopArgv).toEqual([]);
    expect(h.omp.infoArgv).toHaveLength(1);
  });
});

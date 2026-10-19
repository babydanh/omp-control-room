/**
 * browserReaper: stops omp's idle headless browsers.
 *
 * omp keeps one Chrome per project (`omp.browser.headless`) running after its last
 * tab closes, roughly 300 MB each for hours. Each check reads `omp ps --all --json`,
 * counts the page targets on every ready browser's loopback DevTools endpoint, and
 * stops a browser only after it has held zero pages on every check for
 * {@link BROWSER_REAPER_GRACE_MS}. The next omp browser use relaunches it in about
 * two seconds, so a reap costs a cold start, never a lost page.
 *
 * The listing alone decides what may be touched. `persist` and `detached` daemons,
 * global entries and every daemon that is not `omp.browser.headless` are left alone,
 * and a DevTools endpoint that is not 127.0.0.1 is refused.
 *
 * Right before every stop request the daemon is read again (`omp ps info`). It must
 * still be the tracked daemon, be ready, and hold zero pages; otherwise that reap ends.
 *
 * Every boundary is a dependency ({@link BrowserReaperDeps}): the OMP runner, the
 * DevTools fetch, the process-tree memory read, the clock and the scheduler. Tests
 * drive this module with fakes, and nothing here starts a timer or a browser by
 * itself. The real boundaries live in `browserReaperProbes.ts`.
 */

import { BROWSER_REAPER_GRACE_MS } from '../../../core/src/constants.js';
import type { BrowserReaperStatusMessage } from '../../../core/src/messages.js';
import {
  BROWSER_REAPER_CHECK_INTERVAL_MS,
  BROWSER_REAPER_MAX_STOP_ATTEMPTS,
  BROWSER_REAPER_STOP_TIMEOUT_SECONDS,
} from '../constants.js';
import type { OmpRunnerCommand } from './ompRunner.js';

/** The one daemon this module manages. Any other daemon name is left alone. */
export const BROWSER_REAPER_DAEMON_NAME = 'omp.browser.headless';
/** Environment switch: `PIXEL_AGENTS_BROWSER_REAPER=0` turns the reaper off. */
export const BROWSER_REAPER_ENV = 'PIXEL_AGENTS_BROWSER_REAPER';

const LOOPBACK_HOST = '127.0.0.1';
const DEVTOOLS_READY_PATTERN = /DevTools listening on ws:\/\/([^/\s]+):(\d+)\//;
const TIMED_OUT_PATTERN = /timed out/i;
const BYTES_PER_MB = 1024 * 1024;
const MS_PER_MINUTE = 60_000;

/** A ready, managed headless browser, as the listing describes it. */
export interface HeadlessBrowserCandidate {
  readonly id: string;
  readonly pid: number;
  readonly projectDir: string;
  readonly startedAt: number;
  readonly readyMatch: string;
}

/** What one OMP invocation reported. `timedOut` is set when its deadline killed it. */
export interface OmpCommandOutcome {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
}

/** Every boundary the reaper touches. Injected so tests never spawn OMP or Chrome. */
export interface BrowserReaperDeps {
  /** The resolved OMP command. Throws when OMP is not installed. */
  resolveCommand(): OmpRunnerCommand;
  /**
   * Runs the command with a literal argv (never a shell) and a deadline. `cwd`, when
   * given, is the working directory for this one call: `omp ps info`/`stop` resolve
   * their project from the working directory, which wins over `--dir`.
   */
  runOmp(
    command: OmpRunnerCommand,
    argv: readonly string[],
    cwd?: string,
  ): Promise<OmpCommandOutcome>;
  /** GETs a loopback DevTools endpoint and returns its parsed JSON. Rejects on any failure. */
  fetchJson(url: string): Promise<unknown>;
  /** Summed working-set bytes of a process and its descendants; 0 when unreadable. Read-only. */
  treeMemoryBytes(pid: number): Promise<number>;
  now(): number;
  /** Runs `run` every `everyMs`. Returns the function that cancels it. */
  schedule(run: () => void, everyMs: number): () => void;
  /** Receives every status change, to broadcast to privileged clients. */
  publish(message: BrowserReaperStatusMessage): void;
  log(message: string): void;
  warn(message: string): void;
}

export interface BrowserReaperOptions {
  /** False when the off switch is set: nothing is listed, probed or stopped. */
  readonly enabled: boolean;
  readonly deps: BrowserReaperDeps;
}

/** The part of the reaper the company board and the socket handler use. */
export interface BrowserReaperControl {
  /** The status as of now, without running a check. */
  snapshot(): BrowserReaperStatusMessage;
  /** "Dọn ngay": stop every browser with zero pages now, without the grace period. */
  reapNow(): Promise<void>;
}

export interface BrowserReaper extends BrowserReaperControl {
  /** Publishes the status and starts the periodic check (none when disabled). */
  start(): void;
  /** Cancels the periodic check. A check already queued still finishes. */
  stop(): void;
  /** One periodic check. Resolves when it has finished. */
  check(): Promise<void>;
}

/** The current reap of one browser: its first measurements and how many stops were sent. */
interface PendingReap {
  /** Working-set bytes of the process tree, read before the first stop. */
  readonly rssBytes: number;
  /** The browser's uptime when the reap began, for the log line. */
  readonly uptimeMs: number;
  attempts: number;
}

interface TrackedBrowser {
  readonly id: string;
  readonly pid: number;
  readonly projectDir: string;
  readonly startedAt: number;
  pages: number;
  /** When this browser first had zero pages in the current run of checks; null while it has pages. */
  zeroSince: number | null;
  pending: PendingReap | null;
}

/** The daemon as `omp ps info` describes it now: the identity fields the guard compares. */
interface DaemonInfo {
  readonly id: string;
  /** Null once the daemon has exited. */
  readonly pid: number | null;
  readonly startedAt: number;
  readonly state: string;
  readonly readyMatch: string;
}

/** Whether the off switch leaves the reaper on. A flag or env value of off wins. */
export function browserReaperEnabled(
  flagOn: boolean,
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  return flagOn && env[BROWSER_REAPER_ENV] !== '0';
}

/**
 * The browsers the listing lets the reaper manage: ready, `persist: false`,
 * `detached: false`, inside a project entry. Throws only when the listing is not an array.
 */
export function parseHeadlessBrowsers(listing: unknown): HeadlessBrowserCandidate[] {
  if (!Array.isArray(listing)) throw new TypeError('omp ps did not print a JSON array');
  const found: HeadlessBrowserCandidate[] = [];
  const entries: unknown[] = listing;
  for (const entry of entries) {
    if (!isRecord(entry) || entry['kind'] !== 'project') continue;
    const projectDir = entry['projectDir'];
    const daemons = entry['daemons'];
    if (typeof projectDir !== 'string' || projectDir === '' || !Array.isArray(daemons)) continue;
    const list: unknown[] = daemons;
    for (const daemon of list) {
      if (!isRecord(daemon)) continue;
      if (daemon['name'] !== BROWSER_REAPER_DAEMON_NAME || daemon['state'] !== 'ready') continue;
      // Both flags must be present and false. Anything else belongs to someone else.
      if (daemon['persist'] !== false || daemon['detached'] !== false) continue;
      const id = daemon['id'];
      const pid = daemon['pid'];
      const startedAt = daemon['startedAt'];
      const readyMatch = daemon['readyMatch'];
      if (typeof id !== 'string' || typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
        continue;
      }
      if (typeof startedAt !== 'number' || !Number.isFinite(startedAt)) continue;
      if (typeof readyMatch !== 'string') continue;
      found.push({ id, pid, projectDir, startedAt, readyMatch });
    }
  }
  return found;
}

/**
 * The loopback port a daemon's `readyMatch` names, or null. A host other than
 * 127.0.0.1 is refused: the reaper only ever talks to the machine it runs on.
 */
export function devToolsPort(readyMatch: string): number | null {
  const match = DEVTOOLS_READY_PATTERN.exec(readyMatch);
  if (match === null || match[1] !== LOOPBACK_HOST) return null;
  const port = Number(match[2]);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

/** The page targets in a DevTools `/json/list` body. Throws when the body is not a list. */
export function countPageTargets(body: unknown): number {
  if (!Array.isArray(body)) throw new TypeError('DevTools /json/list did not return a list');
  const targets: unknown[] = body;
  return targets.filter((target) => isRecord(target) && target['type'] === 'page').length;
}

/** Whether an OMP stop reported a timeout, either by its deadline or in its own words. */
export function isStopTimedOut(outcome: OmpCommandOutcome): boolean {
  return outcome.timedOut || TIMED_OUT_PATTERN.test(`${outcome.stdout}\n${outcome.stderr}`);
}

export function createBrowserReaper(options: BrowserReaperOptions): BrowserReaper {
  return new BrowserReaperService(options);
}

class BrowserReaperService implements BrowserReaper {
  readonly #enabled: boolean;
  readonly #deps: BrowserReaperDeps;
  readonly #tracked = new Map<string, TrackedBrowser>();
  readonly #warned = new Set<string>();
  #visible: TrackedBrowser[] = [];
  #reapedCount = 0;
  #freedBytes = 0;
  #queue: Promise<void> = Promise.resolve();
  #cancelSchedule: (() => void) | null = null;
  #stopped = false;

  constructor(options: BrowserReaperOptions) {
    this.#enabled = options.enabled;
    this.#deps = options.deps;
  }

  start(): void {
    this.#deps.publish(this.snapshot());
    if (!this.#enabled) {
      this.#deps.log('Browser reaper is off; idle omp headless browsers are left running.');
      return;
    }
    this.#cancelSchedule = this.#deps.schedule(() => {
      void this.check();
    }, BROWSER_REAPER_CHECK_INTERVAL_MS);
  }

  stop(): void {
    this.#stopped = true;
    this.#cancelSchedule?.();
    this.#cancelSchedule = null;
  }

  check(): Promise<void> {
    return this.#enqueue(false);
  }

  reapNow(): Promise<void> {
    return this.#enqueue(true);
  }

  snapshot(): BrowserReaperStatusMessage {
    const now = this.#deps.now();
    return {
      type: 'browserReaperStatus',
      enabled: this.#enabled,
      browsers: this.#visible.map((tracked) => ({
        projectDir: tracked.projectDir,
        pages: tracked.pages,
        idleSince: tracked.zeroSince === null ? null : new Date(tracked.zeroSince).toISOString(),
        uptimeMs: Math.max(0, now - tracked.startedAt),
      })),
      reapedCount: this.#reapedCount,
      freedMb: roundMb(this.#freedBytes),
    };
  }

  /** Checks run one at a time, in order, so a "Dọn ngay" never races the periodic check. */
  #enqueue(manual: boolean): Promise<void> {
    const run = this.#queue
      .then(() => this.#runCheck(manual))
      .catch((error: unknown) => {
        this.#warnOnce('check', `Browser reaper check failed: ${describeError(error)}`);
      });
    this.#queue = run;
    return run;
  }

  async #runCheck(manual: boolean): Promise<void> {
    if (!this.#enabled || this.#stopped) return;
    const listed = await this.#list();
    if (listed === null) return;

    const now = this.#deps.now();
    this.#settleGone(listed.browsers);
    const visible = await this.#probe(listed.browsers, now);
    for (const tracked of visible) {
      if (tracked.pages > 0) continue;
      const due =
        manual ||
        (tracked.zeroSince !== null && now - tracked.zeroSince >= BROWSER_REAPER_GRACE_MS);
      if (due) await this.#reap(tracked, listed.command);
    }
    // A check still running when the server stops must not publish into a disposed store.
    if (this.#stopped) return;
    // A browser forgotten during its reap (its daemon was replaced) leaves the status now.
    this.#visible = visible.filter((tracked) => this.#tracked.has(tracked.id));
    this.#deps.publish(this.snapshot());
  }

  /** The listing, or null when it could not be read. A failed listing skips the whole check. */
  async #list(): Promise<{
    command: OmpRunnerCommand;
    browsers: HeadlessBrowserCandidate[];
  } | null> {
    try {
      const command = this.#deps.resolveCommand();
      const outcome = await this.#deps.runOmp(command, ['ps', '--all', '--json']);
      if (outcome.timedOut) throw new Error('omp ps --all --json timed out');
      if (outcome.exitCode !== 0) {
        throw new Error(`omp ps --all --json exited with ${outcome.exitCode ?? 'no exit code'}`);
      }
      const json: unknown = JSON.parse(outcome.stdout.replace(/^\uFEFF/, ''));
      const browsers = parseHeadlessBrowsers(json);
      this.#warned.delete('list');
      return { command, browsers };
    } catch (error) {
      this.#warnOnce('list', `Browser reaper skipped this check: ${describeError(error)}`);
      return null;
    }
  }

  /**
   * A tracked browser the listing no longer shows as the same ready daemon is
   * settled. If a reap was pending, the stop worked and it counts now.
   */
  #settleGone(listed: readonly HeadlessBrowserCandidate[]): void {
    const current = new Map(listed.map((browser) => [browser.id, browser] as const));
    for (const [id, tracked] of this.#tracked) {
      const now = current.get(id);
      if (now !== undefined && now.pid === tracked.pid) continue;
      if (tracked.pending !== null) {
        this.#reapedCount += 1;
        this.#freedBytes += tracked.pending.rssBytes;
        this.#deps.log(
          `Stopped idle omp headless browser for ${tracked.projectDir}: up ${Math.round(tracked.pending.uptimeMs / MS_PER_MINUTE)} min, freed about ${roundMb(tracked.pending.rssBytes)} MB.`,
        );
      }
      this.#tracked.delete(id);
    }
  }

  /** Counts pages on each browser. A browser that cannot be counted breaks its zero-page run. */
  async #probe(
    listed: readonly HeadlessBrowserCandidate[],
    now: number,
  ): Promise<TrackedBrowser[]> {
    const visible: TrackedBrowser[] = [];
    for (const browser of listed) {
      const pages = await this.#countPages(browser.id, browser.projectDir, browser.readyMatch);
      if (pages === null) {
        this.#breakRun(browser.id);
        continue;
      }

      let tracked = this.#tracked.get(browser.id);
      if (tracked === undefined) {
        tracked = {
          id: browser.id,
          pid: browser.pid,
          projectDir: browser.projectDir,
          startedAt: browser.startedAt,
          pages: 0,
          zeroSince: null,
          pending: null,
        };
        this.#tracked.set(browser.id, tracked);
      }
      tracked.pages = pages;
      if (pages > 0) {
        tracked.zeroSince = null;
        tracked.pending = null;
      } else {
        tracked.zeroSince ??= now;
      }
      visible.push(tracked);
    }
    return visible;
  }

  /** Pages open on a browser's loopback DevTools endpoint; null when they cannot be counted. */
  async #countPages(id: string, projectDir: string, readyMatch: string): Promise<number | null> {
    const port = devToolsPort(readyMatch);
    if (port === null) {
      this.#warnOnce(
        `endpoint:${id}`,
        `Browser reaper refused ${projectDir}: its DevTools endpoint is not ${LOOPBACK_HOST}.`,
      );
      return null;
    }
    try {
      const body = await this.#deps.fetchJson(`http://${LOOPBACK_HOST}:${port}/json/list`);
      const pages = countPageTargets(body);
      this.#warned.delete('devtools');
      return pages;
    } catch (error) {
      this.#warnOnce(
        'devtools',
        `Browser reaper could not count pages for ${projectDir}: ${describeError(error)}`,
      );
      return null;
    }
  }

  #breakRun(id: string): void {
    const tracked = this.#tracked.get(id);
    if (tracked === undefined) return;
    tracked.zeroSince = null;
    tracked.pending = null;
  }

  /**
   * One stop of a due browser. The first call measures the tree and sends the
   * stop. Each later check that still sees the daemon sends one more stop, and
   * after {@link BROWSER_REAPER_MAX_STOP_ATTEMPTS} the reap is abandoned and its
   * grace period starts over.
   */
  async #reap(tracked: TrackedBrowser, command: OmpRunnerCommand): Promise<void> {
    if (tracked.pending === null) {
      const rssBytes = await this.#deps.treeMemoryBytes(tracked.pid);
      tracked.pending = {
        rssBytes,
        uptimeMs: Math.max(0, this.#deps.now() - tracked.startedAt),
        attempts: 0,
      };
    }
    const pending = tracked.pending;
    if (pending.attempts >= BROWSER_REAPER_MAX_STOP_ATTEMPTS) {
      this.#deps.warn(
        `Browser reaper could not stop ${tracked.projectDir} after ${pending.attempts} attempts; its grace period starts again.`,
      );
      tracked.pending = null;
      tracked.zeroSince = this.#deps.now();
      return;
    }
    pending.attempts += 1;
    await this.#stopDaemon(command, tracked);
  }

  /**
   * One `omp ps stop`, with one more request when omp reports a timeout. Each
   * request is preceded by a fresh re-read of the daemon (`#stillIdle`), so a page
   * or a replaced daemon ends the reap before omp is asked.
   *
   * Residual window: a page can still open, or the daemon be replaced, between the
   * last re-read and omp acting on the stop. That is a few milliseconds. A run that
   * lands in it fails once while omp relaunches the browser on its next use.
   */
  async #stopDaemon(command: OmpRunnerCommand, tracked: TrackedBrowser): Promise<void> {
    const { projectDir } = tracked;
    const argv = [
      'ps',
      'stop',
      BROWSER_REAPER_DAEMON_NAME,
      '--dir',
      ompDirArgument(projectDir),
      '--timeout',
      String(BROWSER_REAPER_STOP_TIMEOUT_SECONDS),
    ];
    try {
      if (!(await this.#stillIdle(command, tracked))) return;
      let outcome = await this.#deps.runOmp(command, argv, ompDirArgument(projectDir));
      if (outcome.exitCode === 0 && !isStopTimedOut(outcome)) return;
      if (isStopTimedOut(outcome)) {
        // omp reports a timeout when the daemon is already on its way down. One more
        // request settles it; the next listing confirms whether the daemon is gone.
        if (!(await this.#stillIdle(command, tracked))) return;
        outcome = await this.#deps.runOmp(command, argv, ompDirArgument(projectDir));
        if (outcome.exitCode === 0 && !isStopTimedOut(outcome)) return;
      }
      this.#warnOnce(
        'stop',
        `omp did not confirm the stop of ${projectDir} (exit ${outcome.exitCode ?? 'none'}); the next listing decides.`,
      );
    } catch (error) {
      this.#warnOnce('stop', `omp could not stop ${projectDir}: ${describeError(error)}`);
    }
  }

  /**
   * The last look before an `omp ps stop`. The daemon must still be the tracked one
   * (same id, pid and startedAt), be ready, and hold zero pages. A page resets the
   * browser's zero-page run. A replaced daemon is forgotten, so its replacement starts
   * its own grace period. A daemon that is no longer ready, or a re-read that fails,
   * skips this stop and leaves tracking to the next listing.
   */
  async #stillIdle(command: OmpRunnerCommand, tracked: TrackedBrowser): Promise<boolean> {
    const current = await this.#readDaemon(command, tracked.projectDir);
    if (current === null) return false;
    const replaced =
      current.id !== tracked.id ||
      current.startedAt !== tracked.startedAt ||
      (current.state === 'ready' && current.pid !== tracked.pid);
    if (replaced) {
      this.#tracked.delete(tracked.id);
      return false;
    }
    if (current.state !== 'ready') return false;
    const pages = await this.#countPages(tracked.id, tracked.projectDir, current.readyMatch);
    if (pages === null) return false;
    tracked.pages = pages;
    if (pages > 0) {
      this.#breakRun(tracked.id);
      return false;
    }
    return true;
  }

  /**
   * The daemon `omp ps info` describes now, or null when omp cannot say. A daemon that
   * is gone is ordinary once a stop has worked, so a non-zero exit is not warned about.
   */
  async #readDaemon(command: OmpRunnerCommand, projectDir: string): Promise<DaemonInfo | null> {
    try {
      const outcome = await this.#deps.runOmp(
        command,
        ['ps', 'info', BROWSER_REAPER_DAEMON_NAME, '--dir', ompDirArgument(projectDir), '--json'],
        ompDirArgument(projectDir),
      );
      if (outcome.timedOut || outcome.exitCode !== 0) return null;
      const daemon = parseDaemonInfo(JSON.parse(outcome.stdout.replace(/^\uFEFF/, '')));
      this.#warned.delete('guard');
      return daemon;
    } catch (error) {
      this.#warnOnce(
        'guard',
        `Browser reaper could not re-read ${projectDir} before a stop: ${describeError(error)}`,
      );
      return null;
    }
  }

  #warnOnce(key: string, message: string): void {
    if (this.#warned.has(key)) return;
    this.#warned.add(key);
    this.#deps.warn(message);
  }
}

function roundMb(bytes: number): number {
  return Math.round((bytes / BYTES_PER_MB) * 10) / 10;
}

/** Parses the `omp ps info` reply. Throws when it does not describe one daemon. */
function parseDaemonInfo(value: unknown): DaemonInfo {
  const fields: Record<string, unknown> = isRecord(value) ? value : {};
  const { id, pid, startedAt, state, readyMatch } = fields;
  if (
    typeof id !== 'string' ||
    typeof startedAt !== 'number' ||
    typeof state !== 'string' ||
    typeof readyMatch !== 'string'
  ) {
    throw new TypeError('omp ps info did not describe a daemon');
  }
  return { id, pid: typeof pid === 'number' ? pid : null, startedAt, state, readyMatch };
}

/**
 * The `--dir` operand for a project. omp lists a drive-root project as `D:`, but a bare
 * `X:` on Windows means "the current directory on drive X" of the child process, which
 * is not the drive root when the board runs elsewhere, so it is passed as `X:\`.
 */
export function ompDirArgument(projectDir: string): string {
  return /^[A-Za-z]:$/.test(projectDir) ? `${projectDir}\\` : projectDir;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

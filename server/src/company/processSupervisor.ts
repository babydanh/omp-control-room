/**
 * processSupervisor: lineage-checked ownership of child processes, and the
 * lifecycle safety that has to happen around them.
 *
 * A PID is not an identity. The OS reuses PIDs, so "kill 1234" issued after a
 * crash can land on a stranger's process -- including one running the very same
 * image, which is exactly what an OMP node process looks like. Every kill is
 * therefore gated on evidence rather than on a remembered number: the OS must
 * still report the process start time we recorded when we launched it, and the
 * image must still match. The outcomes are deliberately small:
 *
 *   owned      - proven ours; the only state in which anything is allowed
 *   gone       - already exited; nothing to do, nothing killed
 *   conflict   - proven NOT ours (recycled PID or a foreign process)
 *   unproven   - the platform would not tell us; refuse and block
 *
 * "I cannot prove this is mine" is the answer the plan requires, because the
 * alternative -- a best-guess kill -- takes down whatever the recycled PID
 * happens to be. A persisted PID with no start time is the case that matters
 * most, which is why reconciliation blocks it instead of cleaning it up.
 *
 * The lifecycle operations are ordered so a crash can never become a silent
 * retry. Pause aborts and waits for quiescence without killing anything; a
 * restart persists, closes the PTY and only then terminates the tree, bumping
 * the run epoch so every approval, answer and terminal lease from the previous
 * generation is invalid by construction; shutdown stops the bridge first under a
 * bounded deadline and only falls back to a forced owned-tree kill. The
 * supervisor never spawns anything, so a killed run stays killed until the
 * coordinator starts a new generation.
 */

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { CompanyError } from './companyError.js';

/** Cooperative bridge shutdown budget before a forced owned-tree kill. */
export const PROCESS_SUPERVISOR_SHUTDOWN_GRACE_MS = 5_000;
/** SIGTERM -> SIGKILL escalation window for a verified-owned tree. */
export const PROCESS_SUPERVISOR_TERMINATE_GRACE_MS = 1_500;
/** How long a pause waits for native tools and children to go quiet. */
export const PROCESS_SUPERVISOR_QUIESCE_TIMEOUT_MS = 30_000;
/** Poll interval for every wait loop in this module. */
export const PROCESS_SUPERVISOR_POLL_MS = 50;
/**
 * Slack when comparing start times from a coarse probe (no `/proc`, no CIM).
 * Exact sources return identical values, so this only absorbs the one-second
 * resolution of an elapsed-time reading.
 */
export const PROCESS_SUPERVISOR_START_TIME_TOLERANCE_MS = 2_000;
/** Every external command this module issues is bounded; a wedged tool must not wedge us. */
export const PROCESS_SUPERVISOR_COMMAND_TIMEOUT_MS = 10_000;

/**
 * Deferred without `Promise.withResolvers`, which this project's ES2022 lib
 * does not declare. The promise settles on a real event or a real deadline.
 */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
} {
  let resolve = (_value: T): void => undefined;
  let reject = (_error: Error): void => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ── Process identity ──────────────────────────────────────────────────────

export interface ProcessIdentity {
  readonly pid: number;
  readonly imageName: string;
  /** Process start time in ms since epoch, when the platform reports one. */
  readonly startTime: number | null;
  /** POSIX process-group id, or null when unknown/irrelevant. */
  readonly processGroupId: number | null;
}

export type ProcessProbeResult =
  | { readonly kind: 'running'; readonly identity: ProcessIdentity }
  | { readonly kind: 'absent' }
  | { readonly kind: 'unknown'; readonly reason: string };

export type ProcessProbe = (pid: number) => Promise<ProcessProbeResult>;

export interface CommandResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

export type CommandRunner = (
  file: string,
  args: readonly string[],
  timeoutMs: number,
) => Promise<CommandResult>;

/** How a process is signalled; a group signal uses a negative target id. */
export type ProcessSignaller = (target: number, signal: 'SIGTERM' | 'SIGKILL') => void;

export interface ProcessSupervisorOptions {
  readonly probe?: ProcessProbe;
  readonly exec?: CommandRunner;
  readonly signal?: ProcessSignaller;
  readonly role?: OwnershipRole;
  /** Overridable so tests need not wait real seconds. */
  readonly shutdownGraceMs?: number;
  readonly terminateGraceMs?: number;
  readonly quiesceTimeoutMs?: number;
}

const defaultCommandRunner: CommandRunner = (file, args, timeoutMs) =>
  new Promise((resolve) => {
    execFile(
      file,
      [...args],
      { windowsHide: true, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        resolve({
          ok: !err,
          stdout: typeof stdout === 'string' ? stdout : '',
          stderr: typeof stderr === 'string' ? stderr : '',
        });
      },
    );
  });

/**
 * Windows identity in one PowerShell round trip.
 *
 * `Get-Process` is used deliberately instead of `Get-CimInstance`: CIM needs
 * WMI, which is unavailable or policy-blocked on plenty of machines, and a
 * failure there silently degraded every kill to `unproven`. `ProcessName` is
 * readable without elevation and, with the `.exe` suffix Windows always
 * appends, matches the basename of the executable we launched.
 *
 * The output is prefixed lines rather than one JSON blob: a warning, a
 * progress record or a stray banner on stdout must not be able to turn a
 * readable answer into an unparsable one. An unreadable start time is
 * reported as such, which keeps the verdict at `unproven` rather than
 * inventing a match.
 */
async function probeWindows(pid: number, exec: CommandRunner): Promise<ProcessProbeResult> {
  const script = [
    `$ErrorActionPreference = 'SilentlyContinue'`,
    `$p = Get-Process -Id ${pid}`,
    `if ($null -eq $p) { Write-Output 'ABSENT' } else {`,
    `  Write-Output ('NAME=' + $p.ProcessName + '.exe')`,
    `  try { Write-Output ('START=' + $p.StartTime.ToUniversalTime().ToString('o')) } catch { Write-Output 'START=' }`,
    `}`,
  ].join('; ');
  const result = await exec(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    PROCESS_SUPERVISOR_COMMAND_TIMEOUT_MS,
  );
  if (!result.ok) return { kind: 'unknown', reason: 'powershell probe failed' };

  let absent = false;
  let imageName: string | null = null;
  let startTime: number | null = null;
  for (const line of result.stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === 'ABSENT') {
      absent = true;
    } else if (trimmed.startsWith('NAME=')) {
      imageName = trimmed.slice('NAME='.length).trim() || null;
    } else if (trimmed.startsWith('START=')) {
      const parsed = Date.parse(trimmed.slice('START='.length).trim());
      if (Number.isFinite(parsed)) startTime = parsed;
    }
  }
  if (absent) return { kind: 'absent' };
  if (imageName === null) return { kind: 'unknown', reason: 'process probe reported no image' };
  return { kind: 'running', identity: { pid, imageName, startTime, processGroupId: null } };
}

/**
 * Linux: `/proc/<pid>/stat` is exact for both the start ticks and the process
 * group. Returns null when `/proc` is unavailable, letting the caller fall back.
 */
async function probeLinux(pid: number): Promise<ProcessProbeResult | null> {
  let stat: string;
  try {
    stat = await fs.promises.readFile(`/proc/${pid}/stat`, 'utf-8');
  } catch {
    return null;
  }
  // The comm field is parenthesised and may contain spaces and parentheses, so
  // everything is parsed relative to the LAST ')'.
  const close = stat.lastIndexOf(')');
  if (close === -1) return { kind: 'unknown', reason: 'unparsable /proc stat' };
  const comm = stat.slice(stat.indexOf('(') + 1, close);
  const fields = stat.slice(close + 2).split(' ');
  const processGroupId = Number(fields[2]);
  const startTicks = Number(fields[19]);
  let imageName = comm;
  try {
    imageName = path.basename(await fs.promises.readlink(`/proc/${pid}/exe`));
  } catch {
    // A deleted executable leaves no link; comm is still a real image name.
  }
  let bootTimeSeconds = Number.NaN;
  try {
    const match = /^btime\s+(\d+)$/m.exec(await fs.promises.readFile('/proc/stat', 'utf-8'));
    if (match) bootTimeSeconds = Number(match[1]);
  } catch {
    // Without boot time the raw ticks are still comparable between two probes.
  }
  return {
    kind: 'running',
    identity: {
      pid,
      imageName,
      startTime:
        Number.isFinite(startTicks) && Number.isFinite(bootTimeSeconds)
          ? bootTimeSeconds * 1000 + startTicks * (1000 / 100)
          : null,
      processGroupId: Number.isInteger(processGroupId) ? processGroupId : null,
    },
  };
}

/**
 * Fallback for macOS and any platform without `/proc`: `ps` reports the image
 * and an elapsed time, so the start time is derived at one-second resolution.
 * Coarse, but still enough to tell a live process from a recycled PID.
 */
async function probeElapsed(pid: number, exec: CommandRunner): Promise<ProcessProbeResult> {
  const result = await exec(
    'ps',
    ['-o', 'comm=,etime=', '-p', String(pid)],
    PROCESS_SUPERVISOR_COMMAND_TIMEOUT_MS,
  );
  if (!result.ok) return { kind: 'unknown', reason: 'ps probe failed' };
  const text = result.stdout.trim();
  if (text === '') return { kind: 'absent' };
  const match = /^(.+?)\s+((?:(\d+)-)?(?:(\d+):)?(\d+):(\d+))$/.exec(text);
  if (match === null) return { kind: 'unknown', reason: 'unparsable ps output' };
  // Group 1 is the image, group 2 the whole elapsed field, 3..6 its parts.
  const [, image, , days, hours, minutes, seconds] = match;
  const elapsed =
    Number(days ?? 0) * 86_400 +
    Number(hours ?? 0) * 3_600 +
    Number(minutes) * 60 +
    Number(seconds);
  return {
    kind: 'running',
    identity: {
      pid,
      imageName: image.trim(),
      startTime: Date.now() - elapsed * 1000,
      processGroupId: null,
    },
  };
}

export function createDefaultProbe(exec: CommandRunner = defaultCommandRunner): ProcessProbe {
  return async (pid: number) => {
    if (!Number.isInteger(pid) || pid <= 0) return { kind: 'absent' };
    if (process.platform === 'win32') return probeWindows(pid, exec);
    const linux = await probeLinux(pid);
    if (linux !== null) return linux;
    return probeElapsed(pid, exec);
  };
}

// ── Tracked processes ─────────────────────────────────────────────────────

export interface OwnedProcessRef {
  readonly pid: number;
  /** Executable image the child was started as, without directories. */
  readonly imageName: string;
  /** Random per-run nonce, recorded for diagnostics and lineage. */
  readonly nonce: string;
  readonly spawnedAt: number;
  /** OS start time recorded at track time; null when it was never obtained. */
  readonly startTime: number | null;
  /** POSIX process-group id, recorded when the platform reports one. */
  readonly processGroupId: number | null;
}

export type OwnershipVerdict = 'owned' | 'terminated' | 'gone' | 'conflict' | 'unproven';

export type OwnershipRole = 'owner' | 'follower';

// ── Supervised runs ───────────────────────────────────────────────────────

export type SupervisedRunState =
  'starting' | 'running' | 'pausing' | 'paused' | 'stopping' | 'stopped' | 'crashed' | 'blocked';

export interface BlockedReason {
  readonly code: string;
  readonly message: string;
}

export interface SupervisedRunRecord {
  readonly runId: string;
  readonly sessionId: string;
  readonly runEpoch: number;
  readonly state: SupervisedRunState;
  readonly pid: number | null;
  readonly imageName: string | null;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly blockedReason: BlockedReason | null;
  readonly interrupted: boolean;
  readonly interruptionReason: string | null;
}

/**
 * The native side of one run, as the supervisor needs it. The coordinator
 * wires these to the OMP runner and PTY bridge; the supervisor never touches
 * either directly, so it cannot grow a second engine.
 */
export interface SupervisedRunPorts {
  /** Flush the run snapshot; a restart may not proceed before this resolves. */
  persist?(run: SupervisedRunRecord): Promise<void>;
  /** Bounded bridge shutdown; resolution means the native side is down. */
  shutdownBridge(runEpoch: number): Promise<void>;
  /** Cooperative abort of the active native generation. */
  abort(runEpoch: number): Promise<void>;
  /** Release the run's PTY. */
  closePty(runEpoch: number): Promise<void>;
  /** True only when no tool, child, or queued request is still running. */
  isQuiescent(runEpoch: number): Promise<boolean>;
}

export interface RegisterRunInput {
  readonly runId: string;
  readonly sessionId: string;
  readonly runEpoch: number;
  readonly pid: number;
  readonly imageName: string;
  /** Known start time, when the spawn site already read one. */
  readonly startTime?: number | null;
  readonly ports?: SupervisedRunPorts;
}

export interface PersistedRunRecord {
  readonly runId: string;
  readonly sessionId: string;
  readonly runEpoch: number;
  readonly pid: number | null;
  readonly imageName: string | null;
  readonly startTime: number | null;
  readonly state?: SupervisedRunState;
}

export interface ShutdownBlocked {
  readonly runId: string;
  readonly code: string;
  readonly message: string;
}

export interface ShutdownReport {
  readonly role: OwnershipRole;
  readonly runsInspected: number;
  readonly terminated: readonly string[];
  readonly blocked: readonly ShutdownBlocked[];
  readonly skipped: readonly string[];
  readonly handlesReleased: number;
}

export interface ReconcileReport {
  readonly crashed: readonly string[];
  readonly blocked: readonly ShutdownBlocked[];
  readonly owned: readonly string[];
  readonly interrupted: readonly string[];
}

export interface SupervisorResources {
  readonly trackedProcesses: number;
  readonly runs: number;
  readonly exitWaiters: number;
  readonly pendingCaptures: number;
}

interface RunEntry {
  readonly runId: string;
  readonly sessionId: string;
  pid: number | null;
  imageName: string | null;
  runEpoch: number;
  state: SupervisedRunState;
  readonly startedAt: string;
  updatedAt: string;
  blockedReason: BlockedReason | null;
  interrupted: boolean;
  interruptionReason: string | null;
  readonly ports: SupervisedRunPorts;
  exited: boolean;
  /** Bumped whenever an operation supersedes an earlier one's background waits. */
  token: number;
  readonly waiters: Set<(exited: boolean) => void>;
}

const NOOP_PORTS: SupervisedRunPorts = {
  shutdownBridge: async () => undefined,
  abort: async () => undefined,
  closePty: async () => undefined,
  isQuiescent: async () => true,
};

function snapshot(entry: RunEntry): SupervisedRunRecord {
  return Object.freeze({
    runId: entry.runId,
    sessionId: entry.sessionId,
    runEpoch: entry.runEpoch,
    state: entry.state,
    pid: entry.pid,
    imageName: entry.imageName,
    startedAt: entry.startedAt,
    updatedAt: entry.updatedAt,
    blockedReason: entry.blockedReason,
    interrupted: entry.interrupted,
    interruptionReason: entry.interruptionReason,
  });
}

/** Normalised image comparison: basenames, case-insensitive (Windows volumes). */
function sameImage(left: string, right: string): boolean {
  return path.basename(left).toLowerCase() === path.basename(right).toLowerCase();
}

function sameStartTime(left: number, right: number): boolean {
  return Math.abs(left - right) <= PROCESS_SUPERVISOR_START_TIME_TOLERANCE_MS;
}

/**
 * This process' own POSIX process group. It is never a legitimate kill target:
 * signalling our own group would take down the extension or the CLI itself.
 */
function ownProcessGroupId(): number | null {
  if (process.platform === 'win32') return null;
  try {
    const stat = fs.readFileSync('/proc/self/stat', 'utf-8');
    const close = stat.lastIndexOf(')');
    if (close === -1) return null;
    const group = Number(stat.slice(close + 2).split(' ')[2]);
    return Number.isInteger(group) ? group : null;
  } catch {
    return null;
  }
}

/**
 * The only place in the company subsystem allowed to signal or kill a process.
 */
export class ProcessSupervisor {
  private readonly tracked = new Map<number, OwnedProcessRef>();
  private readonly captures = new Map<number, Promise<void>>();
  private readonly runs = new Map<string, RunEntry>();
  private readonly probe: ProcessProbe;
  private readonly exec: CommandRunner;
  private readonly signalProcess: ProcessSignaller;
  private readonly shutdownGraceMs: number;
  private readonly terminateGraceMs: number;
  private readonly quiesceTimeoutMs: number;
  private role: OwnershipRole;
  private disposePromise: Promise<ShutdownReport> | null = null;

  constructor(options: ProcessSupervisorOptions = {}) {
    this.exec = options.exec ?? defaultCommandRunner;
    this.probe = options.probe ?? createDefaultProbe(this.exec);
    this.signalProcess =
      options.signal ??
      ((target, signal) => {
        process.kill(target, signal);
      });
    this.role = options.role ?? 'owner';
    this.shutdownGraceMs = options.shutdownGraceMs ?? PROCESS_SUPERVISOR_SHUTDOWN_GRACE_MS;
    this.terminateGraceMs = options.terminateGraceMs ?? PROCESS_SUPERVISOR_TERMINATE_GRACE_MS;
    this.quiesceTimeoutMs = options.quiesceTimeoutMs ?? PROCESS_SUPERVISOR_QUIESCE_TIMEOUT_MS;
  }

  // ── Ownership ───────────────────────────────────────────────────────────

  get trackedCount(): number {
    return this.tracked.size;
  }

  get trackedPids(): readonly number[] {
    return [...this.tracked.keys()];
  }

  /**
   * Record a child we launched. Synchronous for callers holding a spawn
   * handle, but lineage is captured asynchronously: `verify` and
   * `terminateTree` await that capture before deciding anything, so a caller
   * that never awaits `track` still cannot reach a kill without an
   * OS-reported start time.
   */
  track(pid: number, imageName: string, startTime: number | null = null): OwnedProcessRef {
    const ref: OwnedProcessRef = {
      pid,
      imageName: path.basename(imageName),
      nonce: randomUUID(),
      spawnedAt: Date.now(),
      startTime,
      processGroupId: null,
    };
    this.tracked.set(pid, ref);
    this.captures.set(pid, this.captureLineage(pid));
    return ref;
  }

  /**
   * Track a process with its lineage read before the call returns. Production
   * code that can await one probe should prefer this over `track`.
   */
  async captureProcess(input: {
    pid: number;
    imageName: string;
    nonce?: string;
  }): Promise<OwnedProcessRef> {
    const existing = this.tracked.get(input.pid);
    const result = await this.probe(input.pid);
    const ref: OwnedProcessRef = {
      pid: input.pid,
      imageName: path.basename(input.imageName),
      nonce: input.nonce ?? existing?.nonce ?? randomUUID(),
      spawnedAt: existing?.spawnedAt ?? Date.now(),
      startTime: result.kind === 'running' ? result.identity.startTime : null,
      processGroupId: result.kind === 'running' ? result.identity.processGroupId : null,
    };
    this.captures.delete(input.pid);
    this.tracked.set(input.pid, ref);
    return ref;
  }

  /**
   * Stop tracking a PID WITHOUT killing it. This is the spawn-failure and
   * command-timeout path: the process is already gone, or was never ours to
   * signal. Returns whether anything was actually being tracked.
   */
  release(pid: number): boolean {
    this.captures.delete(pid);
    for (const entry of this.runs.values()) {
      if (entry.pid === pid) entry.token += 1;
    }
    return this.tracked.delete(pid);
  }

  /** Whether the supervisor can prove the live PID is still the process it started. */
  async verify(ref: OwnedProcessRef): Promise<OwnershipVerdict> {
    if (!Number.isInteger(ref.pid) || ref.pid <= 0) return 'gone';
    await this.settleCapture(ref.pid);
    const result = await this.probe(ref.pid);
    if (result.kind === 'absent') return 'gone';
    if (result.kind === 'unknown') return 'unproven';

    // `track` hands the caller a snapshot before lineage is read, so the
    // recorded entry is the authority on what was captured — it is the one
    // holding the ORIGINAL start time, which is what makes a recycled PID
    // detectable at all. A ref the supervisor no longer tracks is judged on
    // its own fields, never on a fresh reading.
    const tracked = this.tracked.get(ref.pid) ?? ref;
    const identity = result.identity;
    if (tracked.startTime !== null && identity.startTime !== null) {
      if (!sameStartTime(tracked.startTime, identity.startTime)) return 'conflict';
      return sameImage(tracked.imageName, identity.imageName) ? 'owned' : 'conflict';
    }
    // Without a start time on both sides, a recycled PID running the same image
    // is indistinguishable from ours. That is a refusal, not a yes.
    return sameImage(tracked.imageName, identity.imageName) ? 'unproven' : 'conflict';
  }

  /**
   * Terminate a verified-owned process tree. A `conflict` or `unproven`
   * verdict is returned unchanged and nothing is signalled -- the tree is left
   * alone, which is the entire point of this module.
   */
  async terminateTree(ref: OwnedProcessRef): Promise<OwnershipVerdict> {
    // A follower owns no processes; the runs it would kill belong to the owner.
    if (this.role === 'follower') return 'unproven';
    const verdict = await this.verify(ref);
    if (verdict !== 'owned') {
      if (verdict === 'gone') this.tracked.delete(ref.pid);
      return verdict;
    }
    await this.signalTree(ref);
    this.tracked.delete(ref.pid);
    return 'terminated';
  }

  /**
   * Terminate everything this supervisor owns. Used on shutdown and after a
   * crash takeover; a follower never calls it.
   */
  async disposeAll(): Promise<OwnershipVerdict[]> {
    const results: OwnershipVerdict[] = [];
    for (const ref of [...this.tracked.values()]) {
      results.push(await this.terminateTree(ref));
    }
    this.tracked.clear();
    this.captures.clear();
    return results;
  }

  // ── Run lifecycle ───────────────────────────────────────────────────────

  get runCount(): number {
    return this.runs.size;
  }

  registerRun(input: RegisterRunInput): SupervisedRunRecord {
    if (this.runs.has(input.runId)) {
      throw new CompanyError(
        'company_run_already_registered',
        `Run ${input.runId} is already supervised`,
      );
    }
    const now = new Date().toISOString();
    const entry: RunEntry = {
      runId: input.runId,
      sessionId: input.sessionId,
      pid: input.pid,
      imageName: path.basename(input.imageName),
      runEpoch: input.runEpoch,
      state: 'starting',
      startedAt: now,
      updatedAt: now,
      blockedReason: null,
      interrupted: false,
      interruptionReason: null,
      ports: input.ports ?? NOOP_PORTS,
      exited: false,
      token: 0,
      waiters: new Set(),
    };
    this.runs.set(input.runId, entry);
    this.track(input.pid, input.imageName, input.startTime ?? null);
    return snapshot(entry);
  }

  getRun(runId: string): SupervisedRunRecord | undefined {
    const entry = this.runs.get(runId);
    return entry === undefined ? undefined : snapshot(entry);
  }

  /**
   * Prove that a supervised run's process is still the one we started, without
   * touching it: no signal, no close, no state change.
   *
   * This is the preflight a durable mutation must run BEFORE it invalidates
   * anything (before the epoch is bumped, before a question is closed), so a
   * recycled PID is discovered while the previous generation is still intact
   * and the caller can refuse instead of corrupting a run it no longer owns.
   *
   * It deliberately uses the ORIGINAL tracked ref. Re-reading the PID now
   * would report whatever process holds it today, which is exactly the
   * identity in question -- a fresh capture here would certify the stranger.
   *
   * `unproven` means the OS would not answer, or the run has no tracked
   * process at all; both are refusals, never a permissive "probably fine".
   */
  async verifyRunOwnership(runId: string, runEpoch: number): Promise<OwnershipVerdict> {
    const entry = this.runs.get(runId);
    if (entry === undefined) {
      throw new CompanyError('company_run_not_found', `Unknown company run: ${runId}`);
    }
    if (entry.runEpoch !== runEpoch) {
      throw new CompanyError(
        'stale_run_epoch',
        `Run ${runId} is at epoch ${entry.runEpoch}, not ${runEpoch}.`,
      );
    }
    if (entry.pid === null) return 'unproven';
    const ref = this.tracked.get(entry.pid);
    if (ref === undefined) return 'unproven';
    return this.verify(ref);
  }

  /**
   * Cooperative pause. New work stops, the active native generation is
   * aborted, and the run waits for real quiescence. NOTHING is killed: a pause
   * is not a rollback, edits already written stay written, and a session that
   * refuses to go quiet becomes `blocked` while its process keeps running.
   */
  async pause(
    runId: string,
    runEpoch: number,
    options: { quiesceTimeoutMs?: number } = {},
  ): Promise<SupervisedRunRecord> {
    const entry = this.assertEpoch(runId, runEpoch);
    this.transition(entry, 'pausing');
    const token = (entry.token += 1);
    try {
      await entry.ports.abort(entry.runEpoch);
    } catch (err) {
      this.block(entry, 'abort_failed', `Pause could not abort the run: ${errorMessage(err)}`);
      throw new CompanyError('company_pause_failed', `Pause could not abort run ${runId}`, {
        cause: err instanceof Error ? err : undefined,
      });
    }
    const quiet = await this.waitForQuiescence(
      entry,
      options.quiesceTimeoutMs ?? this.quiesceTimeoutMs,
      token,
    );
    if (!quiet) {
      this.block(
        entry,
        'quiesce_timeout',
        'The run did not reach quiescence before the pause deadline; nothing was killed.',
      );
      return snapshot(entry);
    }
    this.transition(entry, 'paused');
    return snapshot(entry);
  }

  /**
   * Continue a paused run. The epoch advances, so approvals and answers issued
   * against the previous generation cannot be replayed. With no verified
   * process left the run returns to `starting` and the coordinator must
   * relaunch it explicitly -- this module never spawns.
   */
  async resume(runId: string, runEpoch: number): Promise<SupervisedRunRecord> {
    const entry = this.assertEpoch(runId, runEpoch);
    const ref = entry.pid === null ? null : (this.tracked.get(entry.pid) ?? null);
    if (ref !== null && (await this.verify(ref)) !== 'owned') {
      this.block(
        entry,
        'ownership_unproven',
        "The paused run's process could not be proven owned; a relaunch is required.",
      );
      return snapshot(entry);
    }
    entry.runEpoch += 1;
    this.transition(entry, ref === null ? 'starting' : 'running');
    return snapshot(entry);
  }

  /**
   * Restart one generation. The order IS the safety property: quiesce, persist,
   * close the PTY, and only then terminate the verified-owned tree and advance
   * the epoch. A failure before the epoch bump leaves the run crashed or
   * blocked on the old epoch -- never a silent fresh context.
   */
  async restart(
    runId: string,
    runEpoch: number,
    options: { quiesceTimeoutMs?: number } = {},
  ): Promise<SupervisedRunRecord> {
    const entry = this.assertEpoch(runId, runEpoch);
    this.transition(entry, 'stopping');
    const token = (entry.token += 1);

    try {
      await entry.ports.abort(entry.runEpoch);
      const quiet = await this.waitForQuiescence(
        entry,
        options.quiesceTimeoutMs ?? this.quiesceTimeoutMs,
        token,
      );
      if (!quiet) {
        this.block(
          entry,
          'quiesce_timeout',
          'The run stayed busy; the restart was abandoned before anything was closed.',
        );
        return snapshot(entry);
      }
      await this.persist(entry);
    } catch (err) {
      this.block(
        entry,
        'restart_failed',
        `Restart aborted before the epoch bump: ${errorMessage(err)}`,
      );
      return snapshot(entry);
    }

    return this.finishRun(entry, 'restart');
  }

  /**
   * Kill now: terminate the tracked, lineage-verified tree, mark the attempt
   * interrupted, advance the epoch. No file rollback and no retry -- a killed
   * run stays killed until a caller explicitly starts a new generation.
   */
  async kill(runId: string, runEpoch: number): Promise<SupervisedRunRecord> {
    const entry = this.assertEpoch(runId, runEpoch);
    this.transition(entry, 'stopping');
    entry.token += 1;
    return this.finishRun(entry, 'killed');
  }

  /**
   * Called when the PTY or the runner reports an exit. Reaps the handle and
   * settles the exit waiters. An exit nobody asked for is an interruption --
   * a planned stop passes `expected` and is not counted as one, so a clean
   * finish never looks like a crash in the report.
   */
  notifyExit(
    runId: string,
    detail: { exitCode?: number; signal?: number; expected?: boolean } = {},
  ): SupervisedRunRecord | undefined {
    const entry = this.runs.get(runId);
    if (entry === undefined) return undefined;
    const reason =
      detail.signal !== undefined
        ? `signal ${detail.signal}`
        : `exit ${String(detail.exitCode ?? 'unknown')}`;
    this.releaseRun(entry, 'stopped', reason, detail.expected !== true);
    // The process is gone and the caller has been told: this run is finished,
    // so its record is released rather than kept as a handle nothing can act on.
    // `kill`/`restart` keep theirs, because those paths stay observable.
    this.runs.delete(runId);
    return snapshot(entry);
  }

  /**
   * Wait until the run's process is really gone, or false at the deadline.
   *
   * Two sources, because a caller must not have to know which will fire: a
   * PTY or runner reporting the exit (`notifyExit`), and the OS itself. The
   * poll matters for a process nobody reports on -- a verification command
   * that simply ends -- where waiting only for a notification would time out
   * on a process that is demonstrably dead.
   */
  async awaitExit(runId: string, timeoutMs: number): Promise<boolean> {
    const entry = this.runs.get(runId);
    if (entry === undefined || entry.exited) return true;
    const pid = entry.pid;
    const deadline = Date.now() + timeoutMs;
    const gate = deferred<boolean>();
    const timer = setTimeout(() => gate.resolve(false), timeoutMs);
    timer.unref();
    const waiter = gate.resolve;
    entry.waiters.add(waiter);
    let done = false;
    const watcher = (async () => {
      while (!done && Date.now() < deadline) {
        if (entry.exited) {
          gate.resolve(true);
          return;
        }
        if (pid !== null && (await this.probe(pid)).kind === 'absent') {
          gate.resolve(true);
          return;
        }
        await delay(PROCESS_SUPERVISOR_POLL_MS);
      }
    })();
    try {
      return await gate.promise;
    } finally {
      done = true;
      clearTimeout(timer);
      entry.waiters.delete(waiter);
      // The watcher owns no timer of its own; joining it guarantees no
      // background poll outlives this call.
      await watcher;
    }
  }

  /**
   * Startup reconciliation. A persisted PID is never acted on by itself:
   * without a recorded start time there is no evidence at all, so the run is
   * blocked for a human. A dead PID becomes `crashed`, and a proven-owned live
   * PID is only reported as eligible -- reconciliation itself never kills, and
   * never retries a side effect because an owner died.
   */
  async reconcile(records: readonly PersistedRunRecord[]): Promise<ReconcileReport> {
    const crashed: string[] = [];
    const owned: string[] = [];
    const interrupted: string[] = [];
    const blocked: ShutdownBlocked[] = [];

    for (const record of records) {
      const wasActive =
        record.state !== undefined && !['stopped', 'crashed'].includes(record.state);
      if (wasActive) interrupted.push(record.runId);
      if (record.pid === null) {
        crashed.push(record.runId);
        continue;
      }
      const probe = await this.probe(record.pid);
      if (probe.kind === 'absent') {
        crashed.push(record.runId);
        continue;
      }
      if (probe.kind === 'unknown') {
        blocked.push({
          runId: record.runId,
          code: 'ownership_unproven',
          message: `Could not read the identity of PID ${record.pid}; refusing to touch it.`,
        });
        continue;
      }
      const identity = probe.identity;
      // Both sides need a start time. Without the pair, a recycled PID running
      // the same image is indistinguishable from ours, so an unreadable or
      // unrecorded start time is a refusal -- never a comparison that quietly
      // treats "unknown" as "same".
      if (record.startTime === null || identity.startTime === null) {
        blocked.push({
          runId: record.runId,
          code: 'ownership_unproven',
          message:
            identity.startTime === null
              ? `The OS reported no start time for PID ${record.pid}; refusing to touch it.`
              : `PID ${record.pid} was persisted without a start time; a PID alone is not proof of ownership.`,
        });
        continue;
      }
      if (
        !sameStartTime(record.startTime, identity.startTime) ||
        !sameImage(record.imageName ?? '', identity.imageName)
      ) {
        blocked.push({
          runId: record.runId,
          code: 'ownership_conflict',
          message: `PID ${record.pid} now runs a different process (${identity.imageName}); it is not ours.`,
        });
        continue;
      }
      owned.push(record.runId);
      const now = new Date().toISOString();
      this.runs.set(record.runId, {
        runId: record.runId,
        sessionId: record.sessionId,
        pid: record.pid,
        imageName: identity.imageName,
        runEpoch: record.runEpoch,
        state: 'crashed',
        startedAt: now,
        updatedAt: now,
        blockedReason: null,
        interrupted: wasActive,
        interruptionReason: wasActive ? 'owner_lost' : null,
        ports: NOOP_PORTS,
        exited: false,
        token: 0,
        waiters: new Set(),
      });
      this.tracked.set(record.pid, {
        pid: record.pid,
        imageName: identity.imageName,
        nonce: randomUUID(),
        spawnedAt: Date.now(),
        startTime: record.startTime,
        processGroupId: identity.processGroupId,
      });
    }

    return { crashed, blocked, owned, interrupted };
  }

  /**
   * Bounded, ordered shutdown of every supervised run: bridge first, then the
   * PTY, then a forced owned-tree kill for whatever survived the grace period.
   * Idempotent: a second call resolves with the first report.
   */
  dispose(options: { shutdownGraceMs?: number } = {}): Promise<ShutdownReport> {
    this.disposePromise ??= this.runShutdown(options);
    return this.disposePromise;
  }

  /**
   * A follower owns no processes. Detaching releases every local handle and
   * never signals anything, because those runs belong to the owner.
   */
  async detachFollower(): Promise<ShutdownReport> {
    this.role = 'follower';
    const skipped = [...this.runs.keys()];
    const handlesReleased = this.clearAllTracking();
    return {
      role: 'follower',
      runsInspected: skipped.length,
      terminated: [],
      blocked: [],
      skipped,
      handlesReleased,
    };
  }

  /** Everything this module holds, so a caller can assert a clean baseline. */
  get resources(): SupervisorResources {
    let exitWaiters = 0;
    for (const entry of this.runs.values()) exitWaiters += entry.waiters.size;
    return {
      trackedProcesses: this.tracked.size,
      runs: this.runs.size,
      exitWaiters,
      pendingCaptures: this.captures.size,
    };
  }

  // ── Internals ───────────────────────────────────────────────────────────

  private async runShutdown(options: { shutdownGraceMs?: number }): Promise<ShutdownReport> {
    // A follower shutting down must never reach the owner's processes.
    if (this.role === 'follower') return this.detachFollower();

    const graceMs = options.shutdownGraceMs ?? this.shutdownGraceMs;
    const terminated: string[] = [];
    const blocked: ShutdownBlocked[] = [];
    const skipped: string[] = [];

    for (const entry of [...this.runs.values()]) {
      if (entry.exited) {
        skipped.push(entry.runId);
        continue;
      }
      // Ownership is proven BEFORE anything is shut down or closed, so a run
      // whose PID we cannot vouch for is reported and left entirely alone --
      // its bridge and PTY stay up for whoever owns that process now.
      const refusal = await this.refusalFor(entry);
      if (refusal !== null) {
        blocked.push({
          runId: entry.runId,
          code: refusal,
          message:
            refusal === 'ownership_conflict'
              ? 'PID is live but runs a different process; left untouched.'
              : 'Ownership could not be proven; left untouched.',
        });
        this.refuseRun(entry, refusal, 'shutdown');
        continue;
      }

      // Bridge first: a cooperative native shutdown flushes the session and
      // saves history, which a forced tree kill cannot do.
      const bridgeGraceExpired = await this.exceedsGrace(
        entry.ports.shutdownBridge(entry.runEpoch),
        graceMs,
      );
      if (bridgeGraceExpired) {
        blocked.push({
          runId: entry.runId,
          code: 'shutdown_timeout',
          message: `The bridge did not shut down within ${graceMs}ms; falling back to a forced owned-tree kill.`,
        });
      }
      try {
        await entry.ports.closePty(entry.runEpoch);
      } catch (err) {
        blocked.push({ runId: entry.runId, code: 'pty_close_failed', message: errorMessage(err) });
      }

      const outcome = await this.terminateRunProcess(entry);
      if (outcome === 'terminated' || outcome === 'gone') {
        terminated.push(entry.runId);
        this.releaseRun(entry, 'stopped', 'shutdown', false);
        continue;
      }
      // Identity changed while the bridge was going down; refuse after all.
      const code = outcome === 'conflict' ? 'ownership_conflict' : 'ownership_unproven';
      blocked.push({
        runId: entry.runId,
        code,
        message: 'The PID changed identity during shutdown; left untouched.',
      });
      this.refuseRun(entry, code, 'shutdown');
    }

    const runsInspected = this.runs.size;
    const handlesReleased = this.clearAllTracking();
    return {
      role: 'owner',
      runsInspected,
      terminated,
      blocked,
      skipped,
      handlesReleased,
    };
  }

  /**
   * Shared tail of kill/restart: prove ownership, close the PTY, terminate the
   * tree, then advance the epoch.
   *
   * The ownership check comes FIRST on purpose. A process we cannot prove is
   * ours must be left completely untouched -- not even hung up -- because a
   * recycled PID belongs to somebody else and hanging up their terminal is
   * the same damage as killing it. `terminateRunProcess` re-verifies after the
   * PTY close, so identity changing mid-flight still ends in a refusal.
   */
  private async finishRun(
    entry: RunEntry,
    reason: 'killed' | 'restart',
  ): Promise<SupervisedRunRecord> {
    const refusal = await this.refusalFor(entry);
    if (refusal !== null) {
      this.refuseRun(entry, refusal, reason);
      throw new CompanyError(
        refusal,
        `Run ${entry.runId} was not ${reason}: process ownership could not be proven.`,
      );
    }

    try {
      await entry.ports.closePty(entry.runEpoch);
    } catch {
      // The tree kill below is what actually frees the process; a PTY that
      // refuses to close must not turn a kill into a no-op.
    }
    const outcome = await this.terminateRunProcess(entry);
    if (outcome !== 'terminated' && outcome !== 'gone') {
      this.refuseRun(
        entry,
        outcome === 'conflict' ? 'ownership_conflict' : 'ownership_unproven',
        reason,
      );
      throw new CompanyError(
        outcome === 'conflict' ? 'ownership_conflict' : 'ownership_unproven',
        `Run ${entry.runId} was not ${reason}: the process changed identity mid-flight.`,
      );
    }

    entry.runEpoch += 1;
    entry.interrupted = true;
    entry.interruptionReason = reason;
    entry.blockedReason = null;
    entry.pid = null;
    this.transition(entry, 'stopped');
    return snapshot(entry);
  }

  /**
   * Why this run's process must not be touched, or null when it is safe.
   * A pure read: it verifies, it never signals.
   */
  private async refusalFor(
    entry: RunEntry,
  ): Promise<'ownership_conflict' | 'ownership_unproven' | null> {
    if (entry.pid === null) return null;
    const ref = this.tracked.get(entry.pid);
    if (ref === undefined) return null;
    const verdict = await this.verify(ref);
    if (verdict === 'conflict') return 'ownership_conflict';
    if (verdict === 'unproven') return 'ownership_unproven';
    return null;
  }

  private refuseRun(
    entry: RunEntry,
    code: 'ownership_conflict' | 'ownership_unproven',
    reason: string,
  ): void {
    this.block(
      entry,
      code,
      `${reason} refused: the live PID is not provably the process this run started.`,
    );
  }

  private async terminateRunProcess(entry: RunEntry): Promise<OwnershipVerdict> {
    if (entry.pid === null) return 'gone';
    const pid = entry.pid;
    const ref = this.tracked.get(pid);
    if (ref === undefined) {
      entry.pid = null;
      return 'gone';
    }
    const verdict = await this.verify(ref);
    if (verdict !== 'owned') {
      if (verdict === 'gone') {
        this.tracked.delete(pid);
        entry.pid = null;
      }
      return verdict;
    }
    await this.signalTree(ref);
    this.tracked.delete(pid);
    entry.pid = null;
    return 'terminated';
  }

  /**
   * Force-terminate a tree we have already proven we own.
   *
   * Windows walks children with `taskkill /T /F`. POSIX only signals a process
   * GROUP when the child actually leads one of its own -- signalling `-pid`
   * blindly would hit whatever group happens to carry that id, which may be
   * this very process.
   */
  private async signalTree(ref: OwnedProcessRef): Promise<void> {
    if (process.platform === 'win32') {
      await this.exec(
        'taskkill',
        ['/PID', String(ref.pid), '/T', '/F'],
        PROCESS_SUPERVISOR_COMMAND_TIMEOUT_MS,
      );
      await this.waitForGone(ref);
      return;
    }
    const ownGroup = ownProcessGroupId();
    const target =
      ref.processGroupId !== null &&
      ref.processGroupId === ref.pid &&
      ref.processGroupId !== ownGroup
        ? -ref.pid
        : ref.pid;
    this.signalProcess(target, 'SIGTERM');
    if (await this.waitForGone(ref)) return;
    this.signalProcess(target, 'SIGKILL');
    await this.waitForGone(ref);
  }

  private async waitForGone(ref: OwnedProcessRef): Promise<boolean> {
    const deadline = Date.now() + this.terminateGraceMs;
    while (Date.now() < deadline) {
      if ((await this.probe(ref.pid)).kind === 'absent') return true;
      await delay(PROCESS_SUPERVISOR_POLL_MS);
    }
    return (await this.probe(ref.pid)).kind === 'absent';
  }

  private async captureLineage(pid: number): Promise<void> {
    const result = await this.probe(pid);
    const tracked = this.tracked.get(pid);
    if (tracked === undefined || result.kind !== 'running') return;
    // Only ever fill in what the caller did not already record. Overwriting a
    // known start time with a fresh reading would make a recycled PID look
    // like ours -- the exact failure this module exists to prevent.
    this.tracked.set(pid, {
      ...tracked,
      startTime: tracked.startTime ?? result.identity.startTime,
      processGroupId: tracked.processGroupId ?? result.identity.processGroupId,
    });
  }

  private async settleCapture(pid: number): Promise<void> {
    const pending = this.captures.get(pid);
    if (pending === undefined) return;
    // A failed capture leaves the ref without a start time, which verify
    // treats as unproven -- the safe direction.
    await pending.catch(() => undefined);
    this.captures.delete(pid);
  }

  private assertEpoch(runId: string, runEpoch: number): RunEntry {
    const entry = this.runs.get(runId);
    if (entry === undefined) {
      throw new CompanyError('company_run_not_found', `Unknown company run: ${runId}`);
    }
    if (entry.runEpoch !== runEpoch) {
      throw new CompanyError(
        'stale_run_epoch',
        `Run ${runId} is at epoch ${entry.runEpoch}, not ${runEpoch}.`,
      );
    }
    return entry;
  }

  private async waitForQuiescence(
    entry: RunEntry,
    timeoutMs: number,
    token: number,
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      // A superseded wait (kill, release, dispose) must stop rather than race.
      if (entry.token !== token || entry.exited) return false;
      if (await entry.ports.isQuiescent(entry.runEpoch)) return true;
      await delay(PROCESS_SUPERVISOR_POLL_MS);
    }
    return false;
  }

  private async persist(entry: RunEntry): Promise<void> {
    if (entry.ports.persist === undefined) return;
    try {
      await entry.ports.persist(snapshot(entry));
    } catch (err) {
      throw new CompanyError(
        'company_persist_failed',
        `Could not persist run ${entry.runId}: ${errorMessage(err)}`,
        { cause: err instanceof Error ? err : undefined },
      );
    }
  }

  /**
   * Whether a fire-and-forget operation outlived its budget. A failure counts
   * as finished: a bridge that refuses to shut down must not stall the
   * shutdown, and a hung one must not either -- the race returns at the
   * deadline and leaves the abandoned work with its rejection already handled.
   */
  private async exceedsGrace(work: Promise<unknown>, graceMs: number): Promise<boolean> {
    const outcome = await Promise.race([
      work.then(
        () => 'finished' as const,
        () => 'finished' as const,
      ),
      delay(graceMs).then(() => 'expired' as const),
    ]);
    return outcome === 'expired';
  }

  private transition(entry: RunEntry, state: SupervisedRunState): void {
    entry.state = state;
    entry.updatedAt = new Date().toISOString();
    if (state !== 'blocked') entry.blockedReason = null;
  }

  private block(entry: RunEntry, code: string, message: string): void {
    entry.state = 'blocked';
    entry.blockedReason = { code, message };
    entry.updatedAt = new Date().toISOString();
  }

  /**
   * Retire a run: reap its handle, supersede its waits, settle its waiters.
   * `interrupted` is the caller's judgement -- a planned stop is not an
   * interruption, an exit nobody asked for is.
   */
  private releaseRun(
    entry: RunEntry,
    state: SupervisedRunState,
    reason: string,
    interrupted: boolean,
  ): void {
    entry.token += 1;
    entry.exited = true;
    entry.state = state;
    // The tracking entry exists to authorise a signal. A released run is
    // terminal, so keeping it would leak a handle nothing may ever act on.
    if (entry.pid !== null) {
      this.tracked.delete(entry.pid);
      this.captures.delete(entry.pid);
    }
    entry.pid = null;
    entry.updatedAt = new Date().toISOString();
    entry.interrupted = entry.interrupted || interrupted;
    entry.interruptionReason ??= reason;
    for (const waiter of [...entry.waiters]) waiter(true);
    entry.waiters.clear();
  }

  private clearAllTracking(): number {
    const handles = this.runs.size + this.tracked.size + this.captures.size;
    for (const entry of this.runs.values()) {
      entry.token += 1;
      for (const waiter of [...entry.waiters]) waiter(false);
      entry.waiters.clear();
    }
    this.runs.clear();
    this.tracked.clear();
    this.captures.clear();
    return handles;
  }
}

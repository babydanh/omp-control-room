/**
 * verificationRunner: runs a Contract's own verification commands and records
 * what actually happened.
 *
 * This is the only place a company verification command is started, and it is
 * deliberately the smallest executor that is still honest. It runs exactly the
 * `{executable, argv, cwd, timeoutSeconds}` tuples an approved Contract
 * declares, with `shell: false`, rooted in the canonical workspace, under a
 * bounded timeout, and it stores stdout and stderr as artifacts BEFORE it
 * returns. It never installs, migrates or seeds anything, never invents a
 * command the Contract did not approve, and never substitutes a "close enough"
 * command for the approved one.
 *
 * Only a real exit code of 0 is a pass. A timeout, a kill, a signal, a command
 * that could not be spawned, an unmet environment prerequisite and a failed
 * artifact write are all failures or blocks -- never a pass with a hopeful
 * note. Evidence carries the exit code and signal exactly as the OS reported
 * them, and `evaluateVerification` in companyWorkflow judges from those fields
 * alone, so a truthful runner and that verdict helper agree by construction.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';

import type {
  VerificationCommand,
  VerificationEvidence,
  VerificationProfile,
} from '../../../core/src/company.js';
import { CompanyError } from './companyError.js';
import {
  COMPANY_VERIFICATION_DEFAULT_TIMEOUT_SECONDS,
  COMPANY_VERIFICATION_MAX_CAPTURE_BYTES,
  COMPANY_VERIFICATION_MAX_COMMANDS,
  COMPANY_VERIFICATION_MAX_TIMEOUT_SECONDS,
  COMPANY_VERIFICATION_OUTPUT_MEDIA_TYPE,
} from './constants.js';
import { resolveWorkspaceTarget } from './permissionPolicy.js';

/** The slice of CompanyStore this runner needs; CompanyStore satisfies it. */
export interface VerificationArtifactStore {
  writeArtifact(content: Uint8Array, contentType: string): Promise<string>;
}

export type VerificationStatus = 'passed' | 'failed' | 'blocked';

/**
 * Checks one declared environment prerequisite. Resolve with `null` when it
 * holds, or a reason when it does not.
 *
 * A prerequisite is a claim that the machine is ready. When a Contract
 * declares one and no checker is supplied, the claim is unverifiable, and the
 * run is BLOCKED before anything starts -- never downgraded to "probably
 * fine". A test suite that fails because a database is down is a fact about
 * the environment, and letting it through as a red log would send the next
 * repair cycle after working code.
 */
export type PrerequisiteCheck = (prerequisite: string) => Promise<string | null>;

export interface VerificationContext {
  /** Canonical workspace root. No command may start outside it. */
  workspaceRoot: string;
  /** Where stdout/stderr artifacts are persisted. */
  store: VerificationArtifactStore;
  /** Overrides the hard ceiling; mostly useful to tighten it in tests. */
  maxTimeoutSeconds?: number;
  maxCaptureBytes?: number;
  /** Required whenever the Contract declares prerequisites; see PrerequisiteCheck. */
  checkPrerequisite?: PrerequisiteCheck;
  /** Cancels an in-flight run by killing the child; never leaves it running. */
  signal?: AbortSignal;
}

/** One approved command plus the Contract facts its evidence must carry. */
export interface ApprovedVerificationRun {
  command: VerificationCommand;
  criterionIds: readonly string[];
  prerequisites: readonly string[];
}

export interface VerificationCommandOutcome {
  status: VerificationStatus;
  evidence: VerificationEvidence;
  reason: string;
  /** Output exceeded the capture ceiling, so the stored log is a prefix. */
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  /** Timeout actually enforced, after clamping. */
  effectiveTimeoutSeconds: number;
}

export interface VerificationRunOutcome {
  status: VerificationStatus;
  /** One entry per command that actually ran, in execution order. */
  evidence: VerificationEvidence[];
  reason: string;
  /** Command ids whose logs were truncated at the capture ceiling. */
  truncatedCommandIds: string[];
  /**
   * Declared prerequisites that could not be machine-checked. Non-empty only
   * on a `blocked` outcome, and the reason it blocked.
   */
  unverifiedPrerequisites: string[];
}

export interface VerificationProfileValidation {
  valid: boolean;
  issues: string[];
}

/**
 * Thrown when the run finished but its logs could not be persisted.
 *
 * Failing loudly is the point: an exit-0 evidence record with no artifact refs
 * is indistinguishable downstream from a passing criterion nobody can read, and
 * `evaluateVerification` would happily mark it green. The observed exit code
 * travels on the error so nothing the command actually did is lost.
 */
export class VerificationArtifactError extends CompanyError {
  readonly commandId: string;
  readonly exitCode?: number;
  readonly signal?: string;

  constructor(
    commandId: string,
    message: string,
    exitCode?: number,
    signal?: string,
    cause?: unknown,
  ) {
    super('verification_artifact_write_failed', message, { cause });
    this.name = 'VerificationArtifactError';
    this.commandId = commandId;
    this.exitCode = exitCode;
    this.signal = signal;
  }
}

/** Thrown before any process starts when an approved command is unusable. */
export class VerificationCommandError extends CompanyError {
  readonly commandId: string;

  constructor(code: string, commandId: string, message: string) {
    super(code, message);
    this.name = 'VerificationCommandError';
    this.commandId = commandId;
  }
}

// ── Output capture ────────────────────────────────────────────────────────

interface OutputCapture {
  push(chunk: Buffer): void;
  bytes(): Buffer;
  dropped(): number;
}

/**
 * Keep at most `limit` bytes, but keep DRAINING. A capture that stopped reading
 * would fill the pipe and wedge the child until its timeout -- turning a noisy
 * build into a fake timeout. Over-limit bytes are counted and discarded.
 */
function createCapture(limit: number): OutputCapture {
  const chunks: Buffer[] = [];
  let kept = 0;
  let dropped = 0;
  return {
    push(chunk: Buffer): void {
      const room = limit - kept;
      if (room <= 0) {
        dropped += chunk.length;
        return;
      }
      if (chunk.length <= room) {
        chunks.push(chunk);
        kept += chunk.length;
        return;
      }
      chunks.push(chunk.subarray(0, room));
      kept = limit;
      dropped += chunk.length - room;
    },
    bytes(): Buffer {
      return Buffer.concat(chunks, kept);
    },
    dropped(): number {
      return dropped;
    },
  };
}

// ── Command validation ────────────────────────────────────────────────────

function isBlank(value: unknown): boolean {
  return typeof value !== 'string' || value.trim().length === 0;
}

/**
 * Resolve the working directory, refusing anything whose real path leaves the
 * workspace -- including through a symlink or a Windows junction. Reuses the
 * permission policy's resolver so "inside the workspace" means exactly one
 * thing across the whole company subsystem.
 */
function resolveCommandCwd(workspaceRoot: string, command: VerificationCommand): string {
  const resolved = resolveWorkspaceTarget(workspaceRoot, command.cwd);
  if (resolved === null) {
    throw new VerificationCommandError(
      'verification_cwd_outside_workspace',
      command.id,
      `Verification command ${command.id} runs outside the workspace: ${command.cwd}`,
    );
  }
  return resolved;
}

/**
 * A bare name is a PATH lookup -- how a Contract names a toolchain (`npm`,
 * `jest`) rather than a file. Anything carrying a separator or a leading dot
 * is a path and has to be proven to live inside the workspace. Validation and
 * execution share this predicate so a command cannot pass one and fail the
 * other.
 */
function looksLikePath(executable: string): boolean {
  return executable.includes('/') || executable.includes('\\') || executable.startsWith('.');
}

/**
 * An executable is named one of three ways, and only the third is a boundary
 * problem. A bare name is a PATH lookup (`npm`, `jest`). An absolute path is
 * how a Contract names a system toolchain that lives outside the workspace by
 * design -- `C:\Program Files\nodejs\node.exe`, `/usr/bin/node` -- and the
 * approved Contract is what authorises it. A RELATIVE path is workspace
 * content, so it has to resolve inside the workspace or it is a traversal.
 */
function resolveExecutable(workspaceRoot: string, command: VerificationCommand): string {
  const { executable } = command;
  if (!looksLikePath(executable) || path.isAbsolute(executable)) return executable;

  const resolved = resolveWorkspaceTarget(workspaceRoot, executable);
  if (resolved === null) {
    throw new VerificationCommandError(
      'verification_executable_outside_workspace',
      command.id,
      `Verification command ${command.id} resolves outside the workspace: ${executable}`,
    );
  }
  return resolved;
}

/**
 * Clamp a declared timeout into a usable range. A non-finite or non-positive
 * value falls back to the default rather than running unbounded; a value above
 * the ceiling is clamped, and the caller reports the effective value so a
 * silently shortened build can never look like a full one.
 */
function resolveTimeoutSeconds(command: VerificationCommand, ceilingSeconds: number): number {
  const declared = command.timeoutSeconds;
  const usable =
    typeof declared === 'number' && Number.isFinite(declared) && declared > 0
      ? Math.ceil(declared)
      : COMPANY_VERIFICATION_DEFAULT_TIMEOUT_SECONDS;
  return Math.min(usable, ceilingSeconds);
}

function validateCommandShape(command: VerificationCommand): string[] {
  const issues: string[] = [];
  if (isBlank(command.id)) issues.push('A verification command has no id.');
  if (isBlank(command.executable)) {
    issues.push(`Command ${command.id} declares no executable.`);
  }
  if (!Array.isArray(command.argv) || command.argv.some((arg) => typeof arg !== 'string')) {
    issues.push(`Command ${command.id} has a non-string argv.`);
  }
  return issues;
}

// ── Execution ─────────────────────────────────────────────────────────────

interface ChildResult {
  exitCode?: number;
  signal?: string;
  spawnError?: NodeJS.ErrnoException;
  timedOut: boolean;
  aborted: boolean;
}

function killChild(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill('SIGKILL');
  } catch {
    // Already reaped; the close event carries the real outcome.
  }
}

/**
 * Spawn the approved tuple with no shell and no stdin, and wait for the pipes
 * to close so the exit status is the process's, not our read loop's.
 */
function runChild(
  executable: string,
  argv: readonly string[],
  cwd: string,
  timeoutMs: number,
  captureLimit: number,
  signal: AbortSignal | undefined,
): Promise<{ result: ChildResult; stdout: OutputCapture; stderr: OutputCapture }> {
  return new Promise((resolve, reject) => {
    const stdout = createCapture(captureLimit);
    const stderr = createCapture(captureLimit);

    let child: ChildProcess;
    try {
      child = spawn(executable, [...argv], {
        cwd,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      reject(
        new VerificationCommandError(
          'verification_spawn_failed',
          executable,
          `Could not start ${executable}: ${(err as Error).message}`,
        ),
      );
      return;
    }

    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));

    let timedOut = false;
    let aborted = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      killChild(child);
    }, timeoutMs);

    const onAbort = (): void => {
      aborted = true;
      killChild(child);
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    const finish = (result: ChildResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve({ result, stdout, stderr });
    };

    child.on('error', (err: NodeJS.ErrnoException) => {
      finish({ spawnError: err, timedOut, aborted });
    });
    child.on('close', (code, childSignal) => {
      finish({
        exitCode: code ?? undefined,
        signal: childSignal ?? undefined,
        timedOut,
        aborted,
      });
    });
  });
}

function describeFailure(run: ApprovedVerificationRun, result: ChildResult): string {
  const label = `Command ${run.command.id}`;
  if (result.spawnError) {
    return `${label} could not be started (${result.spawnError.code ?? result.spawnError.message}).`;
  }
  if (result.aborted) return `${label} was cancelled before it finished.`;
  if (result.timedOut) {
    return `${label} produced no exit code: it exceeded its timeout and was killed, which is a failure, never a pass.`;
  }
  if (result.signal) {
    return `${label} was terminated by signal ${result.signal}; a signal is not a pass.`;
  }
  return `${label} exited ${String(result.exitCode)} instead of 0.`;
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Validate a Contract verification profile without running anything, so a
 * malformed profile is rejected at approval time instead of at the moment
 * somebody waits on a test run.
 */
export function validateVerificationProfile(
  profile: VerificationProfile,
  workspaceRoot: string,
): VerificationProfileValidation {
  const issues: string[] = [];

  if (!profile || typeof profile !== 'object') {
    return { valid: false, issues: ['Verification profile is missing.'] };
  }
  if (!Array.isArray(profile.commands) || profile.commands.length === 0) {
    issues.push(`Profile ${profile.id} declares no commands.`);
  } else if (profile.commands.length > COMPANY_VERIFICATION_MAX_COMMANDS) {
    issues.push(
      `Profile ${profile.id} declares ${profile.commands.length} commands, above the ${COMPANY_VERIFICATION_MAX_COMMANDS} limit.`,
    );
  }

  const commands = profile.commands ?? [];
  for (const [index, command] of commands.entries()) {
    issues.push(...validateCommandShape(command));
    if (commands.findIndex((other) => other.id === command.id) !== index) {
      issues.push(`Profile ${profile.id} repeats command id ${command.id}.`);
    }

    if (isBlank(command.cwd) || resolveWorkspaceTarget(workspaceRoot, command.cwd) === null) {
      issues.push(`Command ${command.id} runs outside the workspace: ${command.cwd}`);
    }
    // Mirrors resolveExecutable: only a workspace-relative executable is a
    // boundary problem. A bare name is a PATH lookup and an absolute path is
    // the Contract naming a system toolchain.
    if (
      !isBlank(command.executable) &&
      looksLikePath(command.executable) &&
      !path.isAbsolute(command.executable) &&
      resolveWorkspaceTarget(workspaceRoot, command.executable) === null
    ) {
      issues.push(`Command ${command.id} resolves outside the workspace: ${command.executable}`);
    }
  }

  for (const scope of profile.outputScopes ?? []) {
    if (isBlank(scope) || resolveWorkspaceTarget(workspaceRoot, scope) === null) {
      issues.push(`Profile ${profile.id} writes output outside the workspace: ${scope}`);
    }
  }

  return { valid: issues.length === 0, issues };
}

/**
 * Run one approved command to completion and return its evidence.
 *
 * The command is started only after its cwd and executable are proven to be
 * inside the workspace, and the returned evidence exists only after both
 * output artifacts are persisted.
 */
export async function runVerificationCommand(
  run: ApprovedVerificationRun,
  context: VerificationContext,
): Promise<VerificationCommandOutcome> {
  const { command } = run;
  const ceilingSeconds = Math.max(
    1,
    context.maxTimeoutSeconds ?? COMPANY_VERIFICATION_MAX_TIMEOUT_SECONDS,
  );
  const captureLimit = Math.max(
    1024,
    context.maxCaptureBytes ?? COMPANY_VERIFICATION_MAX_CAPTURE_BYTES,
  );

  const shapeIssues = validateCommandShape(command);
  if (shapeIssues.length > 0) {
    throw new VerificationCommandError(
      'verification_command_invalid',
      command.id,
      shapeIssues.join(' '),
    );
  }
  if (context.signal?.aborted) {
    throw new VerificationCommandError(
      'verification_cancelled',
      command.id,
      `Command ${command.id} was cancelled before it started.`,
    );
  }

  // The single-command entry point owes the same guarantee as the profile
  // runner: a declared prerequisite that cannot be checked stops the command,
  // because this function would otherwise happily return a pass that nobody
  // verified the environment for.
  for (const prerequisite of run.prerequisites) {
    if (!context.checkPrerequisite) {
      throw new VerificationCommandError(
        'verification_prerequisites_uncheckable',
        command.id,
        `Command ${command.id} declares prerequisite "${prerequisite}", but no prerequisite checker is available.`,
      );
    }
    const unmet = await context.checkPrerequisite(prerequisite);
    if (unmet) {
      throw new VerificationCommandError(
        'verification_prerequisite_unmet',
        command.id,
        `Command ${command.id} is blocked by prerequisite "${prerequisite}": ${unmet}`,
      );
    }
  }

  const cwd = resolveCommandCwd(context.workspaceRoot, command);
  const executable = resolveExecutable(context.workspaceRoot, command);
  const effectiveTimeoutSeconds = resolveTimeoutSeconds(command, ceilingSeconds);

  const startedAt = new Date().toISOString();
  const { result, stdout, stderr } = await runChild(
    executable,
    command.argv,
    cwd,
    effectiveTimeoutSeconds * 1000,
    captureLimit,
    context.signal,
  );
  const endedAt = new Date().toISOString();

  const exitedCleanly = !result.timedOut && !result.aborted && !result.spawnError;
  const passed = exitedCleanly && result.exitCode === 0;

  let stdoutArtifactId: string | undefined;
  let stderrArtifactId: string | undefined;
  try {
    // Both streams are always stored, so "no output" and "output not captured"
    // are never confused with each other.
    stdoutArtifactId = await context.store.writeArtifact(
      stdout.bytes(),
      COMPANY_VERIFICATION_OUTPUT_MEDIA_TYPE,
    );
    stderrArtifactId = await context.store.writeArtifact(
      stderr.bytes(),
      COMPANY_VERIFICATION_OUTPUT_MEDIA_TYPE,
    );
  } catch (err) {
    throw new VerificationArtifactError(
      command.id,
      `Command ${command.id} finished (exit ${String(result.exitCode)}) but its output could not be stored, so no evidence was recorded.`,
      result.exitCode,
      result.signal,
      err,
    );
  }

  const evidence: VerificationEvidence = {
    id: randomUUID(),
    command,
    startedAt,
    endedAt,
    ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
    ...(result.signal ? { signal: result.signal } : {}),
    stdoutArtifactId,
    stderrArtifactId,
    ...(run.prerequisites.length > 0 ? { prerequisites: [...run.prerequisites] } : {}),
    criterionIds: [...run.criterionIds],
  };

  const status: VerificationStatus = passed ? 'passed' : result.spawnError ? 'blocked' : 'failed';

  return {
    status,
    evidence,
    reason: passed ? 'Command exited 0.' : describeFailure(run, result),
    stdoutTruncated: stdout.dropped() > 0,
    stderrTruncated: stderr.dropped() > 0,
    effectiveTimeoutSeconds,
  };
}

/**
 * Run an approved Contract profile's commands in declaration order.
 *
 * Commands are sequential by default: a test suite that runs after its build
 * already failed reports noise, not evidence. An unmet prerequisite blocks
 * before anything starts, because a command that cannot possibly pass should
 * not be started just to produce a red log.
 */
export async function runVerificationProfile(
  profile: VerificationProfile,
  context: VerificationContext,
  options: { stopOnFailure?: boolean } = {},
): Promise<VerificationRunOutcome> {
  const stopOnFailure = options.stopOnFailure ?? true;
  const validation = validateVerificationProfile(profile, context.workspaceRoot);
  if (!validation.valid) {
    throw new VerificationCommandError(
      'verification_profile_invalid',
      profile?.id ?? 'unknown',
      validation.issues.join(' '),
    );
  }

  const unverifiedPrerequisites: string[] = [];
  const unmet: string[] = [];
  for (const prerequisite of profile.prerequisites ?? []) {
    if (!context.checkPrerequisite) {
      unverifiedPrerequisites.push(prerequisite);
      continue;
    }
    const reason = await context.checkPrerequisite(prerequisite);
    if (reason) unmet.push(`${prerequisite} (${reason})`);
  }
  // A prerequisite nobody can check is not a prerequisite nobody needs. The
  // Contract says the command needs something from the environment, and the
  // host cannot confirm that environment, so the run is blocked -- running it
  // anyway would turn a broken machine into a red log that reads like a code
  // defect, and the next repair cycle would "fix" working code to satisfy it.
  if (unverifiedPrerequisites.length > 0) {
    return {
      status: 'blocked',
      evidence: [],
      reason: `These declared prerequisites could not be checked because no prerequisite checker is available: ${unverifiedPrerequisites.join('; ')}. No command was started.`,
      truncatedCommandIds: [],
      unverifiedPrerequisites,
    };
  }
  if (unmet.length > 0) {
    return {
      status: 'blocked',
      evidence: [],
      reason: `Unmet prerequisites: ${unmet.join('; ')}. No command was started.`,
      truncatedCommandIds: [],
      unverifiedPrerequisites,
    };
  }

  const evidence: VerificationEvidence[] = [];
  const truncatedCommandIds: string[] = [];
  const failures: string[] = [];

  for (const command of profile.commands) {
    const outcome = await runVerificationCommand(
      {
        command,
        criterionIds: profile.criterionIds ?? [],
        prerequisites: profile.prerequisites ?? [],
      },
      context,
    );
    evidence.push(outcome.evidence);
    if (outcome.stdoutTruncated || outcome.stderrTruncated) {
      truncatedCommandIds.push(command.id);
    }
    if (outcome.status !== 'passed') {
      failures.push(outcome.reason);
      if (stopOnFailure) break;
    }
  }

  return {
    status: failures.length > 0 ? 'failed' : 'passed',
    evidence,
    reason:
      failures.length > 0
        ? failures.join(' ')
        : `All ${evidence.length} verification command(s) exited 0.`,
    truncatedCommandIds,
    unverifiedPrerequisites,
  };
}

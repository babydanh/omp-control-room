import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  AcceptanceCriterion,
  VerificationCommand,
  VerificationProfile,
} from '../../core/src/company.js';
import type { CompanyStore as CompanyStoreType } from '../src/company/companyStore.js';
// Type-only imports are erased, so they do not load the module under test
// before the `os` mock below is in place.
import type {
  VerificationArtifactStore,
  VerificationContext,
} from '../src/company/verificationRunner.js';

let tempHome: string;
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof os>('os');
  return { ...actual, homedir: () => tempHome };
});
// The runner is loaded through a dynamic import so that `os.homedir` is
// already mocked when CompanyStore resolves the artifact namespace; a static
// import would be hoisted above the mock and write into the real home
// directory instead of this suite's temporary one.

const { CompanyStore } = await import('../src/company/companyStore.js');
const {
  runVerificationCommand,
  runVerificationProfile,
  validateVerificationProfile,
  VerificationArtifactError,
} = await import('../src/company/verificationRunner.js');
const { evaluateVerification } = await import('../src/company/companyWorkflow.js');

/** A real Node binary, so every case below runs an actual child process. */
const NODE = process.execPath;

describe('company verification runner', () => {
  let workspace: string;
  let pkg: string;
  let outside: string;
  let store: CompanyStoreType;

  beforeEach(async () => {
    tempHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pxl-company-verify-'));
    workspace = path.join(tempHome, 'workspace');
    pkg = path.join(workspace, 'pkg');
    outside = path.join(tempHome, 'outside');
    await fs.promises.mkdir(pkg, { recursive: true });
    await fs.promises.mkdir(outside, { recursive: true });
    store = await CompanyStore.open(workspace);
  });

  afterEach(async () => {
    await fs.promises.rm(tempHome, { recursive: true, force: true });
  });

  function command(overrides: Partial<VerificationCommand> & { id: string }): VerificationCommand {
    return {
      executable: NODE,
      argv: ['-e', 'process.exit(0)'],
      cwd: pkg,
      timeoutSeconds: 30,
      ...overrides,
    } as VerificationCommand;
  }

  function profile(overrides: Partial<VerificationProfile> & { id: string }): VerificationProfile {
    return {
      criterionIds: [],
      commands: [],
      prerequisites: [],
      outputScopes: [],
      ...overrides,
    } as VerificationProfile;
  }

  function criterion(id: string): AcceptanceCriterion {
    return {
      id,
      requirementIds: [randomUUID()],
      description: 'tests pass',
      kind: 'command',
      required: true,
    } as AcceptanceCriterion;
  }

  /** Counts artifact writes while still persisting, so "nothing ran" is provable. */
  function countingStore(): { store: VerificationArtifactStore; writes: () => number } {
    let writes = 0;
    return {
      writes: () => writes,
      store: {
        writeArtifact: (content: Uint8Array, contentType: string) => {
          writes += 1;
          return store.writeArtifact(content, contentType);
        },
      },
    };
  }

  function context(overrides: Partial<VerificationContext> = {}): VerificationContext {
    return { workspaceRoot: workspace, store, ...overrides };
  }

  async function readArtifactText(id: string): Promise<string> {
    const page = await store.readArtifact(id, 0, 1024 * 1024);
    return Buffer.from(page.dataBase64, 'base64').toString('utf8');
  }

  function run(approved: VerificationCommand, overrides: Partial<VerificationContext> = {}) {
    return runVerificationCommand(
      { command: approved, criterionIds: ['criterion-1'], prerequisites: [] },
      context(overrides),
    );
  }

  it('records a passing command with its argv, cwd and output preserved', async () => {
    const argv = [
      '-e',
      "process.stdout.write('args=' + process.argv.slice(1).join('|') + '\\n');" +
        "process.stdout.write('cwd=' + process.cwd() + '\\n');" +
        "process.stderr.write('one warning');",
      'alpha',
      'beta',
    ];
    const approved = command({ id: 'cmd-pass', argv });

    const outcome = await run(approved);
    const evidence = outcome.evidence;

    expect(outcome.status).toBe('passed');
    expect(evidence.exitCode).toBe(0);
    expect(evidence.signal).toBeUndefined();
    expect(evidence.command.argv).toEqual(argv);
    expect(evidence.command.cwd).toBe(pkg);
    expect(evidence.criterionIds).toEqual(['criterion-1']);

    // The stored logs are the command's real output, not a summary of it.
    const stdout = await readArtifactText(evidence.stdoutArtifactId!);
    expect(stdout).toContain('args=alpha|beta');
    expect(stdout).toContain(await fs.promises.realpath(pkg));
    expect(await readArtifactText(evidence.stderrArtifactId!)).toBe('one warning');

    const started = Date.parse(evidence.startedAt);
    const ended = Date.parse(evidence.endedAt);
    expect(Number.isNaN(started)).toBe(false);
    expect(ended).toBeGreaterThanOrEqual(started);
  });

  it('produces evidence the shared verdict helper accepts as passing', async () => {
    const outcome = await run(command({ id: 'cmd-verdict' }));

    const verdict = evaluateVerification(
      [criterion('criterion-1')],
      new Map([['criterion-1', ['cmd-verdict']]]),
      [outcome.evidence],
    );
    expect(verdict.passed).toBe(true);
  });

  it('passes argv literally, without a shell interpreting it', async () => {
    const injected = 'alpha && echo pwned > pwned.txt; $(whoami) | tee x';
    const approved = command({
      id: 'cmd-no-shell',
      argv: ['-e', 'process.stdout.write(process.argv[1])', injected],
    });

    const outcome = await run(approved);

    expect(outcome.status).toBe('passed');
    expect(await readArtifactText(outcome.evidence.stdoutArtifactId!)).toBe(injected);
    // Nothing the argv mentioned actually happened.
    await expect(fs.promises.stat(path.join(pkg, 'pwned.txt'))).rejects.toThrow();
    await expect(fs.promises.stat(path.join(pkg, 'x'))).rejects.toThrow();
  });

  it('treats a nonzero exit as a failure and keeps its stderr', async () => {
    const approved = command({
      id: 'cmd-fail',
      argv: ['-e', "process.stderr.write('2 tests failed'); process.exit(7);"],
    });

    const outcome = await run(approved);

    expect(outcome.status).toBe('failed');
    expect(outcome.evidence.exitCode).toBe(7);
    expect(await readArtifactText(outcome.evidence.stderrArtifactId!)).toBe('2 tests failed');
    expect(outcome.reason).toContain('exited 7');

    const verdict = evaluateVerification(
      [criterion('criterion-1')],
      new Map([['criterion-1', ['cmd-fail']]]),
      [outcome.evidence],
    );
    expect(verdict.passed).toBe(false);
    expect(verdict.issues.join(' ')).toContain('criterion-1');
  });

  it('records a timeout as a failure with no exit code, never as a pass', async () => {
    // A real child and a real clock are the point of this case: the runner
    // enforces the timeout with a platform timer around a live process, so a
    // fake clock would not exercise the behaviour under test. One second is
    // the shortest whole-second timeout the Contract DTO can express.
    const approved = command({
      id: 'cmd-hang',
      argv: ['-e', 'setInterval(() => {}, 50);'],
      timeoutSeconds: 1,
    });

    const started = Date.now();
    const outcome = await run(approved);
    const elapsed = Date.now() - started;

    expect(outcome.status).toBe('failed');
    expect(outcome.effectiveTimeoutSeconds).toBe(1);
    // The absence of an exit code is the truthful record of a killed process,
    // and it is what stops the shared verdict helper calling this green.
    expect(outcome.evidence.exitCode).toBeUndefined();
    expect(elapsed).toBeGreaterThanOrEqual(900);
    expect(outcome.reason).toContain('timeout');

    const verdict = evaluateVerification(
      [criterion('criterion-1')],
      new Map([['criterion-1', ['cmd-hang']]]),
      [outcome.evidence],
    );
    expect(verdict.passed).toBe(false);
    expect(verdict.issues.join(' ')).toContain('no exit code');
  });

  it('refuses a working directory outside the workspace and starts nothing', async () => {
    const counter = countingStore();
    const approved = command({ id: 'cmd-escape', cwd: outside });

    await expect(
      runVerificationCommand(
        { command: approved, criterionIds: [], prerequisites: [] },
        context({ store: counter.store }),
      ),
    ).rejects.toMatchObject({
      code: 'verification_cwd_outside_workspace',
      commandId: 'cmd-escape',
    });
    expect(counter.writes()).toBe(0);
  });

  it('refuses a working directory that escapes through a junction', async () => {
    const link = path.join(workspace, 'linked');
    try {
      await fs.promises.symlink(outside, link, 'junction');
    } catch {
      return; // no link permission on this host; the lexical case above still holds
    }
    const counter = countingStore();
    const approved = command({ id: 'cmd-junction', cwd: link });

    await expect(
      runVerificationCommand(
        { command: approved, criterionIds: [], prerequisites: [] },
        context({ store: counter.store }),
      ),
    ).rejects.toMatchObject({ code: 'verification_cwd_outside_workspace' });
    expect(counter.writes()).toBe(0);
  });

  it('refuses a workspace-relative executable that climbs out of the workspace', async () => {
    const counter = countingStore();
    const approved = command({
      id: 'cmd-exec-escape',
      executable: path.join('..', 'outside', 'run.sh'),
    });

    await expect(
      runVerificationCommand(
        { command: approved, criterionIds: [], prerequisites: [] },
        context({ store: counter.store }),
      ),
    ).rejects.toMatchObject({ code: 'verification_executable_outside_workspace' });
    expect(counter.writes()).toBe(0);
  });

  it('accepts an absolute system toolchain, which lives outside the workspace by design', () => {
    // Every other case here already runs the real Node binary; this pins the
    // rule that a Contract may name an interpreter installed on the machine.
    const validation = validateVerificationProfile(
      profile({ id: 'p-node', commands: [command({ id: 'cmd-node' })] }),
      workspace,
    );

    expect(NODE.startsWith('/') || path.isAbsolute(NODE)).toBe(true);
    expect(validation).toEqual({ valid: true, issues: [] });
  });

  it('reports an unstartable command as blocked, not as a code failure', async () => {
    const outcome = await run(
      command({ id: 'cmd-missing', executable: 'definitely-not-a-real-binary-xyz' }),
    );

    expect(outcome.status).toBe('blocked');
    expect(outcome.evidence.exitCode).toBeUndefined();
    expect(outcome.reason).toContain('could not be started');
  });

  it('returns no evidence at all when the output artifacts cannot be stored', async () => {
    const failing: VerificationArtifactStore = {
      writeArtifact: vi.fn().mockRejectedValue(new Error('disk full')),
    };

    const failure = await runVerificationCommand(
      { command: command({ id: 'cmd-artifact' }), criterionIds: [], prerequisites: [] },
      context({ store: failing }),
    ).catch((err: unknown) => err);

    // The command really did exit 0, but a green verdict nobody can audit is
    // worse than an error, so the run fails closed and still reports the exit
    // code it observed.
    expect(failure).toBeInstanceOf(VerificationArtifactError);
    expect(failure).toMatchObject({
      code: 'verification_artifact_write_failed',
      commandId: 'cmd-artifact',
      exitCode: 0,
    });
    // Storage fails fast: once the first log cannot be written there is no
    // evidence to complete, so the second write is not even attempted.
    expect(failing.writeArtifact).toHaveBeenCalledTimes(1);
  });

  it('blocks before running anything when a prerequisite is unmet', async () => {
    const counter = countingStore();
    const approvedProfile = profile({
      id: 'profile-db',
      commands: [command({ id: 'cmd-needs-db' })],
      prerequisites: ['DATABASE_URL is set'],
    });

    const outcome = await runVerificationProfile(
      approvedProfile,
      context({
        store: counter.store,
        checkPrerequisite: async (prerequisite) =>
          prerequisite === 'DATABASE_URL is set' ? 'environment variable is empty' : null,
      }),
    );

    expect(outcome.status).toBe('blocked');
    expect(outcome.evidence).toEqual([]);
    expect(outcome.reason).toContain('DATABASE_URL');
    expect(counter.writes()).toBe(0);
  });

  it('blocks without running anything when a declared prerequisite cannot be checked', async () => {
    // No checkPrerequisite is configured, so nothing can confirm the declared
    // environment. Failing closed here is the whole point: running the command
    // anyway would report a red log the model would then try to "fix" in the
    // code, when the real problem is the machine.
    const marker = path.join(pkg, 'should-not-run.txt');
    const counter = countingStore();
    const approvedProfile = profile({
      id: 'profile-uncheckable',
      commands: [
        command({
          id: 'cmd-uncheckable',
          argv: ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`],
        }),
      ],
      prerequisites: ['PostgreSQL is reachable'],
    });

    const outcome = await runVerificationProfile(
      approvedProfile,
      context({ store: counter.store }),
    );

    expect(outcome.status).toBe('blocked');
    expect(outcome.evidence).toEqual([]);
    expect(outcome.truncatedCommandIds).toEqual([]);
    expect(outcome.reason).toContain('PostgreSQL is reachable');
    expect(outcome.reason).toContain('No command was started');
    expect(outcome.unverifiedPrerequisites).toEqual(['PostgreSQL is reachable']);
    // Nothing ran: no artifacts, and the command's own side effect is absent.
    expect(counter.writes()).toBe(0);
    await expect(fs.promises.stat(marker)).rejects.toThrow();
  });

  it('refuses a single approved command whose declared prerequisite is uncheckable', async () => {
    const marker = path.join(pkg, 'single-should-not-run.txt');
    const counter = countingStore();

    await expect(
      runVerificationCommand(
        {
          command: command({
            id: 'cmd-single',
            argv: ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`],
          }),
          criterionIds: [],
          prerequisites: ['Redis is reachable'],
        },
        context({ store: counter.store }),
      ),
    ).rejects.toMatchObject({ code: 'verification_prerequisites_uncheckable' });

    expect(counter.writes()).toBe(0);
    await expect(fs.promises.stat(marker)).rejects.toThrow();
  });

  it("runs only the profile's own commands and stops at the first failure", async () => {
    const marker = path.join(pkg, 'second-ran.txt');
    const approvedProfile = profile({
      id: 'profile-order',
      commands: [
        command({ id: 'cmd-1', argv: ['-e', 'process.exit(1)'] }),
        command({
          id: 'cmd-2',
          argv: ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`],
        }),
      ],
    });

    const outcome = await runVerificationProfile(approvedProfile, context());

    expect(outcome.status).toBe('failed');
    expect(outcome.evidence.map((entry) => entry.command.id)).toEqual(['cmd-1']);
    await expect(fs.promises.stat(marker)).rejects.toThrow();
  });

  it('runs every command when asked to keep going after a failure', async () => {
    const marker = path.join(pkg, 'second-ran.txt');
    const approvedProfile = profile({
      id: 'profile-continue',
      commands: [
        command({ id: 'cmd-1', argv: ['-e', 'process.exit(1)'] }),
        command({
          id: 'cmd-2',
          argv: ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`],
        }),
      ],
    });

    const outcome = await runVerificationProfile(approvedProfile, context(), {
      stopOnFailure: false,
    });

    expect(outcome.status).toBe('failed');
    expect(outcome.evidence.map((entry) => entry.command.id)).toEqual(['cmd-1', 'cmd-2']);
    await expect(fs.promises.stat(marker)).resolves.toBeTruthy();
  });

  it('bounds captured output and records that it was truncated', async () => {
    const approved = command({
      id: 'cmd-chatty',
      argv: ['-e', "process.stdout.write('x'.repeat(200000))"],
    });

    const outcome = await runVerificationProfile(
      profile({ id: 'profile-chatty', commands: [approved] }),
      context({ maxCaptureBytes: 4096 }),
    );

    expect(outcome.status).toBe('passed');
    expect(outcome.truncatedCommandIds).toEqual(['cmd-chatty']);
    expect((await readArtifactText(outcome.evidence[0].stdoutArtifactId!)).length).toBe(4096);
  });

  it('clamps an absurd declared timeout instead of running unbounded', async () => {
    const outcome = await run(command({ id: 'cmd-long', timeoutSeconds: 10 ** 9 }), {
      maxTimeoutSeconds: 30,
    });

    expect(outcome.effectiveTimeoutSeconds).toBe(30);
  });

  it('rejects a profile with no commands, repeated ids, or an escaping output scope', () => {
    const base = command({ id: 'cmd-a' });

    expect(validateVerificationProfile(profile({ id: 'p-empty' }), workspace)).toMatchObject({
      valid: false,
    });

    const duplicate = validateVerificationProfile(
      profile({ id: 'p-dup', commands: [base, { ...base }] }),
      workspace,
    );
    expect(duplicate.valid).toBe(false);
    expect(duplicate.issues.join(' ')).toContain('repeats command id cmd-a');

    const escaping = validateVerificationProfile(
      profile({ id: 'p-scope', commands: [base], outputScopes: ['../escape'] }),
      workspace,
    );
    expect(escaping.valid).toBe(false);
    expect(escaping.issues.join(' ')).toContain('outside the workspace');
  });

  it('refuses to start a profile whose command is malformed', async () => {
    const approvedProfile = profile({
      id: 'p-bad-cwd',
      commands: [command({ id: 'cmd-bad', cwd: outside })],
    });

    await expect(runVerificationProfile(approvedProfile, context())).rejects.toMatchObject({
      code: 'verification_profile_invalid',
    });
  });
});

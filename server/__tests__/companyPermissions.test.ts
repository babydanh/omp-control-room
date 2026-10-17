import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { CompanyRole, WriteScope } from '../../core/src/company.js';
import type {
  ApprovedVerificationCommand,
  PermissionDecision,
  ToolCallRequest,
} from '../src/company/permissionPolicy.js';
import { actionDigest, decideToolCall } from '../src/company/permissionPolicy.js';

const WORKSPACE_SCOPES: WriteScope[] = [
  { path: 'src', kind: 'directory', operations: ['create', 'modify'] },
];

/** Narrows the decision union so the approval flag can be read. */
function approvalRequired(decision: PermissionDecision): boolean {
  return decision.allowed === false && decision.requiresApproval === true;
}

interface CallOverrides {
  role?: CompanyRole;
  tool?: string;
  args?: Record<string, unknown>;
  scopes?: WriteScope[];
  approvedCommands?: ApprovedVerificationCommand[];
  approval?: 'approve_once' | 'reject';
}

/** Build a request with sensible defaults; `inWorkspace` sets the real root. */
function call(overrides: CallOverrides = {}): ToolCallRequest {
  return {
    role: overrides.role ?? 'worker',
    tool: overrides.tool ?? 'write',
    args: overrides.args ?? { path: 'src/app.ts', content: 'x' },
    workspaceRoot: '',
    writeScopes: overrides.scopes ?? WORKSPACE_SCOPES,
    approvedCommands: overrides.approvedCommands ?? [],
    ...(overrides.approval === undefined ? {} : { approval: overrides.approval }),
  };
}

describe('company permission policy', () => {
  let workspace: string;
  let home: string;

  beforeEach(async () => {
    home = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pxl-perm-'));
    workspace = path.join(home, 'workspace');
    await fs.promises.mkdir(path.join(workspace, 'src'), { recursive: true });
    await fs.promises.writeFile(path.join(workspace, 'src', 'app.ts'), 'export const a = 1;\n');
    await fs.promises.writeFile(path.join(workspace, 'secret.env'), 'TOKEN=abc\n');
  });

  afterEach(async () => {
    await fs.promises.rm(home, { recursive: true, force: true });
  });

  function inWorkspace(request: ToolCallRequest): ToolCallRequest {
    return { ...request, workspaceRoot: workspace };
  }

  it('allows a worker to write inside an approved scope', async () => {
    const decision = decideToolCall(inWorkspace(call({})));

    expect(decision.allowed).toBe(true);
  });

  it('asks the user for a write outside every approved scope', () => {
    const decision = decideToolCall(
      inWorkspace(call({ args: { path: 'docs/readme.md', content: 'x' } })),
    );

    expect(decision.allowed).toBe(false);
    expect(approvalRequired(decision)).toBe(true);
  });

  it('refuses a traversal out of the workspace even when approval is granted', () => {
    const decision = decideToolCall(
      inWorkspace(
        call({
          args: { path: path.join('..', 'outside.txt'), content: 'x' },
          approval: 'approve_once',
        }),
      ),
    );

    expect(decision.allowed).toBe(false);
    // Approve-once buys scope expansion inside the workspace, never a write
    // outside it.
    expect(approvalRequired(decision)).toBe(false);
  });

  it('asks before deleting, even inside an approved scope', () => {
    const decision = decideToolCall(
      inWorkspace(call({ tool: 'bash', args: { command: 'rm src/app.ts' } })),
    );

    expect(decision.allowed).toBe(false);
    expect(approvalRequired(decision)).toBe(true);
  });

  it('asks before touching a lockfile, a secret file or a database file', () => {
    for (const args of [
      { path: 'package-lock.json', content: '{}' },
      { path: 'secret.env', content: 'TOKEN=changed' },
      { path: 'data/users.sqlite', content: 'x' },
    ]) {
      const decision = decideToolCall(
        inWorkspace(
          call({
            scopes: [{ path: '', kind: 'directory', operations: ['create', 'modify'] }],
            args,
          }),
        ),
      );
      expect(decision.allowed).toBe(false);
      expect(approvalRequired(decision)).toBe(true);
    }
  });

  it('auto-runs only an exact approved verification command', () => {
    const approved = {
      id: 'cmd-1',
      executable: 'npm',
      argv: ['test', '--', '--runInBand'],
      cwd: workspace,
    };

    const allowed = decideToolCall(
      inWorkspace(
        call({
          role: 'qa',
          tool: 'company_verify',
          approvedCommands: [approved],
          args: {
            id: approved.id,
            executable: approved.executable,
            argv: approved.argv,
            cwd: approved.cwd,
          },
        }),
      ),
    );
    expect(allowed.allowed).toBe(true);

    const changedArgv = decideToolCall(
      inWorkspace(
        call({
          role: 'qa',
          tool: 'company_verify',
          approvedCommands: [approved],
          args: {
            id: approved.id,
            executable: approved.executable,
            argv: ['test'],
            cwd: workspace,
          },
        }),
      ),
    );
    expect(changedArgv.allowed).toBe(false);
    expect(approvalRequired(changedArgv)).toBe(true);
  });

  it('never auto-runs a shell string with operators', () => {
    for (const command of [
      'npm test && rm -rf /',
      'npm test; echo done',
      'cat file | sh',
      'echo `whoami`',
    ]) {
      const decision = decideToolCall(inWorkspace(call({ tool: 'bash', args: { command } })));
      expect(decision.allowed).toBe(false);
      expect(approvalRequired(decision)).toBe(true);
    }
  });

  it('keeps non-worker roles off any effectful tool', () => {
    for (const role of ['director', 'advisor', 'judge'] as CompanyRole[]) {
      expect(decideToolCall(inWorkspace(call({ role })))).toMatchObject({
        allowed: false,
        requiresApproval: false,
      });
      expect(
        decideToolCall(inWorkspace(call({ role, tool: 'bash', args: { command: 'ls' } }))),
      ).toMatchObject({ allowed: false, requiresApproval: false });
    }
  });

  it('gives QA the verification tool but not general shell access', () => {
    expect(
      decideToolCall(
        inWorkspace(call({ role: 'qa', tool: 'company_verify', args: { id: 'cmd-1' } })),
      ),
    ).toMatchObject({ allowed: false, requiresApproval: true });

    expect(
      decideToolCall(inWorkspace(call({ role: 'qa', tool: 'bash', args: { command: 'ls' } }))),
    ).toMatchObject({ allowed: false, requiresApproval: false });
  });

  it('lets every role read', () => {
    for (const role of ['director', 'advisor', 'worker', 'qa', 'judge'] as CompanyRole[]) {
      expect(
        decideToolCall(inWorkspace(call({ role, tool: 'read', args: { path: 'src/app.ts' } }))),
      ).toMatchObject({ allowed: true });
    }
  });

  it('binds an approval to the exact action payload', () => {
    const first = actionDigest({
      sessionId: 's1',
      taskId: 't1',
      runEpoch: 2,
      toolCallId: 'call-1',
      tool: 'write',
      args: { path: 'src/app.ts', content: 'one' },
    });
    const changed = actionDigest({
      sessionId: 's1',
      taskId: 't1',
      runEpoch: 2,
      toolCallId: 'call-1',
      tool: 'write',
      args: { path: 'src/app.ts', content: 'two' },
    });
    const newEpoch = actionDigest({
      sessionId: 's1',
      taskId: 't1',
      runEpoch: 3,
      toolCallId: 'call-1',
      tool: 'write',
      args: { path: 'src/app.ts', content: 'one' },
    });

    expect(first).toMatch(/^[0-9a-f]{64}$/);
    // Different content, same call: a different action, so a different digest.
    expect(changed).not.toBe(first);
    // Same content, new epoch: the old approval must not carry over.
    expect(newEpoch).not.toBe(first);
    // The server re-derives the digest from the action it displayed when the
    // answer arrives, so it must be a pure function of its input: two
    // independently built identical calls have to agree.
    expect(
      actionDigest({
        sessionId: 's1',
        taskId: 't1',
        runEpoch: 2,
        toolCallId: 'call-1',
        tool: 'write',
        args: { path: 'src/app.ts', content: 'one' },
      }),
    ).toBe(first);

    // A different tool running somewhere else is a different action too.
    expect(
      actionDigest({
        sessionId: 's1',
        taskId: 't1',
        runEpoch: 2,
        toolCallId: 'call-1',
        tool: 'bash',
        args: { command: 'npm test', cwd: 'C:/elsewhere' },
      }),
    ).not.toBe(first);
  });

  it('refuses a write that escapes through a junction or symlink', async () => {
    // The plan names junction-escaped writes as a required case: a link
    // inside the workspace must not buy a write outside it.
    const outside = path.join(home, 'outside');
    await fs.promises.mkdir(outside, { recursive: true });
    await fs.promises.writeFile(path.join(outside, 'target.txt'), 'secret\n');
    const link = path.join(workspace, 'escape');
    // 'junction' needs no elevation on Windows; 'dir' elsewhere. A host that
    // cannot create the link must FAIL, not silently pass: a green suite that
    // skipped the escape case would be a lie about coverage.
    await fs.promises.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');

    const decision = decideToolCall(
      inWorkspace(
        call({
          scopes: [{ path: '', kind: 'directory', operations: ['create', 'modify'] }],
          args: { path: 'escape/target.txt', content: 'overwritten' },
        }),
      ),
    );

    // Denied outright: not merely "needs approval".
    expect(decision.allowed).toBe(false);
    expect(approvalRequired(decision)).toBe(false);
  });
});

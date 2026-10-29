import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { LedgerView } from '../../core/src/messages.js';
import { createFleetBranchAnalysisService } from '../src/fleet/branchAnalysis.js';
import { CloudControl, type CloudControlDeps } from '../src/fleet/cloudControl.js';
import type { FleetHubResponse } from '../src/fleet/hubClient.js';
import type { GitRunner } from '../src/ledger/git.js';
import { createGitRunner } from '../src/ledger/git.js';
import { runProcess } from '../src/ledger/processRunner.js';

let root = '';
const git = createGitRunner(runProcess);
let mergeTreeCalls = 0;

function sh(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Tester', '-c', 'user.email=test@example.com', ...args], {
    cwd,
    encoding: 'utf8',
  }).trim();
}

const cloudDeps: CloudControlDeps = {
  listConfigHomes: async () => [],
  run: async () => ({ code: 1, stdout: '', stderr: '' }),
  launcher: { file: 'instabox', args: [] },
  now: () => 1,
  forward: async () => ({ localPort: 40_001, alive: () => true, stop: () => undefined }),
};

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-branch-analysis-')).replace(/\\/g, '/');
  sh(root, 'init', '-q', '-b', 'main');
  sh(root, 'config', 'core.autocrlf', 'false');
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'value.ts'), 'const value = 1;\n');
  sh(root, 'add', '.');
  sh(root, 'commit', '-qm', 'base');
  const base = sh(root, 'rev-parse', 'HEAD');
  sh(root, 'update-ref', 'refs/remotes/origin/main', base);
  sh(root, 'switch', '-q', '-c', 'branch-a');
  fs.writeFileSync(path.join(root, 'src', 'value.ts'), 'const value = 2;\n');
  sh(root, 'commit', '-qam', 'branch A');
  sh(root, 'switch', '-q', 'main');
  sh(root, 'switch', '-q', '-c', 'branch-b');
  fs.writeFileSync(path.join(root, 'src', 'value.ts'), 'const value = 3;\n');
  sh(root, 'commit', '-qam', 'branch B');
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function ledgerView(): LedgerView {
  const branch = (name: string) => ({
    path: root,
    name,
    branch: name,
    head: sh(root, 'rev-parse', name),
    isMain: false,
    ahead: 1,
    behind: 0,
    dirtyCount: 0,
    dirtyFiles: [],
    merged: false,
    hasUpstream: true,
    unpushed: 0,
    lastCommitSubject: name,
    lastCommitAt: null,
    sessionIds: [],
  });
  return {
    generatedAt: 'stable',
    repos: [{ repo: root, name: 'repo', worktrees: [branch('branch-a'), branch('branch-b')] }],
  } as unknown as LedgerView;
}

function fleetResponse(): FleetHubResponse {
  return { now: 1, machines: [] };
}

describe('fleet branch analysis', () => {
  it('summarizes changed modules, finds shared files, and confirms merge-tree conflicts', async () => {
    const runner: GitRunner = {
      run: async (cwd, args, options) => {
        if (args[0] === 'merge-tree') mergeTreeCalls += 1;
        return git.run(cwd, args, options);
      },
    };
    const service = createFleetBranchAnalysisService();
    const deps = { git: runner, cloud: new CloudControl(cloudDeps) };
    const view = ledgerView();
    const response = fleetResponse();
    await new Promise<void>((resolve) => service.schedule(view, response, deps, resolve));

    const snapshot = service.getSnapshot();
    expect(snapshot.pending).toBe(false);
    expect(snapshot.pairs).toBe(1);
    expect(snapshot.conflicts).toBe(1);
    expect(snapshot.analyses).toEqual(expect.arrayContaining([
      expect.objectContaining({
        branch: 'branch-a',
        changedFileCount: 1,
        modules: [{ name: 'src', count: 1 }],
        overlaps: [{ branch: 'branch-b', files: ['src/value.ts'], mergeClean: false }],
        suggestion: 'Xử lý xung đột với nhánh branch-b',
      }),
      expect.objectContaining({
        branch: 'branch-b',
        overlaps: [{ branch: 'branch-a', files: ['src/value.ts'], mergeClean: false }],
      }),
    ]));

    const calls = mergeTreeCalls;
    service.schedule(view, response, deps);
    expect(mergeTreeCalls).toBe(calls);
  });
});

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ProjectBranchCompareRequestMessage } from '../../core/src/messages.js';
import { createGitRunner } from '../src/ledger/git.js';
import { runProcess } from '../src/ledger/processRunner.js';
import { compareProjectBranches } from '../src/projects/branchCompareEngine.js';
import { readCheckoutDiff } from '../src/projects/projectDiffEngine.js';

const git = createGitRunner(runProcess);
let root: string;
let repo: string;
let worktreeB: string;

function sh(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Tester', '-c', 'user.email=test@example.com', ...args], {
    cwd,
    encoding: 'utf8',
  }).trim();
}

function commit(cwd: string, file: string, content: string, subject: string): void {
  fs.writeFileSync(path.join(cwd, file), content);
  sh(cwd, 'add', file);
  sh(cwd, 'commit', '-qm', subject);
}

function request(branchA = 'branch-a', branchB = 'branch-b'): ProjectBranchCompareRequestMessage {
  return { type: 'projectBranchCompareRequest', requestId: 'r1', repo, branchA, branchB };
}

function deps() {
  return { git, knownRepos: [repo] };
}

// One repo for the whole file: the tests only read it, and building it costs ~17 git calls,
// which under a loaded full run overran the per-test timeout when it ran before every test.
beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'project-branch-compare-'));
  repo = path.join(root, 'repo').replace(/\\/g, '/');
  worktreeB = path.join(root, 'branch-b').replace(/\\/g, '/');
  fs.mkdirSync(repo);
  sh(repo, 'init', '-q', '-b', 'main');
  sh(repo, 'config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(repo, 'shared.txt'), 'base\n');
  fs.writeFileSync(path.join(repo, 'base-only.txt'), 'base\n');
  sh(repo, 'add', '.');
  sh(repo, 'commit', '-qm', 'base');
  sh(repo, 'switch', '-q', '-c', 'branch-a');
  commit(repo, 'a.txt', 'from A\n', 'A first');
  commit(repo, 'shared.txt', 'A version\n', 'A shared');
  sh(repo, 'switch', '-q', 'main');
  sh(repo, 'switch', '-q', '-c', 'branch-b');
  commit(repo, 'b.txt', 'from B\n', 'B first');
  commit(repo, 'shared.txt', 'B version\n', 'B shared');
  sh(repo, 'switch', '-q', 'branch-a');
  sh(repo, 'worktree', 'add', '-q', worktreeB, 'branch-b');
  fs.writeFileSync(path.join(worktreeB, 'dirty.txt'), 'uncommitted\n');
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('compareProjectBranches', () => {
  it('returns branch-exclusive commits newest first, worktree dirt, changed files and conflict sides', async () => {
    const result = await compareProjectBranches(request(), deps());

    expect(result.onlyA.map((commit) => commit.subject)).toEqual(['A shared', 'A first']);
    expect(result.onlyB.map((commit) => commit.subject)).toEqual(['B shared', 'B first']);
    expect(result.a.checkout).toBe(repo);
    expect(result.b.checkout).toBe(worktreeB);
    expect(result.b.dirtyFiles).toContainEqual({ path: 'dirty.txt', status: '??' });
    expect(result.files).toEqual(expect.arrayContaining([
      { path: 'a.txt', inA: true, inB: false, conflict: false },
      { path: 'b.txt', inA: false, inB: true, conflict: false },
      { path: 'shared.txt', inA: true, inB: true, conflict: true },
    ]));
    expect(result.mergeClean).toBe(false);
    expect(result.conflicts).toEqual([
      { file: 'shared.txt', hunks: [{ line: 1, ours: 'A version', theirs: 'B version' }] },
    ]);
  });

  it('keeps only the ours side when git writes conflicts in diff3 style', async () => {
    sh(repo, 'config', 'merge.conflictStyle', 'diff3');
    try {
      const result = await compareProjectBranches(request(), deps());
      expect(result.conflicts[0]?.hunks).toEqual([{ line: 1, ours: 'A version', theirs: 'B version' }]);
    } finally {
      // The repo is shared by the file's tests: the default style comes back for the next one.
      sh(repo, 'config', '--unset', 'merge.conflictStyle');
    }
  });

  it('reports clean for non-conflicting branches and rejects an unknown branch', async () => {
    const clean = await compareProjectBranches(request('main', 'branch-b'), deps());
    expect(clean.mergeClean).toBe(true);
    expect(clean.conflicts).toEqual([]);

    await expect(compareProjectBranches(request('branch-a', 'absent'), deps())).rejects.toThrow('Không tìm thấy nhánh absent');
  });

  it('reads a named branch against the checkout HEAD for compare diff scope', async () => {
    const result = await readCheckoutDiff({
      type: 'projectDiffRequest', requestId: 'd1', checkout: repo, scope: 'compare', sha: 'branch-b',
    }, { git, knownCheckouts: [repo] });
    expect(result.scope).toBe('compare');
    expect(result.files.map((file) => file.path)).toContain('b.txt');
    expect(result.files.find((file) => file.path === 'shared.txt')?.hunks[0]?.content).toContain('B version');
  });
});

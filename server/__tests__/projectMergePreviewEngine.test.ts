import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ProjectMergePreviewRequestMessage } from '../../core/src/messages.js';
import { createGitRunner } from '../src/ledger/git.js';
import { runProcess } from '../src/ledger/processRunner.js';
import { previewBranchMerge,PROJECT_MERGE_TEXT } from '../src/projects/projectMergePreviewEngine.js';

const git = createGitRunner(runProcess);
let root: string;
let repo: string;

function sh(...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: repo, encoding: 'utf8' }).trim();
}

function commitOn(branch: string, file: string, content: string): void {
  sh('switch', '-q', branch);
  fs.writeFileSync(path.join(repo, file), content);
  sh('add', file);
  sh('commit', '-qm', `${branch} ${file}`);
}

function request(branchA: string, branchB: string): ProjectMergePreviewRequestMessage {
  return { type: 'projectMergePreviewRequest', requestId: 'r1', repo, branchA, branchB };
}

const deps = () => ({ git, knownRepos: [repo] });

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'project-merge-'));
  repo = path.join(root, 'repo').replace(/\\/g, '/');
  fs.mkdirSync(repo);
  sh('init', '-q', '-b', 'main');
  sh('config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'mot\nhai\nba\n');
  fs.writeFileSync(path.join(repo, 'b.txt'), 'b\n');
  sh('add', '.');
  sh('commit', '-qm', 'base');
  sh('branch', 'left');
  sh('branch', 'right');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('previewBranchMerge', () => {
  it('reports clean when the branches change different files, without touching the worktree', async () => {
    commitOn('left', 'a.txt', 'mot\nhai trai\nba\n');
    commitOn('right', 'b.txt', 'b phai\n');
    const headBefore = sh('rev-parse', 'HEAD');
    const result = await previewBranchMerge(request('left', 'right'), deps());
    expect(result).toMatchObject({ clean: true, conflicts: [], branchA: 'left', branchB: 'right' });
    expect(result.reason).toBe(PROJECT_MERGE_TEXT.committedOnly);
    expect(sh('rev-parse', 'HEAD')).toBe(headBefore);
    expect(sh('status', '--porcelain')).toBe('');
  });

  it('lists each conflicted file once when both branches change the same lines', async () => {
    commitOn('left', 'a.txt', 'mot\nhai TRAI\nba\n');
    commitOn('left', 'b.txt', 'b trai\n');
    commitOn('right', 'a.txt', 'mot\nhai PHAI\nba\n');
    commitOn('right', 'b.txt', 'b phai\n');
    const result = await previewBranchMerge(request('left', 'right'), deps());
    expect(result.clean).toBe(false);
    expect(result.conflicts.sort()).toEqual(['a.txt', 'b.txt']);
  });

  it('refuses option-like or malformed names, the same branch twice, unknown branches and repos', async () => {
    await expect(previewBranchMerge(request('--output=x', 'right'), deps())).rejects.toThrow(PROJECT_MERGE_TEXT.badBranch);
    await expect(previewBranchMerge(request('left..right', 'right'), deps())).rejects.toThrow(PROJECT_MERGE_TEXT.badBranch);
    await expect(previewBranchMerge(request('left', 'left'), deps())).rejects.toThrow(PROJECT_MERGE_TEXT.sameBranch);
    await expect(previewBranchMerge(request('left', 'khong-co'), deps())).rejects.toThrow(
      PROJECT_MERGE_TEXT.missingBranch('khong-co'),
    );
    await expect(previewBranchMerge(request('left', 'right'), { git, knownRepos: [] })).rejects.toThrow(
      PROJECT_MERGE_TEXT.unknownRepo,
    );
  });
});

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ProjectDiffRequestMessage } from '../../core/src/messages.js';
import { createGitRunner } from '../src/ledger/git.js';
import type { EventRow, SessionRow } from '../src/ledger/ledgerDb.js';
import { runProcess } from '../src/ledger/processRunner.js';
import { PROJECT_DIFF_TEXT, readCheckoutDiff } from '../src/projects/projectDiffEngine.js';

const git = createGitRunner(runProcess);
let root: string;
let repo: string;

function sh(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.autocrlf=false', ...args], {
    cwd,
    encoding: 'utf8',
  }).trim();
}

function write(file: string, content: string | Buffer): void {
  fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  fs.writeFileSync(path.join(repo, file), content);
}

function request(scope: ProjectDiffRequestMessage['scope'], sha = ''): ProjectDiffRequestMessage {
  return { type: 'projectDiffRequest', requestId: 'r1', checkout: repo, scope, sha };
}

const deps = (extra: object = {}) => ({ git, knownCheckouts: [repo], ...extra });

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'project-diff-'));
  repo = path.join(root, 'repo').replace(/\\/g, '/');
  fs.mkdirSync(repo);
  sh(repo, 'init', '-q', '-b', 'main');
  sh(repo, 'config', 'core.autocrlf', 'false');
  write('keep.txt', 'mot\nhai\nba\n');
  write('gone.txt', 'se bi xoa\n');
  write('old-name.txt', 'noi dung du dai de git nhan ra doi ten\n'.repeat(5));
  sh(repo, 'add', '.');
  sh(repo, 'commit', '-qm', 'base');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('readCheckoutDiff: uncommitted', () => {
  it('lists modified, deleted, renamed, new and binary files with counts and hunks', async () => {
    write('keep.txt', 'mot\nHAI\nba\nbon\n');
    fs.rmSync(path.join(repo, 'gone.txt'));
    sh(repo, 'mv', 'old-name.txt', 'new-name.txt');
    write('moi/tệp-mới.ts', 'export const a = 1;\nexport const b = 2;\n');
    write('anh.bin', Buffer.from([0, 1, 2, 0, 255, 0]));

    const diff = await readCheckoutDiff(request('uncommitted'), deps());
    const byPath = new Map(diff.files.map((file) => [file.path, file]));

    expect(diff.truncated).toBe(false);
    expect(byPath.get('keep.txt')).toMatchObject({ status: 'modified', additions: 2, deletions: 1 });
    expect(byPath.get('keep.txt')?.hunks[0].header).toMatch(/^@@ -1,3 \+1,4 @@/);
    expect(byPath.get('gone.txt')).toMatchObject({ status: 'deleted', additions: 0, deletions: 1 });
    expect(byPath.get('new-name.txt')).toMatchObject({ status: 'renamed', oldPath: 'old-name.txt' });
    // Non-ASCII path printed as-is (core.quotePath=false), untracked file counted as added.
    expect(byPath.get('moi/tệp-mới.ts')).toMatchObject({ status: 'added', additions: 2, deletions: 0 });
    expect(byPath.get('anh.bin')).toMatchObject({ status: 'binary', hunks: [] });
  });

  it('refuses a checkout the Project tree does not show, before running git', async () => {
    await expect(readCheckoutDiff(request('uncommitted'), { git, knownCheckouts: [] })).rejects.toThrow(
      PROJECT_DIFF_TEXT.unknownCheckout,
    );
  });

  it('marks the result truncated and drops the cut-off file when the byte budget is hit', async () => {
    write('keep.txt', 'x\n'.repeat(5000));
    write('gone.txt', 'y\n'.repeat(5000));
    const diff = await readCheckoutDiff(request('uncommitted'), deps({ maxBytes: 12_000 }));
    expect(diff.truncated).toBe(true);
    expect(diff.reason).toBe(PROJECT_DIFF_TEXT.truncated);
    for (const file of diff.files) expect(file.additions + file.deletions).toBeGreaterThan(0);
    expect(diff.files.length).toBeLessThan(2);
  });

  it('names the sessions that edited each file, newest first', async () => {
    write('keep.txt', 'doi\n');
    const at = (ts: string, sessionId: string): EventRow => ({
      id: 1, ts, sessionId, kind: 'edit', tool: 'edit', path: `${repo}/keep.txt`, pathKey: null,
      repo, checkout: repo, isMainCheckout: true, branch: 'main', intent: null,
    });
    const session = (sessionId: string, agentKind: string): SessionRow => ({
      sessionId, pid: null, cwd: repo, agentKind, agentName: null, parentId: null, startedAt: null,
      lastSeen: null, endedAt: null, state: null, heartbeat: null,
    });
    const diff = await readCheckoutDiff(request('uncommitted'), deps({
      events: [at('2026-10-20 10:00:00', 'omp-session-aaaa1111'), at('2026-10-20 11:00:00', 'cla-session-bbbb2222')],
      sessions: [session('omp-session-aaaa1111', 'main'), session('cla-session-bbbb2222', 'claude')],
    }));
    expect(diff.files.find((file) => file.path === 'keep.txt')?.author).toBe('claude …bbbb2222, omp …aaaa1111');
  });
});

describe('readCheckoutDiff: branch and commit scopes', () => {
  it('branch scope shows committed and uncommitted work since the branch left main', async () => {
    const base = sh(repo, 'rev-parse', 'HEAD');
    sh(repo, 'switch', '-q', '-c', 'feat');
    write('feat.txt', 'tinh nang\n');
    sh(repo, 'add', 'feat.txt');
    sh(repo, 'commit', '-qm', 'feat');
    write('keep.txt', 'mot\nhai\nba\nsua chua commit\n');

    const diff = await readCheckoutDiff(request('branch'), deps());
    expect(diff.sha).toBe(base);
    expect(diff.files.map((file) => file.path).sort()).toEqual(['feat.txt', 'keep.txt']);
  });

  it('branch scope prefers the main ref whose branch point is closer to HEAD', async () => {
    // origin/main is stale: local main moved on and the branch started from the newer main.
    sh(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    write('main-moi.txt', 'main tien len\n');
    sh(repo, 'add', 'main-moi.txt');
    sh(repo, 'commit', '-qm', 'main moves');
    const newer = sh(repo, 'rev-parse', 'HEAD');
    sh(repo, 'switch', '-q', '-c', 'feat');
    write('feat.txt', 'tinh nang\n');
    sh(repo, 'add', 'feat.txt');
    sh(repo, 'commit', '-qm', 'feat');

    const diff = await readCheckoutDiff(request('branch'), deps());
    expect(diff.sha).toBe(newer);
    expect(diff.files.map((file) => file.path)).toEqual(['feat.txt']);
  });

  it('commit scope shows only that commit, works on the root commit and rejects bad shas', async () => {
    const rootSha = sh(repo, 'rev-parse', 'HEAD');
    write('keep.txt', 'mot\nhai\nba\nbon\n');
    sh(repo, 'commit', '-qam', 'second');
    const second = sh(repo, 'rev-parse', 'HEAD');
    write('gone.txt', 'chua commit\n');

    const one = await readCheckoutDiff(request('commit', second), deps());
    expect(one.files.map((file) => file.path)).toEqual(['keep.txt']);
    const first = await readCheckoutDiff(request('commit', rootSha), deps());
    expect(first.files.map((file) => file.status)).toEqual(['added', 'added', 'added']);
    await expect(readCheckoutDiff(request('commit', '--output=x'), deps())).rejects.toThrow(PROJECT_DIFF_TEXT.badSha);
    await expect(readCheckoutDiff(request('commit', 'deadbeef'), deps())).rejects.toThrow(PROJECT_DIFF_TEXT.missingCommit);
  });
});

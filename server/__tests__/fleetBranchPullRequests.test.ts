import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  createFleetPullRequestLookup,
  parseGitHubPullRequest,
  runFleetBranchAction,
} from '../src/fleet/branchPullRequests.js';
import type { ProcessResult, ProcessRunner } from '../src/ledger/processRunner.js';
import { runProcess } from '../src/ledger/processRunner.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function repository() {
  const root = mkdtempSync(join(tmpdir(), 'fleet-pr-actions-'));
  const checkout = join(root, 'checkout');
  const origin = join(root, 'origin.git');
  mkdirSync(checkout);
  git(root, 'init', '--bare', '-q', origin);
  git(checkout, 'init', '-q', '-b', 'main');
  writeFileSync(join(checkout, 'README.md'), 'base\n');
  git(checkout, 'add', '.');
  git(checkout, 'commit', '-qm', 'base commit');
  git(checkout, 'remote', 'add', 'origin', origin);
  git(checkout, 'push', '-qu', 'origin', 'main');
  git(checkout, 'switch', '-q', '-c', 'feature/task');
  writeFileSync(join(checkout, 'work.txt'), 'feature\n');
  git(checkout, 'add', '.');
  git(checkout, 'commit', '-qm', 'feature work');
  return { root, checkout, origin };
}

describe('fleet branch actions', () => {
  it('pushes only the selected work branch to its bare origin', async () => {
    const repo = repository();
    try {
      const output = await runFleetBranchAction({ action: 'push', checkout: repo.checkout, branch: 'feature/task' });
      expect(output).toEqual({ ok: true });
      expect(git(repo.origin, 'show-ref', '--verify', 'refs/heads/feature/task')).not.toBe('');
      expect(git(repo.checkout, 'for-each-ref', '--format=%(upstream:short)', 'refs/heads/feature/task')).toBe('origin/feature/task');
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  });

  it('does not interpret a plus-prefixed branch as a force push to its sibling', async () => {
    const repo = repository();
    try {
      git(repo.checkout, 'switch', '-q', 'main');
      writeFileSync(join(repo.checkout, 'remote.txt'), 'remote branch change\n');
      git(repo.checkout, 'add', '.');
      git(repo.checkout, 'commit', '-qm', 'remote branch change');
      git(repo.checkout, 'push', '-q', 'origin', 'HEAD:refs/heads/feature/task');
      const remoteBefore = git(repo.origin, 'rev-parse', 'refs/heads/feature/task');
      git(repo.checkout, 'switch', '-q', 'feature/task');
      git(repo.checkout, 'switch', '-q', '-c', '+feature/task');

      const output = await runFleetBranchAction({
        action: 'push',
        checkout: repo.checkout,
        branch: '+feature/task',
      });

      expect(output).toEqual({ ok: true });
      expect(git(repo.origin, 'rev-parse', 'refs/heads/feature/task')).toBe(remoteBefore);
      expect(git(repo.origin, 'show-ref', '--verify', 'refs/heads/+feature/task')).not.toBe('');
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  });

  it.each(['main', 'staging'])('refuses protected branch %s before running commands', async (branch) => {
    const calls: string[][] = [];
    const run: ProcessRunner = async (_file, args) => {
      calls.push([...args]);
      return result('');
    };
    const output = await runFleetBranchAction({ action: 'push', checkout: '/not-a-repo', branch }, { run });
    expect(output.ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it('creates a draft PR with commit subjects and the matching OpenSpec proposal using gh argv', async () => {
    const repo = repository();
    try {
      git(repo.checkout, 'remote', 'set-url', 'origin', 'git@github.com:org/repo.git');
      const proposalFolder = join(repo.checkout, 'openspec', 'changes', 'task');
      mkdirSync(proposalFolder, { recursive: true });
      writeFileSync(join(proposalFolder, 'proposal.md'), '# Proposal\n\nAdd the branch flow.\n');
      const calls: Array<{ file: string; args: string[] }> = [];
      const run: ProcessRunner = async (file, args, options) => {
        calls.push({ file, args: [...args] });
        return file === 'gh' ? result('') : runProcess(file, args, options);
      };

      const output = await runFleetBranchAction({
        action: 'create-draft',
        checkout: repo.checkout,
        branch: 'feature/task',
      }, { run });
      const gh = calls.find((call) => call.file === 'gh');
      const bodyIndex = gh?.args.indexOf('--body') ?? -1;
      const body = bodyIndex < 0 ? '' : gh?.args[bodyIndex + 1] ?? '';
      expect(output).toEqual({ ok: true });
      expect(gh?.args).toEqual(expect.arrayContaining([
        'pr', 'create', '--draft', '--base', 'main', '--head', 'feature/task', '--repo', 'org/repo',
      ]));
      expect(body).toContain('feature work');
      expect(body).toContain('# Proposal');
      expect(body).toContain('Add the branch flow.');
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  });

  it('marks a draft ready and deletes a remote branch only after the PR is closed', async () => {
    const repo = repository();
    try {
      git(repo.checkout, 'remote', 'set-url', 'origin', 'git@github.com:org/repo.git');
      const calls: Array<{ file: string; args: string[] }> = [];
      let prStates = ['CLOSED', 'OPEN'];
      let malformedOpenQuery = false;
      const run: ProcessRunner = async (file, args, options) => {
        calls.push({ file, args: [...args] });
        if (file === 'gh' && args[1] === 'list') {
          const requestedState = args[args.indexOf('--state') + 1];
          if (requestedState === 'open' && malformedOpenQuery) return result('not json');
          const matches = requestedState === 'open' ? prStates.filter((state) => state === 'OPEN') : prStates;
          return result(JSON.stringify(matches.map((state) => ({ state }))));
        }
        if (file === 'gh' || (file === 'git' && args[0] === 'push')) return result('');
        return runProcess(file, args, options);
      };
      const input = { checkout: repo.checkout, branch: 'feature/task' };
      expect(await runFleetBranchAction({ ...input, action: 'ready' }, { run })).toEqual({ ok: true });
      expect((await runFleetBranchAction({ ...input, action: 'delete-remote' }, { run })).ok).toBe(false);
      expect(calls.some((call) => call.file === 'gh' && call.args[1] === 'ready')).toBe(true);
      expect(calls.some((call) => call.file === 'git' && call.args[0] === 'push')).toBe(false);

      prStates = ['CLOSED'];
      malformedOpenQuery = true;
      expect((await runFleetBranchAction({ ...input, action: 'delete-remote' }, { run })).ok).toBe(false);
      expect(calls.some((call) => call.file === 'git' && call.args[0] === 'push')).toBe(false);

      malformedOpenQuery = false;
      expect(await runFleetBranchAction({ ...input, action: 'delete-remote' }, { run })).toEqual({ ok: true });
      expect(calls.find((call) => call.file === 'git' && call.args[0] === 'push')?.args)
        .toEqual(['push', 'origin', '--delete', 'feature/task']);
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  });
});
function result(stdout: string, ok = true): ProcessResult {
  return { ok, code: ok ? 0 : 1, stdout, stderr: '', timedOut: false, truncated: false };
}

const prJson = JSON.stringify([
  {
    number: 42,
    state: 'OPEN',
    isDraft: true,
    reviewDecision: 'CHANGES_REQUESTED',
    url: 'https://github.com/org/repo/pull/42',
    statusCheckRollup: [
      { __typename: 'CheckRun', name: 'lint', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'https://github.com/org/repo/actions/runs/1' },
      { __typename: 'StatusContext', context: 'typecheck', state: 'SUCCESS', targetUrl: 'https://example.test/check' },
    ],
  },
]);

describe('fleet pull request lookup', () => {
  it('parses PR state and failing CI from gh JSON', () => {
    expect(parseGitHubPullRequest(prJson)).toEqual({
      number: 42,
      state: 'open',
      isDraft: true,
      reviewDecision: 'CHANGES_REQUESTED',
      url: 'https://github.com/org/repo/pull/42',
      ci: 'red',
      failedChecks: ['lint'],
    });
  });

  it('single-flights the same repo/branch and caches results for 75 seconds', async () => {
    let now = 1_000;
    const calls: string[][] = [];
    const run = async (_file: string, args: readonly string[]): Promise<ProcessResult> => {
      calls.push([...args]);
      return result(prJson);
    };
    const lookup = createFleetPullRequestLookup({ run, now: () => now });
    const query = { repo: 'org/repo', branch: 'feature/task' };

    const [first, concurrent] = await Promise.all([
      lookup.lookupMany([query]),
      lookup.lookupMany([query]),
    ]);
    expect(first).toEqual([expect.objectContaining({ number: 42 })]);
    expect(concurrent).toEqual(first);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([
      'pr', 'list', '--head', 'feature/task', '--state', 'all', '--limit', '1',
      '--json', 'number,state,isDraft,reviewDecision,url,statusCheckRollup', '--repo', 'org/repo',
    ]);

    now += 74_999;
    await lookup.lookupMany([query]);
    expect(calls).toHaveLength(1);
    now += 1;
    await lookup.lookupMany([query]);
    expect(calls).toHaveLength(2);
  });

  it('bounds gh calls to twelve unique branches per lookup cycle and ignores command errors', async () => {
    let calls = 0;
    const lookup = createFleetPullRequestLookup({
      run: async () => {
        calls += 1;
        return result('', false);
      },
      now: () => 0,
    });
    const queries = Array.from({ length: 20 }, (_, index) => ({ repo: 'org/repo', branch: `branch-${index}` }));

    expect(await lookup.lookupMany(queries)).toEqual(Array(20).fill(null));
    expect(calls).toBe(12);
  });
});

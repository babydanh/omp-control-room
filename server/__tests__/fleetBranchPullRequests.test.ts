import { describe, expect, it } from 'vitest';

import { createFleetPullRequestLookup, parseGitHubPullRequest } from '../src/fleet/branchPullRequests.js';
import type { ProcessResult } from '../src/ledger/processRunner.js';

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

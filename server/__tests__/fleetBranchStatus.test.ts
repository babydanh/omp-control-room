import { describe, expect, it } from 'vitest';

import type { LedgerView } from '../../core/src/messages.js';
import { collectFleetBranchPullRequests } from '../src/fleet/fleetBranchStatus.js';
import type { FleetHubResponse } from '../src/fleet/hubClient.js';
import type { ProcessResult } from '../src/ledger/processRunner.js';

const pullRequest = {
  number: 42,
  state: 'open' as const,
  isDraft: false,
  reviewDecision: null,
  url: 'https://github.com/org/repo/pull/42',
  ci: 'green' as const,
  failedChecks: [],
};

function ok(stdout: string): ProcessResult {
  return { ok: true, code: 0, stdout, stderr: '', timedOut: false, truncated: false };
}

describe('fleet branch PR enrichment', () => {
  it('looks up local and reported cloud branches by their GitHub origin and keeps checkout sessions', async () => {
    const gitCalls: string[][] = [];
    const queryCalls: { repo: string; branch: string }[][] = [];
    const local = {
      repos: [{
        repo: 'C:/work/repo',
        name: 'repo',
        worktrees: [{
          path: 'C:/work/repo/.worktrees/local',
          name: 'local',
          branch: 'feature/local',
          head: 'a'.repeat(40),
          isMain: false,
          ahead: 3,
          behind: 1,
          dirtyCount: 0,
          dirtyFiles: [],
          merged: false,
          hasUpstream: true,
          unpushed: 3,
          lastCommitSubject: 'work',
          lastCommitAt: null,
          sessionIds: ['session-open', 'session-ended'],
        }],
      }],
      sessions: [
        { sessionId: 'session-open', open: true },
        { sessionId: 'session-ended', open: false },
      ],
    } as unknown as LedgerView;
    const fleet = {
      machines: [{
        agent_id: 'cloud-a',
        repos: [{ path: '/data/home/wt/repo-task', repo: 'repo', github_repo: 'org/repo', branch: 'cloud/task', ahead: 5, behind: 2, dirty_files: [] }],
      }],
    } as unknown as FleetHubResponse;

    const result = await collectFleetBranchPullRequests(local, fleet, {
      git: {
        run: async (_cwd, args) => {
          gitCalls.push([...args]);
          return ok('git@github.com:org/repo.git');
        },
      },
      pullRequests: {
        lookupMany: async (queries) => {
          queryCalls.push([...queries]);
          return queries.map(() => pullRequest);
        },
      },
    });

    expect(gitCalls).toEqual([['remote', 'get-url', 'origin']]);
    expect(queryCalls).toEqual([[
      { repo: 'org/repo', branch: 'feature/local' },
      { repo: 'org/repo', branch: 'cloud/task' },
    ]]);
    expect(result.localBranches).toEqual([{
      repo: 'repo',
      checkout: 'C:/work/repo/.worktrees/local',
      branch: 'feature/local',
      ahead: 3,
      behind: 1,
      sessionIds: ['session-open'],
      pullRequest,
    }]);
    expect(result.cloudBranches).toEqual([{
      machine: 'cloud-a',
      path: '/data/home/wt/repo-task',
      branch: 'cloud/task',
      pullRequest,
    }]);
  });
});

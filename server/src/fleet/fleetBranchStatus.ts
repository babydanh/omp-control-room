import type { FleetLocalBranchSnapshot, FleetPullRequest, LedgerView } from '../../../core/src/messages.js';
import type { GitRunner } from '../ledger/git.js';
import { type FleetPullRequestLookup, type FleetPullRequestQuery,githubRepositoryFromOrigin } from './branchPullRequests.js';
import type { FleetHubResponse } from './hubClient.js';

const ORIGIN_OPTIONS = { timeoutMs: 5_000, okCodes: [0], maxBytes: 4_096 } as const;

export interface FleetCloudPullRequestStatus {
  readonly machine: string;
  readonly path: string;
  readonly branch: string;
  readonly pullRequest: FleetPullRequest;
}

export interface FleetBranchPullRequestSnapshot {
  readonly localBranches: FleetLocalBranchSnapshot[];
  readonly cloudBranches: FleetCloudPullRequestStatus[];
}

export interface FleetBranchPullRequestDeps {
  readonly git: GitRunner;
  readonly pullRequests: FleetPullRequestLookup;
}

/** Join local and fleet branch metadata to cached GitHub PR state without exposing remote URLs. */
export async function collectFleetBranchPullRequests(
  localView: LedgerView | null,
  response: FleetHubResponse,
  deps: FleetBranchPullRequestDeps,
): Promise<FleetBranchPullRequestSnapshot> {
  const localRows: { snapshot: FleetLocalBranchSnapshot; query?: FleetPullRequestQuery }[] = [];
  const cloudRows: { machine: string; path: string; branch: string; query?: FleetPullRequestQuery }[] = [];
  const queries: FleetPullRequestQuery[] = [];
  const originByRepo = new Map<string, Promise<string | null>>();
  const openSessions = new Set((localView?.sessions ?? []).filter((session) => session.open).map((session) => session.sessionId));

  for (const repo of localView?.repos ?? []) {
    let origin = originByRepo.get(repo.repo);
    if (origin === undefined) {
      origin = readOrigin(repo.repo, deps.git);
      originByRepo.set(repo.repo, origin);
    }
    const githubRepo = githubRepositoryFromOrigin((await origin) ?? '');
    for (const worktree of repo.worktrees) {
      if (worktree.branch === null || worktree.branch === '') continue;
      const query = githubRepo === null ? undefined : { repo: githubRepo, branch: worktree.branch };
      const snapshot: FleetLocalBranchSnapshot = {
        repo: repo.name,
        checkout: worktree.path,
        branch: worktree.branch,
        ahead: worktree.ahead,
        behind: worktree.behind,
        sessionIds: worktree.sessionIds.filter((sessionId) => openSessions.has(sessionId)),
      };
      localRows.push({ snapshot, ...(query === undefined ? {} : { query }) });
      if (query !== undefined) queries.push(query);
    }
  }

  for (const machine of response.machines) {
    for (const repo of machine.repos) {
      if (repo.branch.trim() === '') continue;
      const githubRepo = typeof repo.github_repo === 'string' ? repo.github_repo : '';
      const query = githubRepo === '' ? undefined : { repo: githubRepo, branch: repo.branch };
      cloudRows.push({
        machine: machine.agent_id,
        path: repo.path,
        branch: repo.branch,
        ...(query === undefined ? {} : { query }),
      });
      if (query !== undefined) queries.push(query);
    }
  }

  const results = await deps.pullRequests.lookupMany(queries);
  let resultIndex = 0;
  const localBranches = localRows.map(({ snapshot, query }) => {
    if (query === undefined) return snapshot;
    const pullRequest = results[resultIndex++] ?? null;
    return pullRequest === null ? snapshot : { ...snapshot, pullRequest };
  });
  const cloudBranches = cloudRows.flatMap(({ machine, path, branch, query }) => {
    if (query === undefined) return [];
    const pullRequest = results[resultIndex++] ?? null;
    return pullRequest === null ? [] : [{ machine, path, branch, pullRequest }];
  });
  return { localBranches, cloudBranches };
}

async function readOrigin(repo: string, git: GitRunner): Promise<string | null> {
  try {
    const result = await git.run(repo, ['remote', 'get-url', 'origin'], ORIGIN_OPTIONS);
    return result.ok && !result.truncated && result.stdout.trim() !== '' ? result.stdout.trim() : null;
  } catch {
    return null;
  }
}

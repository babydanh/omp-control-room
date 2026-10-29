import type { FleetPullRequest } from '../../../core/src/messages.js';
import { isRecord } from '../company/typeGuards.js';
import type { ProcessResult, ProcessRunner } from '../ledger/processRunner.js';
import { runProcess } from '../ledger/processRunner.js';

export const FLEET_PR_CACHE_MS = 75_000;
export const FLEET_PR_MAX_CALLS_PER_CYCLE = 12;
const GH_TIMEOUT_MS = 10_000;
const GH_MAX_BYTES = 64 * 1024;
const GH_FIELDS = 'number,state,isDraft,reviewDecision,url,statusCheckRollup';
const CHECK_FAILURES: Record<string, true> = {
  ACTION_REQUIRED: true,
  CANCELLED: true,
  FAILURE: true,
  STARTUP_FAILURE: true,
  TIMED_OUT: true,
};
const CHECK_SUCCESSES: Record<string, true> = { NEUTRAL: true, SKIPPED: true, SUCCESS: true };
const CHECK_RUNNING: Record<string, true> = {
  EXPECTED: true,
  IN_PROGRESS: true,
  PENDING: true,
  QUEUED: true,
  REQUESTED: true,
  WAITING: true,
};

export type FleetCiState = FleetPullRequest['ci'];

export interface FleetPullRequestQuery {
  readonly repo: string;
  readonly branch: string;
}

export interface FleetPullRequestOptions {
  readonly run?: ProcessRunner;
  readonly now?: () => number;
  readonly maxCallsPerCycle?: number;
}

export interface FleetPullRequestLookup {
  lookupMany(queries: readonly FleetPullRequestQuery[]): Promise<(FleetPullRequest | null)[]>;
}

/** Accepts GitHub's HTTPS, SSH URL, and scp-style origin forms, returning gh's HOST/OWNER/REPO form. */
export function githubRepositoryFromOrigin(origin: string): string | null {
  const text = origin.trim();
  const scp = /^(?:[^@/:]+@)?([^/:]+):([^/]+)\/([^/]+?)(?:\.git)?$/.exec(text);
  const url = scp === null ? parseOriginUrl(text) : null;
  const host = scp?.[1] ?? url?.host;
  const owner = scp?.[2] ?? url?.owner;
  const repository = scp?.[3] ?? url?.repository;
  if (host === undefined || owner === undefined || repository === undefined) return null;
  if (!/^[A-Za-z0-9.-]+$/.test(host) || !/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repository)) return null;
  return host.toLowerCase() === 'github.com' ? `${owner}/${repository}` : `${host}/${owner}/${repository}`;
}

function parseOriginUrl(origin: string): { host: string; owner: string; repository: string } | null {
  try {
    const url = new URL(origin);
    if (url.protocol !== 'https:' && url.protocol !== 'ssh:') return null;
    const [owner, repository, extra] = url.pathname.replace(/^\/+/, '').split('/');
    if (owner === undefined || repository === undefined || extra !== undefined) return null;
    return { host: url.host, owner, repository: repository.replace(/\.git$/, '') };
  } catch {
    return null;
  }
}

function checkedQuery(query: FleetPullRequestQuery): FleetPullRequestQuery | null {
  const branch = query.branch.trim();
  if (
    !/^(?:[A-Za-z0-9.-]+\/)?[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(query.repo) ||
    branch.length === 0 || branch.length > 255 || branch.startsWith('-') || branch.includes('..') ||
    /[\s\0~^:?*[\\]/.test(branch) || branch.endsWith('/') || branch.endsWith('.')
  ) return null;
  return { repo: query.repo, branch };
}

function queryKey(query: FleetPullRequestQuery): string {
  return `${query.repo.toLowerCase()}\0${query.branch}`;
}

function commandArgs(query: FleetPullRequestQuery): string[] {
  return [
    'pr', 'list', '--head', query.branch, '--state', 'all', '--limit', '1',
    '--json', GH_FIELDS, '--repo', query.repo,
  ];
}

/** Read one branch's latest PR; failed or missing gh commands intentionally resolve to no badge. */
export function createFleetPullRequestLookup(options: FleetPullRequestOptions = {}): FleetPullRequestLookup {
  const run = options.run ?? runProcess;
  const now = options.now ?? Date.now;
  const maxCallsPerCycle = options.maxCallsPerCycle ?? FLEET_PR_MAX_CALLS_PER_CYCLE;
  const cache = new Map<string, { readonly expiresAt: number; readonly value: FleetPullRequest | null }>();
  const inFlight = new Map<string, Promise<FleetPullRequest | null>>();

  async function queryGh(query: FleetPullRequestQuery): Promise<FleetPullRequest | null> {
    try {
      const result: ProcessResult = await run('gh', commandArgs(query), {
        timeoutMs: GH_TIMEOUT_MS,
        okCodes: [0],
        maxBytes: GH_MAX_BYTES,
      });
      if (!result.ok || result.timedOut || result.truncated) return null;
      return parseGitHubPullRequest(result.stdout);
    } catch {
      return null;
    }
  }

  function lookupMany(queries: readonly FleetPullRequestQuery[]): Promise<(FleetPullRequest | null)[]> {
    let launched = 0;
    const byKey = new Map<string, Promise<FleetPullRequest | null>>();
    for (const raw of queries) {
      const query = checkedQuery(raw);
      if (query === null) continue;
      const key = queryKey(query);
      if (byKey.has(key)) continue;
      const cached = cache.get(key);
      if (cached !== undefined && cached.expiresAt > now()) {
        byKey.set(key, Promise.resolve(cached.value));
        continue;
      }
      const current = inFlight.get(key);
      if (current !== undefined) {
        byKey.set(key, current);
        continue;
      }
      if (launched >= maxCallsPerCycle) {
        byKey.set(key, Promise.resolve(null));
        continue;
      }
      launched += 1;
      const pending = queryGh(query).then((value) => {
        cache.set(key, { expiresAt: now() + FLEET_PR_CACHE_MS, value });
        return value;
      }).finally(() => {
        if (inFlight.get(key) === pending) inFlight.delete(key);
      });
      inFlight.set(key, pending);
      byKey.set(key, pending);
    }
    return Promise.all(queries.map((raw) => {
      const query = checkedQuery(raw);
      return query === null ? null : byKey.get(queryKey(query)) ?? Promise.resolve(null);
    }));
  }

  return { lookupMany };
}

/** Parses the exact JSON fields requested from `gh pr list`. */
export function parseGitHubPullRequest(stdout: string): FleetPullRequest | null {
  let payload: unknown;
  try {
    payload = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!Array.isArray(payload) || payload.length === 0) return null;
  const first: unknown = payload[0];
  if (!isRecord(first) || typeof first.number !== 'number' || !Number.isSafeInteger(first.number) || first.number < 1) return null;
  const state = first.state === 'OPEN' ? 'open' : first.state === 'MERGED' ? 'merged' : first.state === 'CLOSED' ? 'closed' : null;
  const url = checkedPullRequestUrl(first.url);
  if (state === null || url === null) return null;
  const checks = Array.isArray(first.statusCheckRollup) ? first.statusCheckRollup.filter(isRecord) : [];
  const failedChecks = checks.flatMap((check) => {
    const state = checkState(check);
    if (state !== 'red') return [];
    const name = typeof check.name === 'string' ? check.name : typeof check.context === 'string' ? check.context : 'Kiểm tra CI';
    return [name.slice(0, 160)];
  }).slice(0, 20);
  const ci = failedChecks.length > 0
    ? 'red'
    : checks.some((check) => checkState(check) === 'running')
      ? 'running'
      : checks.length > 0 && checks.every((check) => checkState(check) === 'green')
        ? 'green'
        : 'none';
  const reviewDecision = typeof first.reviewDecision === 'string' && ['APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED'].includes(first.reviewDecision)
    ? first.reviewDecision
    : null;
  return {
    number: first.number,
    state,
    isDraft: first.isDraft === true,
    reviewDecision,
    url,
    ci,
    failedChecks,
  };
}

function checkState(check: Record<string, unknown>): FleetCiState {
  const conclusion = typeof check.conclusion === 'string' ? check.conclusion.toUpperCase() : '';
  const state = typeof check.state === 'string' ? check.state.toUpperCase() : '';
  const status = typeof check.status === 'string' ? check.status.toUpperCase() : '';
  if (CHECK_FAILURES[conclusion] === true || state === 'FAILURE' || state === 'ERROR') return 'red';
  if (CHECK_RUNNING[status] === true || CHECK_RUNNING[state] === true) return 'running';
  if (CHECK_SUCCESSES[conclusion] === true || state === 'SUCCESS') return 'green';
  return 'none';
}

function checkedPullRequestUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}


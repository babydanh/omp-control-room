import type { FleetBranchAnalysis, FleetBranchOverlap, LedgerView } from '../../../core/src/messages.js';
import type { GitRunner } from '../ledger/git.js';
import { compareProjectBranches } from '../projects/branchCompareEngine.js';
import { githubRepositoryFromOrigin } from './branchPullRequests.js';
import type { CloudControl } from './cloudControl.js';
import { FLEET_STALE_AFTER_MS } from './constants.js';
import type { FleetHubResponse } from './hubClient.js';

const BASE_REF = 'origin/main';
const SHA_PATTERN = /^[0-9a-f]{40,64}$/i;
const GIT_OPTIONS = { timeoutMs: 5_000, okCodes: [0], maxBytes: 4_096 } as const;
const MAX_BRANCHES_PER_CYCLE = 12;
const MAX_PAIR_COMPARISONS = 20;
const MAX_CACHED_ANALYSES = 128;
const BRANCH_CONCURRENCY = 3;

export interface FleetBranchAnalysisSnapshot {
  readonly analyses: FleetBranchAnalysis[];
  readonly pending: boolean;
  readonly pairs: number;
  readonly conflicts: number;
}

export interface FleetBranchAnalysisDeps {
  readonly git: GitRunner;
  readonly cloud: CloudControl;
}

export interface FleetBranchAnalysisService {
  getSnapshot(): FleetBranchAnalysisSnapshot;
  schedule(
    localView: LedgerView | null,
    response: FleetHubResponse,
    deps: FleetBranchAnalysisDeps,
    onComplete?: () => void,
  ): void;
}

interface BranchCandidate {
  readonly id: string;
  readonly repoKey: string;
  readonly repo: string;
  readonly repoPath: string;
  readonly branch: string;
  readonly head?: string;
  readonly originMain?: string;
  readonly dirtyFiles: readonly string[];
  readonly ahead: number;
  readonly unpushed: number | null;
  readonly checkout?: string;
  readonly machine?: string;
  readonly path?: string;
  readonly git?: GitRunner;
}

interface BranchFiles {
  readonly head: string;
  readonly base: string;
  readonly committedFiles: readonly string[];
}

interface AnalyzedBranch {
  readonly candidate: BranchCandidate;
  readonly files: BranchFiles;
  readonly changedFiles: readonly string[];
}

interface PairAnalysis {
  readonly leftId: string;
  readonly rightId: string;
  readonly leftBranch: string;
  readonly rightBranch: string;
  readonly files: readonly string[];
  readonly mergeClean: boolean | null;
}

const EMPTY_SNAPSHOT: FleetBranchAnalysisSnapshot = { analyses: [], pending: false, pairs: 0, conflicts: 0 };

export function createFleetBranchAnalysisService(): FleetBranchAnalysisService {
  let snapshot = EMPTY_SNAPSHOT;
  let pendingKey: string | null = null;
  let completedKey: string | null = null;
  let callbacks: (() => void)[] = [];
  const branchCache = new Map<string, BranchFiles>();
  const pairCache = new Map<string, boolean | null>();
  const remoteRunners = new WeakMap<CloudControl, Map<string, Promise<GitRunner>>>();

  return {
    getSnapshot: () => snapshot,
    schedule(localView, response, deps, onComplete) {
      const key = inputKey(localView, response);
      if (pendingKey === key) {
        if (onComplete !== undefined) callbacks.push(onComplete);
        return;
      }
      if (pendingKey !== null) return;
      if (completedKey === key) return;
      pendingKey = key;
      callbacks = onComplete === undefined ? [] : [onComplete];
      snapshot = { analyses: [], pending: true, pairs: snapshot.pairs, conflicts: snapshot.conflicts };
      void analyze(localView, response, deps, branchCache, pairCache, remoteRunners)
        .then((result) => {
          if (pendingKey !== key) return;
          completedKey = key;
          snapshot = { ...result, pending: false };
        })
        .catch(() => {
          if (pendingKey !== key) return;
          completedKey = key;
          snapshot = { analyses: [], pending: false, pairs: 0, conflicts: 0 };
        })
        .finally(() => {
          if (pendingKey !== key) return;
          pendingKey = null;
          const notify = callbacks;
          callbacks = [];
          for (const callback of notify) callback();
        });
    },
  };
}

async function analyze(
  localView: LedgerView | null,
  response: FleetHubResponse,
  deps: FleetBranchAnalysisDeps,
  branchCache: Map<string, BranchFiles>,
  pairCache: Map<string, boolean | null>,
  remoteRunners: WeakMap<CloudControl, Map<string, Promise<GitRunner>>>,
): Promise<FleetBranchAnalysisSnapshot> {
  const candidates = selectCandidates(await collectCandidates(localView, response, deps.git));
  const analyzed: AnalyzedBranch[] = [];
  await runLimited(candidates, BRANCH_CONCURRENCY, async (candidate) => {
    let git = candidate.git;
    if (!hasCachedSummary(candidate, branchCache) && git === undefined && candidate.machine !== undefined) {
      git = await remoteGitRunner(deps.cloud, candidate.machine, remoteRunners);
    }
    const files = await analyzeAgainstMain(candidate, git, branchCache);
    if (files === null) return;
    const changedFiles = [...new Set([...files.committedFiles, ...candidate.dirtyFiles])].sort();
    analyzed.push({ candidate: git === undefined ? candidate : { ...candidate, git }, files, changedFiles });
  });
  analyzed.sort((left, right) => left.candidate.id.localeCompare(right.candidate.id));

  const pairInputs: { left: AnalyzedBranch; right: AnalyzedBranch; files: string[] }[] = [];
  for (let leftIndex = 0; leftIndex < analyzed.length; leftIndex += 1) {
    const left = analyzed[leftIndex];
    if (left === undefined) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < analyzed.length; rightIndex += 1) {
      const right = analyzed[rightIndex];
      if (right === undefined || left.candidate.repoKey !== right.candidate.repoKey) continue;
      const rightFiles = new Set(right.changedFiles);
      const files = left.changedFiles.filter((file) => rightFiles.has(file));
      if (files.length === 0) continue;
      pairInputs.push({ left, right, files });
      if (pairInputs.length >= MAX_PAIR_COMPARISONS) break;
    }
    if (pairInputs.length >= MAX_PAIR_COMPARISONS) break;
  }

  const pairs: PairAnalysis[] = [];
  await runLimited(pairInputs, BRANCH_CONCURRENCY, async ({ left, right, files }) => {
    const committedOverlap = files.some(
      (file) => left.files.committedFiles.includes(file) && right.files.committedFiles.includes(file),
    );
    const mergeClean = committedOverlap
      ? await comparePair(left, right, pairCache, deps.cloud, remoteRunners)
      : null;
    pairs.push({
      leftId: left.candidate.id,
      rightId: right.candidate.id,
      leftBranch: left.candidate.branch,
      rightBranch: right.candidate.branch,
      files,
      mergeClean,
    });
  });
  pairs.sort((left, right) => left.leftId.localeCompare(right.leftId) || left.rightId.localeCompare(right.rightId));

  const analyses = analyzed.map(({ candidate, changedFiles }) => {
    const overlaps: FleetBranchOverlap[] = pairs.flatMap((pair) => {
      if (pair.leftId === candidate.id) {
        return [{ branch: pair.rightBranch, files: pair.files.slice(0, 20), mergeClean: pair.mergeClean }];
      }
      if (pair.rightId === candidate.id) {
        return [{ branch: pair.leftBranch, files: pair.files.slice(0, 20), mergeClean: pair.mergeClean }];
      }
      return [];
    });
    const conflict = overlaps.find((overlap) => overlap.mergeClean === false);
    const unverifiedOverlap = overlaps.find((overlap) => overlap.mergeClean === null);
    const suggestion = conflict !== undefined
      ? `Xử lý xung đột với nhánh ${conflict.branch}`
      : unverifiedOverlap !== undefined
        ? `Kiểm tra xung đột với nhánh ${unverifiedOverlap.branch}`
        : candidate.dirtyFiles.length > 0
          ? 'Commit thay đổi trước khi push'
          : (candidate.unpushed ?? candidate.ahead) > 0
            ? 'Push nhánh'
            : changedFiles.length === 0
              ? 'Chưa có thay đổi so với origin/main'
              : 'Gộp qua merge-lane';
    return {
      id: candidate.id,
      repo: candidate.repo,
      branch: candidate.branch,
      ...(candidate.checkout === undefined ? {} : { checkout: candidate.checkout }),
      ...(candidate.machine === undefined ? {} : { machine: candidate.machine }),
      ...(candidate.path === undefined ? {} : { path: candidate.path }),
      changedFileCount: changedFiles.length,
      modules: mainModules(changedFiles),
      changedFiles: changedFiles.slice(0, 40),
      overlaps,
      suggestion,
    } satisfies FleetBranchAnalysis;
  });
  return {
    analyses,
    pending: false,
    pairs: pairs.length,
    conflicts: pairs.filter((pair) => pair.mergeClean === false).length,
  };
}

async function collectCandidates(
  localView: LedgerView | null,
  response: FleetHubResponse,
  git: GitRunner,
): Promise<BranchCandidate[]> {
  const candidates: BranchCandidate[] = [];
  for (const repo of localView?.repos ?? []) {
    const origin = await git.run(repo.repo, ['remote', 'get-url', 'origin'], GIT_OPTIONS).catch(() => null);
    const githubRepo = githubRepositoryFromOrigin(origin?.ok && !origin.truncated ? origin.stdout.trim() : '');
    const repoKey = githubRepo === null ? `local:${repo.repo}` : githubRepo;
    for (const worktree of repo.worktrees) {
      if (worktree.isMain || worktree.branch === null || worktree.branch === '' || worktree.gitError !== undefined) continue;
      candidates.push({
        id: `local:${worktree.path}:${worktree.branch}`,
        repoKey,
        repo: repo.name,
        repoPath: repo.repo,
        branch: worktree.branch,
        head: worktree.head,
        dirtyFiles: worktree.dirtyFiles.map((file) => file.path),
        ahead: worktree.ahead,
        unpushed: worktree.unpushed,
        checkout: worktree.path,
        git,
      });
    }
  }

  for (const machine of response.machines) {
    if (response.now - machine.received_at > FLEET_STALE_AFTER_MS) continue;
    for (const repo of machine.repos) {
      if (repo.path === undefined || repo.branch.trim() === '') continue;
      const githubRepo = typeof repo.github_repo === 'string' ? repo.github_repo : '';
      candidates.push({
        id: `cloud:${machine.agent_id}:${repo.path}:${repo.branch}`,
        repoKey: githubRepo || `cloud:${machine.agent_id}:${repo.path}`,
        repo: repo.repo ?? repo.path,
        repoPath: repo.path,
        branch: repo.branch,
        ...(typeof repo.head === 'string' && SHA_PATTERN.test(repo.head) ? { head: repo.head } : {}),
        ...(typeof repo.origin_main === 'string' && SHA_PATTERN.test(repo.origin_main)
          ? { originMain: repo.origin_main }
          : {}),
        dirtyFiles: repo.dirty_files.slice(0, 200),
        ahead: repo.ahead,
        unpushed: repo.ahead,
        machine: machine.agent_id,
        path: repo.path,
      });
    }
  }
  return candidates;
}

function selectCandidates(candidates: readonly BranchCandidate[]): BranchCandidate[] {
  const local = candidates.filter((candidate) => candidate.checkout !== undefined);
  const cloud = candidates.filter((candidate) => candidate.machine !== undefined);
  const selected: BranchCandidate[] = [];
  for (let index = 0; index < 6; index += 1) {
    const localCandidate = local[index];
    const cloudCandidate = cloud[index];
    if (localCandidate !== undefined) selected.push(localCandidate);
    if (cloudCandidate !== undefined) selected.push(cloudCandidate);
  }
  let localIndex = 6;
  let cloudIndex = 6;
  while (selected.length < MAX_BRANCHES_PER_CYCLE) {
    const candidate = local[localIndex++] ?? cloud[cloudIndex++];
    if (candidate === undefined) break;
    selected.push(candidate);
  }
  return selected;
}

function hasCachedSummary(candidate: BranchCandidate, cache: Map<string, BranchFiles>): boolean {
  return candidate.head !== undefined &&
    candidate.originMain !== undefined &&
    cache.has(`${candidate.head}\0${candidate.originMain}`);
}

async function remoteGitRunner(
  cloud: CloudControl,
  machine: string,
  remoteRunners: WeakMap<CloudControl, Map<string, Promise<GitRunner>>>,
): Promise<GitRunner | undefined> {
  const runners = remoteRunners.get(cloud) ?? new Map<string, Promise<GitRunner>>();
  remoteRunners.set(cloud, runners);
  let runner = runners.get(machine);
  if (runner === undefined) {
    runner = cloud.gitRunner(machine);
    runners.set(machine, runner);
  }
  try {
    return await runner;
  } catch {
    runners.delete(machine);
    return undefined;
  }
}

async function analyzeAgainstMain(
  candidate: BranchCandidate,
  git: GitRunner | undefined,
  cache: Map<string, BranchFiles>,
): Promise<BranchFiles | null> {
  if (hasCachedSummary(candidate, cache)) {
    return cache.get(`${candidate.head}\0${candidate.originMain}`) ?? null;
  }
  if (git === undefined) return null;
  const [head, base] = await Promise.all([
    resolveSha(git, candidate.repoPath, candidate.branch, candidate.head),
    resolveSha(git, candidate.repoPath, BASE_REF, candidate.originMain),
  ]);
  if (head === null || base === null) return null;
  const key = `${head}\0${base}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  try {
    const result = await compareProjectBranches(
      { type: 'projectBranchCompareRequest', requestId: 'fleet-branch-analysis', repo: candidate.repoPath, branchA: BASE_REF, branchB: candidate.branch },
      { git, knownRepos: [candidate.repoPath] },
    );
    const actual = { head: result.b.head, base: result.a.head, committedFiles: result.files.filter((file) => file.inB).map((file) => file.path) };
    remember(cache, `${actual.head}\0${actual.base}`, actual);
    return actual;
  } catch {
    return null;
  }
}

async function comparePair(
  left: AnalyzedBranch,
  right: AnalyzedBranch,
  cache: Map<string, boolean | null>,
  cloud: CloudControl,
  remoteRunners: WeakMap<CloudControl, Map<string, Promise<GitRunner>>>,
): Promise<boolean | null> {
  const heads = [left.files.head, right.files.head].sort();
  const key = `${left.candidate.repoKey}\0${heads[0]}\0${heads[1]}`;
  if (cache.has(key)) return cache.get(key) ?? null;
  const candidates = [left.candidate, right.candidate];
  for (const candidate of candidates) {
    let git = candidate.git;
    if (git === undefined && candidate.machine !== undefined) {
      git = await remoteGitRunner(cloud, candidate.machine, remoteRunners);
    }
    if (git === undefined) continue;
    try {
      const result = await compareProjectBranches(
        {
          type: 'projectBranchCompareRequest',
          requestId: 'fleet-branch-overlap',
          repo: candidate.repoPath,
          branchA: left.candidate.branch,
          branchB: right.candidate.branch,
        },
        { git, knownRepos: [candidate.repoPath] },
      );
      remember(cache, key, result.mergeClean);
      return result.mergeClean;
    } catch {
      // A branch may not be fetched in the first clone; try the other branch's repository before marking unknown.
    }
  }
  remember(cache, key, null);
  return null;
}

async function resolveSha(git: GitRunner, repo: string, ref: string, reported?: string): Promise<string | null> {
  if (reported !== undefined && SHA_PATTERN.test(reported)) return reported;
  try {
    const result = await git.run(repo, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`], GIT_OPTIONS);
    const sha = result.stdout.trim();
    return result.ok && !result.truncated && SHA_PATTERN.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

function mainModules(files: readonly string[]): { name: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const file of files) {
    const segments = file.split('/').filter(Boolean);
    const name = segments.length === 1 ? '(gốc)' : segments.slice(0, Math.min(2, segments.length - 1)).join('/');
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts]
    .map(([name, count]) => ({ name, count }))
    .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name))
    .slice(0, 3);
}

function inputKey(localView: LedgerView | null, response: FleetHubResponse): string {
  return JSON.stringify([
    localView?.generatedAt ?? '',
    (localView?.repos ?? []).flatMap((repo) =>
      repo.worktrees.map((worktree) => [repo.repo, worktree.path, worktree.branch, worktree.head, worktree.dirtyCount]),
    ),
    response.now,
    response.machines.map((machine) => [
      machine.agent_id,
      machine.received_at,
      machine.repos.map((repo) => [repo.path, repo.branch, repo.head ?? '', repo.origin_main ?? '', repo.ahead, repo.dirty_files]),
    ]),
  ]);
}

function remember<T>(cache: Map<string, T>, key: string, value: T): void {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > MAX_CACHED_ANALYSES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

async function runLimited<T>(items: readonly T[], concurrency: number, action: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(items.length, concurrency) }, async () => {
      while (next < items.length) {
        const index = next;
        next += 1;
        const item = items[index];
        if (item !== undefined) await action(item);
      }
    }),
  );
}

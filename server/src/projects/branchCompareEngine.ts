import type {
  ProjectBranchCommit,
  ProjectBranchCompareConflict,
  ProjectBranchCompareMessage,
  ProjectBranchCompareRequestMessage,
  ProjectBranchCompareSide,
} from '../../../core/src/messages.js';
import type { GitRunner, GitRunOptions } from '../ledger/git.js';
import { ledgerPathKey, normalizeLedgerPath } from '../ledger/ledgerPath.js';
import { LibraryUserError } from '../library/libraryError.js';

export const PROJECT_BRANCH_COMPARE_TIMEOUT_MS = 30_000;
export const PROJECT_BRANCH_COMPARE_MAX_BYTES = 2 * 1024 * 1024;
const MAX_COMMITS = 200;
const MAX_CONFLICT_HUNKS = 20;
const MAX_HUNK_LINES = 40;
const REF_MAX_LENGTH = 255;
const SHA_PATTERN = /^[0-9a-f]{40,64}$/i;
const OPTIONS: GitRunOptions = {
  timeoutMs: PROJECT_BRANCH_COMPARE_TIMEOUT_MS,
  okCodes: [0],
  maxBytes: PROJECT_BRANCH_COMPARE_MAX_BYTES,
};

export const PROJECT_BRANCH_COMPARE_TEXT = {
  unknownRepo: 'Repo này không có trong cây Project.',
  badBranch: 'Tên nhánh không hợp lệ.',
  missingBranch: (name: string) => `Không tìm thấy nhánh ${name} trong repo.`,
  timeout: 'So sánh nhánh quá lâu, đã dừng. Thử lại sau.',
  failed: 'Không đọc được thông tin so sánh nhánh từ Git.',
} as const;

export interface ProjectBranchCompareDeps {
  readonly git: GitRunner;
  readonly knownRepos: readonly string[];
}

export async function compareProjectBranches(
  request: ProjectBranchCompareRequestMessage,
  deps: ProjectBranchCompareDeps,
): Promise<ProjectBranchCompareMessage> {
  const repo = knownRepo(request.repo, deps.knownRepos);
  const branchA = checkedBranch(request.branchA);
  const branchB = checkedBranch(request.branchB);
  const [headA, headB] = await Promise.all([
    resolveBranch(deps.git, repo, branchA),
    resolveBranch(deps.git, repo, branchB),
  ]);
  const [sideA, sideB, mergeBase] = await Promise.all([
    branchSide(deps.git, repo, branchA, headA),
    branchSide(deps.git, repo, branchB, headB),
    getMergeBase(deps.git, repo, headA, headB),
  ]);
  const [onlyAResult, onlyBResult] = await Promise.all([
    commits(deps.git, repo, `${headB}..${headA}`),
    commits(deps.git, repo, `${headA}..${headB}`),
  ]);
  const files = mergeBase === null ? [] : await changedFiles(deps.git, repo, mergeBase, headA, headB);
  const merged = await mergeTree(deps.git, repo, headA, headB);
  const conflictSet = new Set(merged.conflicts.map((conflict) => conflict.file));
  return {
    type: 'projectBranchCompare',
    requestId: request.requestId,
    repo,
    branchA,
    branchB,
    a: sideA,
    b: sideB,
    mergeBase,
    onlyA: onlyAResult.commits,
    onlyB: onlyBResult.commits,
    commitsTruncated: onlyAResult.truncated || onlyBResult.truncated,
    files: files.map((file) => ({ ...file, conflict: conflictSet.has(file.path) })),
    mergeClean: merged.clean,
    conflicts: merged.conflicts,
  };
}

function knownRepo(raw: string, known: readonly string[]): string {
  const key = ledgerPathKey(raw);
  const match = known.find((candidate) => ledgerPathKey(candidate) === key);
  if (match === undefined) throw new LibraryUserError(PROJECT_BRANCH_COMPARE_TEXT.unknownRepo);
  return normalizeLedgerPath(match);
}

function checkedBranch(raw: string): string {
  const branch = raw.trim();
  if (
    branch.length === 0 || branch.length > REF_MAX_LENGTH || branch.startsWith('-') ||
    branch.includes('..') || /[\s\0~^:?*[\\]/.test(branch)
  ) throw new LibraryUserError(PROJECT_BRANCH_COMPARE_TEXT.badBranch);
  return branch;
}

async function run(git: GitRunner, cwd: string, args: readonly string[], options = OPTIONS) {
  const result = await git.run(cwd, args, options);
  if (result.timedOut) throw new LibraryUserError(PROJECT_BRANCH_COMPARE_TEXT.timeout);
  if (!result.ok || result.truncated) throw new LibraryUserError(PROJECT_BRANCH_COMPARE_TEXT.failed);
  return result.stdout;
}

async function resolveBranch(git: GitRunner, repo: string, branch: string): Promise<string> {
  const result = await git.run(repo, ['rev-parse', '--verify', '--quiet', `${branch}^{commit}`], {
    timeoutMs: PROJECT_BRANCH_COMPARE_TIMEOUT_MS, okCodes: [0, 1], maxBytes: 4096,
  });
  if (result.timedOut) throw new LibraryUserError(PROJECT_BRANCH_COMPARE_TEXT.timeout);
  const sha = result.stdout.trim();
  if (result.truncated || result.code !== 0 || !SHA_PATTERN.test(sha)) {
    throw new LibraryUserError(PROJECT_BRANCH_COMPARE_TEXT.missingBranch(branch));
  }
  return sha;
}

async function branchSide(git: GitRunner, repo: string, branch: string, head: string): Promise<ProjectBranchCompareSide> {
  const worktrees = await run(git, repo, ['worktree', 'list', '--porcelain'], { ...OPTIONS, maxBytes: 256 * 1024 });
  let checkout: string | undefined;
  let currentPath = '';
  for (const line of worktrees.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) currentPath = normalizeLedgerPath(line.slice(9));
    else if (line.startsWith('branch refs/heads/') && line.slice('branch refs/heads/'.length) === branch) checkout = currentPath;
  }
  if (checkout === undefined) {
    const current = await run(git, repo, ['rev-parse', '--show-toplevel'], { ...OPTIONS, maxBytes: 4096 });
    const currentBranch = (await run(git, repo, ['branch', '--show-current'], { ...OPTIONS, maxBytes: 4096 })).trim();
    if (currentBranch === branch) checkout = normalizeLedgerPath(current.trim());
  }

  const metadata = (await run(git, repo, ['log', '-1', '--format=%aI%x00%s', head], { ...OPTIONS, maxBytes: 16 * 1024 })).trim();
  const [lastCommitAt = '', lastCommitSubject = ''] = metadata.split('\0');
  const dirtyFiles = checkout === undefined ? [] : parseStatus(await run(
    git, checkout, ['status', '--porcelain', '-z', '--untracked-files=all'], { ...OPTIONS, maxBytes: 256 * 1024 },
  ));
  return {
    branch,
    head,
    lastCommitAt: lastCommitAt || null,
    lastCommitSubject: lastCommitSubject || null,
    ...(checkout === undefined ? {} : { checkout }),
    dirtyFiles,
  };
}

function parseStatus(output: string): { path: string; status: string }[] {
  const entries = output.split('\0').filter(Boolean);
  const files: { path: string; status: string }[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index] ?? '';
    if (entry.length < 4) continue;
    const status = entry.slice(0, 2).trim() || '??';
    const path = entry.slice(3);
    files.push({ path: normalizeLedgerPath(path), status });
    if (status.includes('R') || status.includes('C')) index += 1;
  }
  return files;
}

async function commits(git: GitRunner, repo: string, range: string): Promise<{ commits: ProjectBranchCommit[]; truncated: boolean }> {
  const stdout = await run(git, repo, ['log', `--max-count=${MAX_COMMITS + 1}`, '--format=%H%x00%s%x00%an%x00%aI', range], {
    ...OPTIONS, maxBytes: 512 * 1024,
  });
  const rows = stdout.trim().split('\n').filter(Boolean).map((row) => {
    const [sha = '', subject = '', author = '', at = ''] = row.split('\0');
    return { sha, subject, author, at };
  });
  return { commits: rows.slice(0, MAX_COMMITS), truncated: rows.length > MAX_COMMITS };
}

async function getMergeBase(git: GitRunner, repo: string, a: string, b: string): Promise<string | null> {
  const result = await git.run(repo, ['merge-base', a, b], { ...OPTIONS, okCodes: [0, 1], maxBytes: 4096 });
  if (result.timedOut) throw new LibraryUserError(PROJECT_BRANCH_COMPARE_TEXT.timeout);
  return result.code === 0 && SHA_PATTERN.test(result.stdout.trim()) ? result.stdout.trim() : null;
}

async function changedFiles(git: GitRunner, repo: string, base: string, a: string, b: string) {
  const [aFiles, bFiles] = await Promise.all([
    nameOnly(git, repo, base, a), nameOnly(git, repo, base, b),
  ]);
  const paths = new Set([...aFiles, ...bFiles]);
  return [...paths].sort().map((path) => ({ path, inA: aFiles.has(path), inB: bFiles.has(path), conflict: false }));
}

async function nameOnly(git: GitRunner, repo: string, base: string, head: string): Promise<Set<string>> {
  const output = await run(git, repo, ['diff', '--name-only', '-z', base, head, '--'], { ...OPTIONS, maxBytes: 512 * 1024 });
  return new Set(output.split('\0').filter(Boolean));
}

async function mergeTree(git: GitRunner, repo: string, a: string, b: string): Promise<{ clean: boolean; conflicts: ProjectBranchCompareConflict[] }> {
  // Without --no-messages, -z output goes on past the file names with git's merge messages.
  const result = await git.run(repo, ['merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', a, b], {
    ...OPTIONS, okCodes: [0, 1], maxBytes: PROJECT_BRANCH_COMPARE_MAX_BYTES,
  });
  if (result.timedOut) throw new LibraryUserError(PROJECT_BRANCH_COMPARE_TEXT.timeout);
  if (!result.ok || result.truncated) throw new LibraryUserError(PROJECT_BRANCH_COMPARE_TEXT.failed);
  if (result.code === 0) return { clean: true, conflicts: [] };
  const [tree = '', ...paths] = result.stdout.split('\0').filter(Boolean);
  if (!SHA_PATTERN.test(tree)) throw new LibraryUserError(PROJECT_BRANCH_COMPARE_TEXT.failed);
  const conflicts: ProjectBranchCompareConflict[] = [];
  for (const file of [...new Set(paths)].slice(0, 100)) {
    const blob = await run(git, repo, ['cat-file', '-p', `${tree}:${file}`], { ...OPTIONS, maxBytes: 256 * 1024 });
    conflicts.push({ file, hunks: parseConflictHunks(blob).slice(0, MAX_CONFLICT_HUNKS) });
  }
  return { clean: false, conflicts };
}

function parseConflictHunks(content: string): { line: number; ours: string; theirs: string }[] {
  const lines = content.split(/\r?\n/);
  const hunks: { line: number; ours: string; theirs: string }[] = [];
  for (let index = 0; index < lines.length && hunks.length < MAX_CONFLICT_HUNKS; index += 1) {
    const marker = lines[index] ?? '';
    if (!marker.startsWith('<<<<<<<')) continue;
    const separator = lines.indexOf('=======', index + 1);
    if (separator < 0) continue;
    let end = separator + 1;
    while (end < lines.length && !(lines[end] ?? '').startsWith('>>>>>>>')) end += 1;
    if (end >= lines.length) continue;
    // With merge.conflictStyle diff3/zdiff3 the ours side is followed by `||||||| base`: only ours is kept.
    const baseMarker = lines.slice(index + 1, separator).findIndex((line) => line.startsWith('|||||||'));
    const oursEnd = baseMarker < 0 ? separator : index + 1 + baseMarker;
    hunks.push({
      line: index + 1,
      ours: lines.slice(index + 1, oursEnd).slice(0, MAX_HUNK_LINES).join('\n'),
      theirs: lines.slice(separator + 1, end).slice(0, MAX_HUNK_LINES).join('\n'),
    });
    index = end;
  }
  return hunks;
}

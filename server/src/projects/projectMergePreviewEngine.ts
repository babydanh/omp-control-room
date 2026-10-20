/**
 * "Thử gộp": would merging branch B into branch A conflict? Answered with
 * `git merge-tree --write-tree`, which merges in memory: no checkout, index, ref or worktree
 * changes (it only adds unreferenced objects to the object store, which git gc removes).
 * The repo's own merge drivers (e.g. mergiraf) still run, so the answer matches a real merge.
 * Only committed work is compared; uncommitted changes in either worktree are not seen.
 */
import type {
  ProjectMergePreviewRequestMessage,
  ProjectMergePreviewResultMessage,
} from '../../../core/src/messages.js';
import type { GitRunner } from '../ledger/git.js';
import { ledgerPathKey, normalizeLedgerPath } from '../ledger/ledgerPath.js';
import { LibraryUserError } from '../library/libraryError.js';

/** Structured merge drivers can take a minute on large files before falling back to git. */
export const PROJECT_MERGE_PREVIEW_TIMEOUT_MS = 120_000;
const MERGE_OUTPUT_MAX_BYTES = 1024 * 1024;
const REF_MAX_LENGTH = 255;
const SHA_PATTERN = /^[0-9a-f]{4,64}$/i;

export const PROJECT_MERGE_TEXT = {
  unknownRepo: 'Repo này không có trong cây Project.',
  badBranch: 'Tên nhánh không hợp lệ.',
  sameBranch: 'Chọn hai nhánh khác nhau để thử gộp.',
  missingBranch: (name: string) => `Không tìm thấy nhánh ${name} trong repo.`,
  timeout: 'Thử gộp quá lâu, đã dừng. Thử lại sau.',
  failed: 'Git không thử gộp được hai nhánh này (git cần bản 2.38 trở lên).',
  committedOnly: 'Chỉ xét phần đã commit; file chưa commit ở hai worktree không được tính.',
} as const;

export interface ProjectMergePreviewDeps {
  readonly git: GitRunner;
  /** Repos the Project tree shows; any other path is refused before git runs. */
  readonly knownRepos: readonly string[];
}

export async function previewBranchMerge(
  request: ProjectMergePreviewRequestMessage,
  deps: ProjectMergePreviewDeps,
): Promise<ProjectMergePreviewResultMessage> {
  const repo = knownRepo(request.repo, deps.knownRepos);
  const branchA = checkedRef(request.branchA);
  const branchB = checkedRef(request.branchB);
  if (branchA === branchB) throw new LibraryUserError(PROJECT_MERGE_TEXT.sameBranch);
  const shaA = await commitOf(deps.git, repo, branchA);
  const shaB = await commitOf(deps.git, repo, branchB);

  const result = await deps.git.run(
    repo,
    ['merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', shaA, shaB],
    // Exit 1 means "merged with conflicts", a normal answer.
    { timeoutMs: PROJECT_MERGE_PREVIEW_TIMEOUT_MS, okCodes: [0, 1], maxBytes: MERGE_OUTPUT_MAX_BYTES },
  );
  if (result.timedOut) throw new LibraryUserError(PROJECT_MERGE_TEXT.timeout);
  if (!result.ok) throw new LibraryUserError(PROJECT_MERGE_TEXT.failed);

  return {
    type: 'projectMergePreviewResult',
    requestId: request.requestId,
    repo,
    branchA,
    branchB,
    clean: result.code === 0,
    conflicts: result.code === 0 ? [] : conflictFiles(result.stdout),
    reason: PROJECT_MERGE_TEXT.committedOnly,
  };
}

function knownRepo(raw: string, known: readonly string[]): string {
  const key = ledgerPathKey(raw);
  const match = known.find((candidate) => ledgerPathKey(candidate) === key);
  if (match === undefined) throw new LibraryUserError(PROJECT_MERGE_TEXT.unknownRepo);
  return normalizeLedgerPath(match);
}

/** A branch name or sha safe to pass as one argv item: never read as an option. */
function checkedRef(raw: string): string {
  const ref = raw.trim();
  const valid =
    ref.length > 0 &&
    ref.length <= REF_MAX_LENGTH &&
    !ref.startsWith('-') &&
    !ref.includes('..') &&
    !/[\s\0~^:?*[\\]/.test(ref);
  if (!valid) throw new LibraryUserError(PROJECT_MERGE_TEXT.badBranch);
  return ref;
}

async function commitOf(git: GitRunner, repo: string, ref: string): Promise<string> {
  const result = await git.run(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
    timeoutMs: 10_000,
    okCodes: [0, 1],
    maxBytes: 4096,
  });
  if (result.timedOut) throw new LibraryUserError(PROJECT_MERGE_TEXT.timeout);
  const sha = result.stdout.trim();
  if (result.code !== 0 || !SHA_PATTERN.test(sha)) throw new LibraryUserError(PROJECT_MERGE_TEXT.missingBranch(ref));
  return sha;
}

/** `-z --name-only` output: the tree id, then each conflicted path, all NUL-terminated. */
function conflictFiles(stdout: string): string[] {
  const [, ...paths] = stdout.split('\0');
  return [...new Set(paths.filter((entry) => entry.length > 0))];
}

/**
 * Read-only diff of one checkout for the Project tree's "Thay đổi" page.
 *
 * Scopes: uncommitted work (working tree vs HEAD), the whole branch (working tree vs its
 * merge base with main), one commit, and branch comparison (HEAD vs a named branch).
 * git call goes through the ledger GitRunner (argv only, no shell, bounded time and bytes) and
 * never writes to the repository. Each changed file is attributed to the sessions that edited it,
 * from the shared activity ledger the caller passes in.
 */
import type {
  ProjectDiffFile,
  ProjectDiffHunk,
  ProjectDiffMessage,
  ProjectDiffRequestMessage,
} from '../../../core/src/messages.js';
import { LEDGER_DEV_NULL } from '../ledger/constants.js';
import type { GitRunner, GitRunOptions } from '../ledger/git.js';
import type { EventRow, SessionRow } from '../ledger/ledgerDb.js';
import { ledgerPathKey, normalizeLedgerPath } from '../ledger/ledgerPath.js';
import { LibraryUserError } from '../library/libraryError.js';

/** Total patch text one diff may return. */
export const PROJECT_DIFF_MAX_BYTES = 2 * 1024 * 1024;
export const PROJECT_DIFF_TIMEOUT_MS = 15_000;
/** Untracked files diffed one by one; the rest are reported through `truncated`. */
export const PROJECT_DIFF_MAX_UNTRACKED = 100;
/** Git's empty tree: the base for a repo with no commit yet and for a root commit. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
/** Main branch names tried in order for the "whole branch" scope; each as local and origin/. */
const BASE_BRANCHES = ['main', 'master'] as const;
const SHA_PATTERN = /^[0-9a-f]{4,64}$/i;
export const EDIT_KINDS = new Set(['edit', 'write']);

export const PROJECT_DIFF_TEXT = {
  unknownCheckout: 'Worktree này không có trong cây Project, không xem được thay đổi.',
  badSha: 'Mã commit không hợp lệ.',
  missingCommit: 'Không tìm thấy commit này trong worktree.',
  missingBranch: 'Không tìm thấy nhánh cần so sánh trong worktree.',
  noBase: 'Không tìm thấy nhánh main (origin/main hoặc main) để so sánh cả nhánh.',
  timeout: 'Đọc thay đổi quá lâu, đã dừng. Thử lại hoặc xem từng file.',
  failed: 'Không đọc được thay đổi của worktree này.',
  truncated: 'Thay đổi quá lớn, chỉ hiện phần đầu.',
  untrackedCapped: `Có hơn ${PROJECT_DIFF_MAX_UNTRACKED} file mới chưa track, chỉ hiện ${PROJECT_DIFF_MAX_UNTRACKED} file đầu.`,
} as const;

export interface ProjectDiffDeps {
  readonly git: GitRunner;
  /** Checkouts the Project tree shows; any other path is refused before git runs. */
  readonly knownCheckouts: readonly string[];
  /** Ledger rows used to name who edited each file. Omit to leave `author` empty. */
  readonly events?: readonly EventRow[];
  readonly sessions?: readonly SessionRow[];
  /** Test seam: byte budget for the whole patch. */
  readonly maxBytes?: number;
}

/** Flags shared by every patch read: plain text, no external drivers, renames detected. */
const PATCH_FLAGS = ['--no-color', '--no-ext-diff', '--no-textconv', '--find-renames', '--patch', '-U3'] as const;
/** Non-ASCII paths (Vietnamese file names) printed as-is instead of octal escapes. */
const CONFIG_FLAGS = ['-c', 'core.quotePath=false'] as const;

export async function readCheckoutDiff(
  request: ProjectDiffRequestMessage,
  deps: ProjectDiffDeps,
): Promise<ProjectDiffMessage> {
  const checkout = knownCheckout(request.checkout, deps.knownCheckouts);
  const budget = deps.maxBytes ?? PROJECT_DIFF_MAX_BYTES;
  const options: GitRunOptions = { timeoutMs: PROJECT_DIFF_TIMEOUT_MS, okCodes: [0], maxBytes: budget };

  let base: string;
  let target: string | null = null;
  let withUntracked = true;
  if (request.scope === 'commit') {
    const sha = await commitSha(deps.git, checkout, request.sha);
    base = (await revParse(deps.git, checkout, `${sha}^`)) ?? EMPTY_TREE;
    target = sha;
    withUntracked = false;
  } else if (request.scope === 'branch') {
    base = await mergeBase(deps.git, checkout);
  } else if (request.scope === 'compare') {
    if (request.sha.length === 0 || request.sha.length > 255 || request.sha.startsWith('-') || /[\s\0~^:?*[\\]/.test(request.sha)) {
      throw new LibraryUserError(PROJECT_DIFF_TEXT.missingBranch);
    }
    const branch = await revParse(deps.git, checkout, request.sha);
    if (branch === null) throw new LibraryUserError(PROJECT_DIFF_TEXT.missingBranch);
    base = (await revParse(deps.git, checkout, 'HEAD')) ?? EMPTY_TREE;
    target = branch;
    withUntracked = false;
  } else {
    base = (await revParse(deps.git, checkout, 'HEAD')) ?? EMPTY_TREE;
  }

  const range = target === null ? [base] : [base, target];
  const tracked = await deps.git.run(checkout, [...CONFIG_FLAGS, 'diff', ...PATCH_FLAGS, ...range, '--'], options);
  failOn(tracked);
  const files = parsePatch(tracked.stdout, tracked.truncated);
  let truncated = tracked.truncated;
  let reason: string | undefined = truncated ? PROJECT_DIFF_TEXT.truncated : undefined;

  if (withUntracked && !truncated) {
    const extra = await untrackedFiles(deps.git, checkout, budget - Buffer.byteLength(tracked.stdout));
    files.push(...extra.files);
    if (extra.truncated) {
      truncated = true;
      reason = extra.reason;
    }
  }

  const authors = authorsByFile(checkout, deps.events ?? [], deps.sessions ?? []);
  for (const file of files) file.author = authors.get(ledgerPathKey(`${checkout}/${file.path}`)) ?? '';

  return {
    type: 'projectDiff',
    requestId: request.requestId,
    checkout,
    scope: request.scope,
    sha: request.scope === 'compare' ? request.sha : target ?? base,
    files,
    truncated,
    ...(reason === undefined ? {} : { reason }),
  };
}

function knownCheckout(raw: string, known: readonly string[]): string {
  const key = ledgerPathKey(raw);
  const match = known.find((candidate) => ledgerPathKey(candidate) === key);
  if (match === undefined) throw new LibraryUserError(PROJECT_DIFF_TEXT.unknownCheckout);
  return normalizeLedgerPath(match);
}

function failOn(result: { readonly ok: boolean; readonly timedOut: boolean }): void {
  if (result.timedOut) throw new LibraryUserError(PROJECT_DIFF_TEXT.timeout);
  if (!result.ok) throw new LibraryUserError(PROJECT_DIFF_TEXT.failed);
}

const REV_OPTIONS: GitRunOptions = { timeoutMs: PROJECT_DIFF_TIMEOUT_MS, okCodes: [0], maxBytes: 4096 };

/** The commit a revision names, or null when it names none (e.g. HEAD in an empty repo). */
async function revParse(git: GitRunner, checkout: string, rev: string): Promise<string | null> {
  const result = await git.run(checkout, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`], {
    ...REV_OPTIONS,
    okCodes: [0, 1],
  });
  if (result.timedOut) throw new LibraryUserError(PROJECT_DIFF_TEXT.timeout);
  const sha = result.stdout.trim();
  return result.code === 0 && SHA_PATTERN.test(sha) ? sha : null;
}

async function commitSha(git: GitRunner, checkout: string, raw: string): Promise<string> {
  if (!SHA_PATTERN.test(raw)) throw new LibraryUserError(PROJECT_DIFF_TEXT.badSha);
  const sha = await revParse(git, checkout, raw);
  if (sha === null) throw new LibraryUserError(PROJECT_DIFF_TEXT.missingCommit);
  return sha;
}

/**
 * Branch point of HEAD against main. Local `main` and `origin/main` can each be stale (merged
 * locally without pushing, or fetched without pulling), so both merge bases are computed and the
 * one closer to HEAD wins: the smallest diff that still holds all of the branch's own work. When
 * the two have diverged, local wins, since origin may carry work the user has not pulled.
 * Same rule as parallel-code's pickMergeBase (electron/ipc/git.ts).
 */
async function mergeBase(git: GitRunner, checkout: string): Promise<string> {
  for (const branch of BASE_BRANCHES) {
    const local = await mergeBaseWith(git, checkout, branch);
    const origin = await mergeBaseWith(git, checkout, `origin/${branch}`);
    if (local === null && origin === null) continue;
    if (local === null || origin === null || local === origin) return (local ?? origin) as string;
    if (await isAncestor(git, checkout, local, origin)) return origin;
    return local;
  }
  throw new LibraryUserError(PROJECT_DIFF_TEXT.noBase);
}

async function mergeBaseWith(git: GitRunner, checkout: string, ref: string): Promise<string | null> {
  if ((await revParse(git, checkout, ref)) === null) return null;
  const result = await git.run(checkout, ['merge-base', 'HEAD', ref], { ...REV_OPTIONS, okCodes: [0, 1] });
  if (result.timedOut) throw new LibraryUserError(PROJECT_DIFF_TEXT.timeout);
  const sha = result.stdout.trim();
  return result.code === 0 && SHA_PATTERN.test(sha) ? sha : null;
}

async function isAncestor(git: GitRunner, checkout: string, ancestor: string, descendant: string): Promise<boolean> {
  // Exit 1 is the "not an ancestor" answer.
  const result = await git.run(checkout, ['merge-base', '--is-ancestor', ancestor, descendant], {
    ...REV_OPTIONS,
    okCodes: [0, 1],
  });
  if (result.timedOut) throw new LibraryUserError(PROJECT_DIFF_TEXT.timeout);
  return result.code === 0;
}

/** Relative path git printed, refused when it could point outside the checkout. */
function safeRelative(filePath: string): boolean {
  if (filePath.length === 0 || filePath.includes('\0')) return false;
  if (filePath.startsWith('/') || /^[A-Za-z]:/.test(filePath)) return false;
  return !filePath.split(/[\\/]/).some((part) => part === '..');
}

async function untrackedFiles(
  git: GitRunner,
  checkout: string,
  budget: number,
): Promise<{ files: ProjectDiffFile[]; truncated: boolean; reason?: string }> {
  const listed = await git.run(checkout, ['ls-files', '--others', '--exclude-standard', '-z'], {
    timeoutMs: PROJECT_DIFF_TIMEOUT_MS,
    okCodes: [0],
    maxBytes: PROJECT_DIFF_MAX_BYTES,
  });
  failOn(listed);
  const entries = listed.stdout.split('\0');
  // Output past the byte cap is cut: the last entry may be half a path, and more files exist.
  if (listed.truncated) entries.pop();
  const paths = entries.filter(safeRelative);
  const files: ProjectDiffFile[] = [];
  let left = budget;
  for (const filePath of paths.slice(0, PROJECT_DIFF_MAX_UNTRACKED)) {
    if (left <= 0) return { files, truncated: true, reason: PROJECT_DIFF_TEXT.truncated };
    // `diff --no-index` exits 1 when the two sides differ, which is always the case here.
    const result = await git.run(
      checkout,
      [...CONFIG_FLAGS, 'diff', '--no-index', ...PATCH_FLAGS, '--', LEDGER_DEV_NULL, filePath],
      { timeoutMs: PROJECT_DIFF_TIMEOUT_MS, okCodes: [0, 1], maxBytes: left },
    );
    if (result.timedOut) throw new LibraryUserError(PROJECT_DIFF_TEXT.timeout);
    if (!result.ok) continue;
    left -= Buffer.byteLength(result.stdout);
    const [file] = parsePatch(result.stdout, result.truncated);
    if (file !== undefined) files.push({ ...file, path: filePath, status: file.status === 'binary' ? 'binary' : 'added' });
    if (result.truncated) return { files, truncated: true, reason: PROJECT_DIFF_TEXT.truncated };
  }
  // Cut by bytes: how many files exist is unknown, so say "too large", not "more than 100".
  if (listed.truncated) return { files, truncated: true, reason: PROJECT_DIFF_TEXT.truncated };
  if (paths.length > PROJECT_DIFF_MAX_UNTRACKED) {
    return { files, truncated: true, reason: PROJECT_DIFF_TEXT.untrackedCapped };
  }
  return { files, truncated: false };
}

/** Unquotes a path git printed in C-style quotes (only when it holds special characters). */
function unquote(raw: string): string {
  if (!raw.startsWith('"') || !raw.endsWith('"')) return raw;
  return raw.slice(1, -1).replace(/\\(["\\tn])/g, (_m, c: string) => (c === 't' ? '\t' : c === 'n' ? '\n' : c));
}

/** `diff --git a/X b/X` header path when both sides are the same file. */
function headerPath(line: string): string | null {
  const rest = line.slice('diff --git '.length);
  if (rest.startsWith('"')) {
    const match = /^"a\/(.*)" "b\/(.*)"$/.exec(rest);
    return match ? unquote(`"${match[2]}"`) : null;
  }
  // "a/<p> b/<p>": both halves have the same length when the path did not change.
  const half = (rest.length - 1) / 2;
  if (!Number.isInteger(half)) return null;
  const left = rest.slice(0, half);
  const right = rest.slice(half + 1);
  return left.startsWith('a/') && right.startsWith('b/') && left.slice(2) === right.slice(2) ? right.slice(2) : null;
}

/** Splits a unified patch into files and hunks. A cut-off last file is dropped when truncated. */
export function parsePatch(patch: string, truncated: boolean): ProjectDiffFile[] {
  const blocks = patch.split(/^(?=diff --git )/m).filter((block) => block.startsWith('diff --git '));
  if (truncated && blocks.length > 0) blocks.pop();
  const files: ProjectDiffFile[] = [];
  for (const block of blocks) {
    const file = parseBlock(block);
    if (file !== null) files.push(file);
  }
  return files;
}

function parseBlock(block: string): ProjectDiffFile | null {
  const lines = block.replace(/\n$/, '').split('\n');
  let path = headerPath(lines[0]);
  let oldPath: string | undefined;
  let status: ProjectDiffFile['status'] = 'modified';
  const hunks: ProjectDiffHunk[] = [];
  let additions = 0;
  let deletions = 0;
  let current: { header: string; body: string[] } | null = null;

  for (const line of lines.slice(1)) {
    if (current !== null) {
      if (line.startsWith('@@')) {
        hunks.push({ header: current.header, content: current.body.join('\n') });
        current = { header: line, body: [] };
      } else {
        current.body.push(line);
        if (line.startsWith('+')) additions += 1;
        else if (line.startsWith('-')) deletions += 1;
      }
      continue;
    }
    if (line.startsWith('@@')) current = { header: line, body: [] };
    else if (line.startsWith('new file mode')) status = 'added';
    else if (line.startsWith('deleted file mode')) status = 'deleted';
    else if (line.startsWith('rename from ')) { oldPath = unquote(line.slice(12)); status = 'renamed'; }
    else if (line.startsWith('rename to ')) path = unquote(line.slice(10));
    else if (line.startsWith('copy from ')) { oldPath = unquote(line.slice(10)); status = 'copied'; }
    else if (line.startsWith('copy to ')) path = unquote(line.slice(8));
    else if (line.startsWith('Binary files ') || line === 'GIT binary patch') status = 'binary';
    else if (line.startsWith('+++ ') && line !== '+++ /dev/null') path = stripPrefix(unquote(line.slice(4)), 'b/');
    else if (line.startsWith('--- ') && line !== '--- /dev/null' && path === null) path = stripPrefix(unquote(line.slice(4)), 'a/');
  }
  if (current !== null) hunks.push({ header: current.header, content: current.body.join('\n') });
  if (path === null || !safeRelative(path) || (oldPath !== undefined && !safeRelative(oldPath))) return null;
  return {
    path,
    ...(oldPath === undefined ? {} : { oldPath }),
    status,
    additions,
    deletions,
    author: '',
    hunks,
  };
}

function stripPrefix(value: string, prefix: string): string {
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

/** "claude …8bec9, omp …45b5375c" per file key, newest editor first. */
function authorsByFile(
  checkout: string,
  events: readonly EventRow[],
  sessions: readonly SessionRow[],
): Map<string, string> {
  const kindOf = new Map(sessions.map((row) => [row.sessionId, toolName(row.agentKind)]));
  const checkoutKey = ledgerPathKey(checkout);
  const byFile = new Map<string, string[]>();
  for (const event of [...events].sort((a, b) => b.ts.localeCompare(a.ts))) {
    if (!EDIT_KINDS.has(event.kind) || event.path === null) continue;
    if (event.checkout !== null && ledgerPathKey(event.checkout) !== checkoutKey) continue;
    const key = ledgerPathKey(event.path);
    const label = `${kindOf.get(event.sessionId) ?? 'omp'} …${event.sessionId.slice(-8)}`;
    const list = byFile.get(key) ?? [];
    if (!list.includes(label)) list.push(label);
    byFile.set(key, list);
  }
  return new Map([...byFile].map(([key, list]) => [key, list.join(', ')]));
}

function toolName(agentKind: string | null): string {
  const kind = (agentKind ?? '').toLowerCase();
  if (kind.includes('claude')) return 'claude';
  if (kind.includes('agy')) return 'agy';
  if (kind === 'sub') return 'omp-sub';
  return 'omp';
}

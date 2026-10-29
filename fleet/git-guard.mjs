import { execFile, execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, hostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const DAY_MS = 24 * 60 * 60 * 1000;
const GIT_TIMEOUT_MS = 2_000;
const BACKUP_TIMEOUT_MS = 5_000;
const MAX_SUBJECTS = 5;

const MAX_SCAN_CONCURRENCY = 4;
const MAX_DIRTY_STAT_PATHS = 64;
const MAX_MERGE_CACHE_ENTRIES = 5000;
const MERGE_TREE_TIMEOUT_MS = 1_000;
const MERGE_CACHE_FILE = 'merged-to-main.json';
let gitCommandsRunning = 0;
const gitCommandWaiters = [];
const gitCommandProfile = new Map();

function profilePhase(label, startedAt, detail = '') {
  if (process.env['GIT_GUARD_PROFILE'] !== '1') return;
  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
  console.error(`[git-guard] ${label}: ${elapsedMs.toFixed(1)}ms${detail}`);
}

function recordGitProfile(args, startedAt) {
  if (process.env['GIT_GUARD_PROFILE'] !== '1') return;
  const key = args.slice(0, 2).join(' ');
  const timing = gitCommandProfile.get(key) ?? { calls: 0, elapsedMs: 0 };
  timing.calls += 1;
  timing.elapsedMs += Number(process.hrtime.bigint() - startedAt) / 1e6;
  gitCommandProfile.set(key, timing);
}

function reportGitProfile() {
  if (process.env['GIT_GUARD_PROFILE'] !== '1') return;
  const summary = [...gitCommandProfile]
    .sort((a, b) => b[1].elapsedMs - a[1].elapsedMs)
    .map(([command, timing]) => `${command}=${timing.elapsedMs.toFixed(1)}ms/${timing.calls}`)
    .join(', ');
  console.error(`[git-guard] git commands: ${summary}`);
}

function runGit(cwd, args, timeout = GIT_TIMEOUT_MS) {
  try {
    return {
      status: 0,
      stdout: execFileSync('git', ['-C', cwd, ...args], {
        encoding: 'utf8', timeout, maxBuffer: 2 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      }),
      stderr: '',
    };
  } catch (error) {
    return {
      status: typeof error.status === 'number' ? error.status : 1,
      stdout: error.stdout?.toString() ?? '',
      stderr: error.stderr?.toString() ?? error.message ?? 'git command failed',
    };
  }
}

async function enterGitSlot() {
  if (gitCommandsRunning < MAX_SCAN_CONCURRENCY) {
    gitCommandsRunning += 1;
    return;
  }
  await new Promise((resolveSlot) => gitCommandWaiters.push(resolveSlot));
}

function leaveGitSlot() {
  const next = gitCommandWaiters.shift();
  if (next) next();
  else gitCommandsRunning -= 1;
}

async function runGitAsync(cwd, args, timeout = GIT_TIMEOUT_MS) {
  await enterGitSlot();
  const startedAt = process.hrtime.bigint();
  try {
    const result = await execFileAsync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      timeout,
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true,
    });
    return { status: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      status:
        typeof error.status === 'number'
          ? error.status
          : typeof error.code === 'number'
            ? error.code
            : -1,
      stdout: error.stdout?.toString() ?? '',
      stderr: error.stderr?.toString() ?? error.message ?? 'git command failed',
    };
  } finally {
    recordGitProfile(args, startedAt);
    leaveGitSlot();
  }
}

async function gitTextAsync(cwd, ...args) {
  const result = await runGitAsync(cwd, args);
  return result.status === 0 ? result.stdout.trim() : '';
}

function gitText(cwd, ...args) {
  const result = runGit(cwd, args);
  return result.status === 0 ? result.stdout.trim() : '';
}

function currentTime(now) {
  const value = typeof now === 'function' ? now() : now;
  if (value instanceof Date) return value.getTime();
  return value === undefined ? Date.now() : Number(value);
}

function cacheFile() {
  return join(homedir(), '.cache', 'git-guard', 'backups.json');
}

function readCache() {
  try {
    const cache = JSON.parse(readFileSync(cacheFile(), 'utf8'));
    return cache && typeof cache === 'object' && cache.entries && typeof cache.entries === 'object' ? cache.entries : {};
  } catch {
    return {};
  }
}

function writeCache(entries) {
  const file = cacheFile();
  const temporary = `${file}.${process.pid}.tmp`;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(temporary, JSON.stringify({ entries }), { mode: 0o600 });
  renameSync(temporary, file);
}

function cacheKey(origin, ref) {
  return JSON.stringify([origin, ref]);
}

function mergedCacheFile() {
  return join(homedir(), '.cache', 'git-guard', MERGE_CACHE_FILE);
}

function readMergedCache() {
  try {
    const cache = JSON.parse(readFileSync(mergedCacheFile(), 'utf8'));
    return cache && typeof cache === 'object' && cache.entries && typeof cache.entries === 'object'
      ? cache.entries
      : {};
  } catch {
    return {};
  }
}

function writeMergedCache(entries) {
  const file = mergedCacheFile();
  const temporary = `${file}.${process.pid}.tmp`;
  const retained = Object.fromEntries(Object.entries(entries).slice(-MAX_MERGE_CACHE_ENTRIES));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(temporary, JSON.stringify({ entries: retained }), { mode: 0o600 });
  renameSync(temporary, file);
}

function mergeCacheKey(origin, head, originMainSha) {
  return JSON.stringify([origin, head, originMainSha]);
}

function safeRefSegment(value, { allowSlash = false } = {}) {
  const permitted = allowSlash ? /[^A-Za-z0-9._/-]+/g : /[^A-Za-z0-9._-]+/g;
  let cleaned = String(value ?? '').replace(permitted, '-').replace(/\/{2,}/g, '/');
  if (!allowSlash) cleaned = cleaned.replaceAll('/', '-');
  cleaned = cleaned.split('/').map((part) => {
    let segment = part.replace(/\.{2,}/g, '.').replace(/^\.+/, '').replace(/\.+$/, '').replace(/\.lock$/i, '');
    return segment || '-';
  }).join('/');
  return cleaned.replace(/^\/+|\/+$/g, '') || 'unknown';
}

// Detached heads have no branch name: back them up under detached-<sha> so they stay reachable.
function backupRef(machine, branch, head) {
  const machinePart = safeRefSegment(machine);
  const branchPart = branch ? safeRefSegment(branch, { allowSlash: true }) : `detached-${String(head).slice(0, 12)}`;
  const ref = `refs/backup/${machinePart}/${branchPart}`;
  return ref.startsWith('refs/backup/') ? ref : null;
}

// A prunable entry may hold the only pointer to its HEAD (detached work). Its metadata is only
// dropped when the commit is reachable from some ref (branch, remote-tracking or backup).
function headReachable(repoPath, head) {
  if (!head) return true;
  try {
    return gitText(repoPath, 'for-each-ref', '--count=1', '--contains', head, '--format=%(refname)') !== '';
  } catch {
    return false;
  }
}

function worktreeEntries(text) {
  const entries = [];
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line) {
      if (current) entries.push(current);
      current = null;
    } else if (line.startsWith('worktree ')) {
      if (current) entries.push(current);
      current = { path: resolve(line.slice(9)), head: '', branch: null, detached: false, prunable: false };
    } else if (current && line.startsWith('HEAD ')) {
      current.head = line.slice(5).trim();
    } else if (current && line.startsWith('branch refs/heads/')) {
      current.branch = line.slice('branch refs/heads/'.length);
    } else if (current && line === 'detached') {
      current.detached = true;
    } else if (current && line.startsWith('prunable')) {
      current.prunable = true;
    }
  }
  if (current) entries.push(current);
  return entries;
}

function findRepositoryCandidates(roots) {
  const candidates = [];
  const seen = new Set();
  const visit = (directory, depth) => {
    const candidate = resolve(directory);
    try {
      if (!statSync(candidate).isDirectory()) return;
      // A broken .git (rev-parse fails) or a repo holding other repos must not stop the walk:
      // V:/Duancanhan/Project_QuanLyGiaiDau has a dead .git with the three real repos below it.
      if (existsSync(join(candidate, '.git')) && !seen.has(candidate)) {
        seen.add(candidate);
        candidates.push(candidate);
      }
      if (depth >= 3) return;
      for (const entry of readdirSync(candidate, { withFileTypes: true }).sort((a, b) =>
        a.name.localeCompare(b.name),
      )) {
        if (!entry.isDirectory() || entry.name === '.git' || entry.name === 'node_modules')
          continue;
        visit(join(candidate, entry.name), depth + 1);
      }
    } catch {
      // An inaccessible root or nested directory does not hide the rest of the scan.
    }
  };
  for (const root of roots ?? []) if (typeof root === 'string' && root) visit(root, 0);
  return candidates;
}

async function findRepositories(roots) {
  const groups = new Map();
  await mapLimit(findRepositoryCandidates(roots), MAX_SCAN_CONCURRENCY, async (candidate) => {
    const result = await runGitAsync(candidate, [
      'rev-parse',
      '--path-format=absolute',
      '--show-toplevel',
      '--git-common-dir',
    ]);
    if (result.status !== 0) return;
    const locations = result.stdout.trim().split(/\r?\n/);
    if (locations.length < 2 || !locations[0] || !locations[1]) return;
    const top = resolve(locations[0]);
    const common = resolve(locations[1]);
    const key = process.platform === 'win32' ? common.toLowerCase() : common;
    if (!groups.has(key)) groups.set(key, { common, path: top });
  });
  return [...groups.values()];
}

async function dirtyPaths(cwd) {
  const status = await runGitAsync(cwd, [
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all',
    '--ignored=matching',
  ]);
  if (status.status !== 0) return { paths: [], ignored: 0, known: false };
  const records = status.stdout.split('\0');
  const paths = [];
  let ignored = 0;
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i];
    if (record.length < 4 || record[2] !== ' ') continue;
    const code = record.slice(0, 2);
    if (code === '!!') {
      ignored += 1;
      continue;
    }
    paths.push(record.slice(3));
    if (code.includes('R') || code.includes('C')) i += 1;
  }
  return { paths, ignored, known: true };
}

function fileTimes(cwd, paths) {
  const times = [];
  for (const path of paths.slice(0, MAX_DIRTY_STAT_PATHS)) {
    try {
      times.push(statSync(resolve(cwd, path)).mtimeMs);
    } catch {
      /* deleted paths have no file timestamp */
    }
  }
  return times;
}

function worktreeGitDir(cwd) {
  try {
    const gitPath = join(cwd, '.git');
    if (statSync(gitPath).isDirectory()) return gitPath;
    const match = /^gitdir:\s*(.+?)\s*$/im.exec(readFileSync(gitPath, 'utf8'));
    return match ? resolve(cwd, match[1]) : null;
  } catch {
    return null;
  }
}

function operationOf(gitDir) {
  if (!gitDir) return null;
  for (const [name, path] of [
    ['rebase', 'rebase-merge'], ['rebase', 'rebase-apply'],
    ['merge', 'MERGE_HEAD'], ['cherry-pick', 'CHERRY_PICK_HEAD'], ['bisect', 'BISECT_LOG'],
  ]) if (existsSync(join(gitDir, path))) return name;
  return null;
}

async function commitMetadata(cwd, head) {
  const [secondsText, tree = ''] = (
    await gitTextAsync(cwd, 'show', '-s', '--format=%ct %T', head)
  ).split(/\s+/, 2);
  const seconds = Number(secondsText);
  return {
    timestamp: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null,
    tree,
  };
}

async function isMergedToMain(cwd, head, headTree, origin, originMainSha, targetTree, cache) {
  if (!originMainSha || !targetTree || !head) return false;
  const key = mergeCacheKey(origin, head, originMainSha);
  if (headTree === targetTree) {
    cache[key] = true;
    return true;
  }
  if (Object.hasOwn(cache, key)) return cache[key];
  const ancestor = await runGitAsync(cwd, ['merge-base', '--is-ancestor', head, originMainSha]);
  if (ancestor.status === 0) {
    cache[key] = true;
    return true;
  }
  if (ancestor.status !== 1) {
    cache[key] = false;
    return false;
  }
  const merge = await runGitAsync(
    cwd,
    ['merge-tree', '--write-tree', originMainSha, head],
    MERGE_TREE_TIMEOUT_MS,
  );
  const merged = merge.status === 0 && merge.stdout.split(/\r?\n/, 1)[0].trim() === targetTree;
  cache[key] = merged;
  return merged;
}

function cachedBackup(entries, origin, machine, branch, head) {
  if (!origin || !head) return false;
  const ref = backupRef(machine, branch, head);
  return Boolean(ref && entries[cacheKey(origin, ref)] === head);
}
function sanitizedOrigin(origin) {
  try {
    const url = new URL(origin);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.href;
  } catch {
    return origin.replace(/\b(https?|ssh):\/\/[^/@\s]+@/gi, '$1://[redacted]@');
  }
}

function addRisk(report, risk) {
  report.risks.push(risk);
}

async function reportWorktree(
  repositoryPath,
  entry,
  origin,
  originMainSha,
  machine,
  backupCache,
  mergeCache,
  targetTree,
  nowMs,
) {
  const exists = existsSync(entry.path);
  const cwd = exists ? entry.path : repositoryPath;
  const head = entry.head || (await gitTextAsync(cwd, 'rev-parse', 'HEAD'));
  const revision = head || 'HEAD';
  const gitDir = exists ? worktreeGitDir(cwd) : null;
  const [unpushedText, dirtyStatus, commit] = await Promise.all([
    gitTextAsync(cwd, 'rev-list', '--count', revision, '--not', '--remotes'),
    exists ? dirtyPaths(cwd) : Promise.resolve({ paths: [], ignored: 0, known: true }),
    commitMetadata(cwd, revision),
  ]);
  const commitTime = commit.timestamp;
  const paths = dirtyStatus.paths;
  const unpushed = Number(unpushedText) || 0;
  const unpushedSubjects =
    unpushed > 0
      ? (
          await gitTextAsync(
            cwd,
            'log',
            `-${MAX_SUBJECTS}`,
            '--format=%s',
            revision,
            '--not',
            '--remotes',
          )
        )
          .split(/\r?\n/)
          .filter(Boolean)
          .slice(0, MAX_SUBJECTS)
      : [];
  const times = exists ? fileTimes(cwd, paths) : [];
  let indexTime = null;
  if (gitDir) {
    try {
      indexTime = statSync(join(gitDir, 'index')).mtimeMs;
    } catch {
      /* unavailable index timestamp */
    }
  }
  const tooManyDirtyPaths = paths.length > MAX_DIRTY_STAT_PATHS;
  const oldestTime = tooManyDirtyPaths ? null : times.length ? Math.min(...times) : null;
  // A partial mtime sample must not make a recently edited worktree appear idle.
  const latestActivity = tooManyDirtyPaths
    ? nowMs
    : Math.max(commitTime ?? 0, indexTime ?? 0, ...times, 0);
  const idleMinutes = Math.max(0, Math.floor((nowMs - latestActivity) / 60_000));
  const idleDays = Math.floor(idleMinutes / (24 * 60));
  const dirtyOldestMinutes =
    oldestTime === null ? null : Math.max(0, Math.floor((nowMs - oldestTime) / 60_000));
  const branch = entry.branch;
  const backedUp = cachedBackup(backupCache, origin, machine, branch, head);
  return {
    path: entry.path,
    branch,
    head,
    unpushed,
    unpushedSubjects,
    backedUp,
    dirty: paths.length,
    dirtyKnown: !exists || dirtyStatus.known,
    ignored: dirtyStatus.ignored,
    dirtyOldestMinutes,
    op: exists ? operationOf(gitDir) : null,
    mergedToMain: await isMergedToMain(
      cwd,
      revision,
      commit.tree,
      origin,
      originMainSha,
      targetTree,
      mergeCache,
    ),
    idleDays,
    idleMinutes,
    prunable: entry.prunable || !exists,
  };
}

function buildRisks(report) {
  for (const repo of report.repos) {
    for (const worktree of repo.worktrees) {
      if (!worktree.dirtyKnown)
        addRisk(report, {
          level: 'red',
          kind: 'dirty',
          repo: repo.repo,
          path: worktree.path,
          detail: 'Không thể xác định tệp đang thay đổi; kiểm tra trạng thái Git trước khi dọn',
        });
      if (worktree.unpushed > 0) {
        addRisk(report, {
          level: worktree.backedUp ? 'yellow' : 'red', kind: 'unpushed', repo: repo.repo, path: worktree.path,
          detail: `${worktree.unpushed} commit chưa nằm trên remote${worktree.backedUp ? '; đã có bản sao lưu' : '; chưa có bản sao lưu'}`,
        });
      }
      if (worktree.dirty > 0) {
        const old = worktree.dirtyOldestMinutes;
        addRisk(report, {
          level: old !== null && old > 24 * 60 ? 'red' : 'yellow', kind: 'dirty', repo: repo.repo, path: worktree.path,
          detail: `${worktree.dirty} tệp đang thay đổi${old === null ? '' : `; lâu nhất ${old} phút`}`,
        });
      }
      if (worktree.op) addRisk(report, { level: 'red', kind: 'op', repo: repo.repo, path: worktree.path, detail: `Thao tác ${worktree.op} chưa hoàn tất` });
      if (worktree.prunable) addRisk(report, { level: 'yellow', kind: 'prunable', repo: repo.repo, path: worktree.path, detail: 'Worktree không còn thư mục và có thể dọn' });
      if (worktree.branch === null) {
        const refs = gitText(repo.repo, 'branch', '--all', '--contains', worktree.head, '--format=%(refname)');
        if (!refs) addRisk(report, { level: 'red', kind: 'detached', repo: repo.repo, path: worktree.path, detail: 'Commit detached không thuộc nhánh nào' });
      }
    }
    if (repo.stashes > 0) addRisk(report, { level: 'yellow', kind: 'stash', repo: repo.repo, path: repo.repo, detail: `${repo.stashes} stash đang tồn tại` });
  }
}

export function classifyWorktree(worktree, { sessionOpen = false, taskRunning = false } = {}) {
  if (sessionOpen || taskRunning) return 'doing';
  if (worktree.prunable) return 'trash';
  const idleMinutes = Number.isFinite(worktree.idleMinutes)
    ? worktree.idleMinutes
    : worktree.idleDays * 24 * 60;
  if (
    worktree.dirtyKnown === true &&
    worktree.dirty === 0 &&
    worktree.ignored === 0 &&
    worktree.mergedToMain &&
    worktree.unpushed === 0 &&
    idleMinutes >= 60
  )
    return 'trash';
  if (worktree.mergedToMain || worktree.idleDays >= 7) return 'sleeping';
  return 'doing';
}

function normalizedPath(path) {
  const value = resolve(path);
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

function isInsideOrEqual(path, root) {
  return path === root || path.startsWith(`${root}${process.platform === 'win32' ? '\\' : '/'}`);
}

function taskSlugMatches(path, slugs) {
  const parts = path.split(/[\\/]/);
  return slugs.some((slug) =>
    parts.some((part) => part.toLowerCase() === slug || part.toLowerCase().endsWith(`-${slug}`)),
  );
}

/** Remove only idle, clean worktrees already represented by origin/main; leave refs intact. */
export function prune(
  report,
  { activePaths = [], activeBranches = [], activeTaskSlugs = [] } = {},
) {
  if (!report || typeof report !== 'object' || !Array.isArray(report.repos))
    throw new TypeError('prune expects a scan report');
  const paths = activePaths.map(normalizedPath);
  const branches = new Set(activeBranches);
  const slugs = activeTaskSlugs.map((slug) => String(slug).toLowerCase());
  let removed = 0;
  let skipped = 0;
  for (const repo of report.repos) {
    let pruneMetadata = false;
    let protectedPrunable = false;
    const repoPath = normalizedPath(repo.repo);
    for (const worktree of repo.worktrees ?? []) {
      if (normalizedPath(worktree.path) === repoPath) continue;
      const path = normalizedPath(worktree.path);
      const active =
        paths.some(
          (activePath) =>
            isInsideOrEqual(activePath, path) ||
            (activePath !== repoPath && isInsideOrEqual(path, activePath)),
        ) ||
        (worktree.branch !== null && branches.has(worktree.branch)) ||
        taskSlugMatches(path, slugs);
      const idleMinutes = Number.isFinite(worktree.idleMinutes)
        ? worktree.idleMinutes
        : worktree.idleDays * 24 * 60;
      if (active) {
        if (worktree.prunable) protectedPrunable = true;
        if (
          worktree.prunable ||
          (worktree.dirty === 0 &&
            worktree.ignored === 0 &&
            worktree.mergedToMain &&
            worktree.unpushed === 0 &&
            idleMinutes >= 60)
        )
          skipped += 1;
        continue;
      }
      if (worktree.prunable) {
        if (worktree.branch === null && !headReachable(repo.repo, worktree.head)) protectedPrunable = true;
        else pruneMetadata = true;
        continue;
      }
      if (worktree.op !== null && worktree.op !== undefined) {
        skipped += 1;
        continue;
      }

      if (
        worktree.branch === null ||
        worktree.dirtyKnown !== true ||
        worktree.dirty !== 0 ||
        worktree.ignored !== 0 ||
        worktree.unpushed !== 0 ||
        !worktree.mergedToMain ||
        !Number.isFinite(idleMinutes) ||
        idleMinutes < 60
      )
        continue;
      const result = runGit(repo.repo, ['worktree', 'remove', worktree.path]);
      if (result.status === 0) removed += 1;
      else skipped += 1;
    }
    if (pruneMetadata && !protectedPrunable) runGit(repo.repo, ['worktree', 'prune']);
  }
  return { removed, skipped };
}

async function mapLimit(items, limit, map) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next;
        next += 1;
        results[index] = await map(items[index]);
      }
    }),
  );
  return results;
}

async function refreshOrigins(roots) {
  const groups = await findRepositories(roots);
  await mapLimit(groups, MAX_SCAN_CONCURRENCY, async (group) => {
    if (!(await gitTextAsync(group.path, 'remote', 'get-url', 'origin'))) return;
    await runGitAsync(group.path, ['fetch', '--no-tags', '--quiet', 'origin'], 15_000);
  });
}

/** Scan local repositories and their linked worktrees without fetching unless explicitly requested. */
export async function scan({
  roots = [process.cwd()],
  machine = hostname(),
  now = Date.now(),
} = {}) {
  const nowMs = currentTime(now);
  const backupCache = readCache();
  const mergeCache = readMergedCache();
  const cachedMergeCount = Object.keys(mergeCache).length;
  const report = {
    machine: String(machine),
    scannedAt: new Date(nowMs).toISOString(),
    repos: [],
    risks: [],
  };
  gitCommandProfile.clear();
  const discoveryStart = process.hrtime.bigint();
  const groups = await findRepositories(roots);
  profilePhase('repository discovery', discoveryStart, ` groups=${groups.length}`);
  const metadataStart = process.hrtime.bigint();
  const repositories = await mapLimit(groups, MAX_SCAN_CONCURRENCY, async (group) => {
    const entries = worktreeEntries(
      await gitTextAsync(group.path, 'worktree', 'list', '--porcelain'),
    );
    if (!entries.length) return null;
    const repoPath = entries[0].path;
    const [remote, originMainSha, stashesText] = await Promise.all([
      gitTextAsync(repoPath, 'remote', 'get-url', 'origin'),
      gitTextAsync(repoPath, 'rev-parse', 'origin/main'),
      gitTextAsync(repoPath, 'stash', 'list', '--format=%H'),
    ]);
    const origin = remote ? sanitizedOrigin(remote) : null;
    const targetTree = originMainSha
      ? await gitTextAsync(repoPath, 'show', '-s', '--format=%T', originMainSha)
      : '';
    return {
      repo: repoPath,
      origin,
      originMainSha,
      targetTree,
      entries,
      stashes: stashesText.split(/\r?\n/).filter(Boolean).length,
      worktrees: [],
    };
  });
  profilePhase('repository metadata', metadataStart);
  const repositoriesFound = repositories.filter(Boolean);
  const worktreeTasks = repositoriesFound.flatMap((repo) =>
    repo.entries.map((entry) => ({ repo, entry })),
  );
  const worktreeStart = process.hrtime.bigint();
  const scannedWorktrees = await mapLimit(worktreeTasks, MAX_SCAN_CONCURRENCY, ({ repo, entry }) =>
    reportWorktree(
      repo.repo,
      entry,
      repo.origin,
      repo.originMainSha,
      report.machine,
      backupCache,
      mergeCache,
      repo.targetTree,
      nowMs,
    ),
  );
  profilePhase('worktree scan', worktreeStart, ` worktrees=${worktreeTasks.length}`);
  for (let i = 0; i < worktreeTasks.length; i += 1)
    worktreeTasks[i].repo.worktrees.push(scannedWorktrees[i]);
  report.repos = repositoriesFound.map(({ repo, origin, stashes, worktrees }) => ({
    repo,
    origin,
    worktrees,
    stashes,
  }));
  const riskStart = process.hrtime.bigint();
  buildRisks(report);
  profilePhase('risk aggregation', riskStart);
  if (Object.keys(mergeCache).length !== cachedMergeCount) writeMergedCache(mergeCache);
  reportGitProfile();
  return report;
}

function refreshRisk(report, repo, worktree, errorText = '') {
  report.risks = report.risks.filter((risk) => !(risk.kind === 'unpushed' && risk.path === worktree.path));
  if (worktree.unpushed > 0) {
    report.risks.push({
      level: worktree.backedUp ? 'yellow' : 'red', kind: 'unpushed', repo: repo.repo, path: worktree.path,
      detail: `${worktree.unpushed} commit chưa nằm trên remote${worktree.backedUp ? '; đã có bản sao lưu' : `; sao lưu thất bại: ${errorText}`}`,
    });
  }
}

// The backup ref is about to move. If the new head does not contain the old one (rebase, reset,
// amend), the old head may have no other ref: keep it under <ref>--<sha12> first. Returns null when
// it is safe to overwrite, otherwise the reason (the caller must then leave the backup ref alone).
function archiveRewrittenBackup(repoPath, cwd, ref, head) {
  let previous = gitText(repoPath, 'rev-parse', '--verify', '--quiet', ref);
  if (!previous) {
    const remote = runGit(cwd, ['ls-remote', 'origin', ref], BACKUP_TIMEOUT_MS);
    if (remote.status !== 0) return 'không đọc được ref sao lưu trên origin';
    previous = remote.stdout.trim().split(/\s+/)[0] ?? '';
  }
  if (!previous || previous === head) return null;
  const local = () => runGit(repoPath, ['cat-file', '-e', `${previous}^{commit}`]).status === 0;
  // Made by another clone: bring the old commit here so it can be kept and compared.
  if (!local() && runGit(cwd, ['fetch', '--no-tags', 'origin', ref], BACKUP_TIMEOUT_MS).status !== 0) {
    return 'không tải được bản sao lưu cũ';
  }
  if (!local()) return 'bản sao lưu cũ không có trên máy';
  if (runGit(repoPath, ['merge-base', '--is-ancestor', previous, head]).status === 0) return null;
  const archive = `${ref}--${previous.slice(0, 12)}`;
  runGit(repoPath, ['update-ref', archive, previous]);
  const pushed = runGit(cwd, ['push', '--no-verify', 'origin', `${previous}:${archive}`], BACKUP_TIMEOUT_MS);
  return pushed.status === 0 ? null : 'push bản cũ bị từ chối';
}

/** Push unpushed worktree heads only to refs/backup/<machine>/<branch>, never to branch refs. */
export function backup(report, { dryRun = false } = {}) {
  if (!report || typeof report !== 'object' || !Array.isArray(report.repos)) throw new TypeError('backup expects a scan report');
  const entries = readCache();
  let cacheChanged = false;
  for (const repo of report.repos) {
    if (!repo.origin) continue;
    for (const worktree of repo.worktrees ?? []) {
      if (worktree.unpushed <= 0 || !worktree.head) continue;
      const ref = backupRef(report.machine, worktree.branch, worktree.head);
      if (!ref || !ref.startsWith('refs/backup/')) {
        worktree.backedUp = false;
        refreshRisk(report, repo, worktree, 'tên ref không hợp lệ');
        continue;
      }
      if (dryRun) continue;
      const cwd = existsSync(worktree.path) ? worktree.path : repo.repo;
      const kept = archiveRewrittenBackup(repo.repo, cwd, ref, worktree.head);
      if (kept !== null) {
        worktree.backedUp = false;
        refreshRisk(report, repo, worktree, `không cất được bản sao lưu cũ: ${kept}`);
        continue;
      }
      const pushed = runGit(cwd, ['push', '--no-verify', 'origin', `+${worktree.head}:${ref}`], BACKUP_TIMEOUT_MS);
      if (pushed.status === 0) {
        worktree.backedUp = true;
        // Same ref locally: the commit stays reachable here too (gc, worktree prune) without a fetch.
        runGit(repo.repo, ['update-ref', ref, worktree.head]);
        entries[cacheKey(repo.origin, ref)] = worktree.head;
        cacheChanged = true;
        refreshRisk(report, repo, worktree);
      } else {
        worktree.backedUp = false;
        const detail = (pushed.stderr || pushed.stdout || 'không có quyền push hoặc remote không truy cập được')
          .replace(/https?:\/\/[^/@\s]+@/gi, 'https://[redacted]@')
          .trim().replace(/[\r\n]+/g, ' ').slice(0, 240);
        refreshRisk(report, repo, worktree, detail);
      }
    }
  }
  if (cacheChanged) writeCache(entries);
  return report;
}

function printSummary(report) {
  const worktreeCount = report.repos.reduce((sum, repo) => sum + repo.worktrees.length, 0);
  console.log(`git-guard: ${report.machine} — ${report.repos.length} repo, ${worktreeCount} worktree, ${report.risks.length} rủi ro`);
  for (const risk of report.risks) console.log(`[${risk.level.toUpperCase()}] ${risk.kind} ${risk.repo} :: ${risk.path} — ${risk.detail}`);
  if (!report.risks.length) console.log('Không phát hiện rủi ro.');
}

async function cli(argv) {
  const roots = [];
  const activePaths = [];
  const activeBranches = [];
  const activeTaskSlugs = [];
  let machine = hostname();
  let doBackup = false;
  let doPrune = false;
  let doFetch = false;
  let json = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--root' && argv[i + 1]) roots.push(argv[++i]);
    else if (arg === '--machine' && argv[i + 1]) machine = argv[++i];
    else if (arg === '--backup') doBackup = true;
    else if (arg === '--json') json = true;
    else if (arg === '--prune') doPrune = true;
    else if (arg === '--fetch') doFetch = true;
    else if (arg === '--active-path' && argv[i + 1]) activePaths.push(argv[++i]);
    else if (arg === '--active-branch' && argv[i + 1]) activeBranches.push(argv[++i]);
    else if (arg === '--active-task' && argv[i + 1]) activeTaskSlugs.push(argv[++i]);
    else throw new Error(`Tham số không hợp lệ: ${arg}`);
  }
  const scanRoots = roots.length ? roots : [process.cwd()];
  if (doFetch) await refreshOrigins(scanRoots);
  const report = await scan({ roots: scanRoots, machine });
  if (doBackup) backup(report);
  const pruned = doPrune ? prune(report, { activePaths, activeBranches, activeTaskSlugs }) : null;
  if (json)
    console.log(
      JSON.stringify({ ...report, ...(pruned === null ? {} : { prune: pruned }) }, null, 2),
    );
  else {
    printSummary(report);
    if (pruned)
      console.log(`git-guard: đã dọn ${pruned.removed} worktree, bỏ qua ${pruned.skipped}`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  void cli(process.argv.slice(2)).catch((error) => {
    console.error(`git-guard: ${error.message}`);
    process.exitCode = 1;
  });
}

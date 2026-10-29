import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DAY_MS = 24 * 60 * 60 * 1000;
const GIT_TIMEOUT_MS = 2_000;
const BACKUP_TIMEOUT_MS = 5_000;
const MAX_SUBJECTS = 5;

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

function backupRef(machine, branch) {
  const machinePart = safeRefSegment(machine);
  const branchPart = safeRefSegment(branch, { allowSlash: true });
  const ref = `refs/backup/${machinePart}/${branchPart}`;
  return ref.startsWith('refs/backup/') ? ref : null;
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

function findRepositories(roots) {
  const groups = new Map();
  const visit = (directory, depth) => {
    const path = resolve(directory);
    try {
      if (!statSync(path).isDirectory()) return;
      if (existsSync(join(path, '.git'))) {
        const locations = gitText(path, 'rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir').split(/\r?\n/);
        if (locations.length >= 2 && locations[0] && locations[1]) {
          const top = resolve(locations[0]);
          const common = resolve(locations[1]);
          const key = process.platform === 'win32' ? common.toLowerCase() : common;
          if (!groups.has(key)) groups.set(key, { common, path: top });
        }
        return;
      }
      if (depth >= 3) return;
      for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (!entry.isDirectory() || entry.name === '.git' || entry.name === 'node_modules') continue;
        visit(join(path, entry.name), depth + 1);
      }
    } catch {
      // An inaccessible root or nested directory does not hide the rest of the scan.
    }
  };
  for (const root of roots ?? []) if (typeof root === 'string' && root) visit(root, 0);
  return [...groups.values()];
}

function dirtyPaths(cwd) {
  const status = runGit(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  if (status.status !== 0) return [];
  const records = status.stdout.split('\0');
  const paths = [];
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i];
    if (record.length < 4 || record[2] !== ' ') continue;
    const code = record.slice(0, 2);
    paths.push(record.slice(3));
    if (code.includes('R') || code.includes('C')) i += 1;
  }
  return paths;
}

function fileTimes(cwd, paths) {
  const times = [];
  for (const path of paths) {
    try { times.push(statSync(resolve(cwd, path)).mtimeMs); } catch { /* deleted paths have no file timestamp */ }
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

function commitTimestamp(cwd, head) {
  const seconds = Number(gitText(cwd, 'show', '-s', '--format=%ct', head));
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
}

function isMergedToMain(cwd, head, targetTree) {
  if (!targetTree) return false;
  const merge = runGit(cwd, ['merge-tree', '--write-tree', 'origin/main', head]);
  return merge.status === 0 && merge.stdout.split(/\r?\n/, 1)[0].trim() === targetTree;
}

function cachedBackup(entries, origin, machine, branch, head) {
  if (!origin || !branch || !head) return false;
  const ref = backupRef(machine, branch);
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

function reportWorktree(repositoryPath, entry, origin, machine, cache, targetTree, nowMs) {
  const exists = existsSync(entry.path);
  const cwd = exists ? entry.path : repositoryPath;
  const head = entry.head || gitText(cwd, 'rev-parse', 'HEAD');
  const revision = head || 'HEAD';
  const unpushed = Number(gitText(cwd, 'rev-list', '--count', revision, '--not', '--remotes')) || 0;
  const unpushedSubjects = unpushed > 0
    ? gitText(cwd, 'log', `-${MAX_SUBJECTS}`, '--format=%s', revision, '--not', '--remotes').split(/\r?\n/).filter(Boolean).slice(0, MAX_SUBJECTS)
    : [];
  const paths = exists ? dirtyPaths(cwd) : [];
  const times = exists ? fileTimes(cwd, paths) : [];
  const gitDir = exists ? worktreeGitDir(cwd) : null;
  if (paths.length && !times.length && gitDir) {
    try { times.push(statSync(join(gitDir, 'index')).mtimeMs); } catch { /* unavailable index timestamp */ }
  }
  const oldestTime = times.length ? Math.min(...times) : null;
  const latestEdit = Math.max(commitTimestamp(cwd, revision) ?? 0, ...times, 0);
  const idleDays = Math.max(0, Math.floor((nowMs - latestEdit) / DAY_MS));
  const dirtyOldestMinutes = oldestTime === null ? null : Math.max(0, Math.floor((nowMs - oldestTime) / 60_000));
  const branch = entry.branch;
  const backedUp = cachedBackup(cache, origin, machine, branch, head);
  const worktree = {
    path: entry.path,
    branch,
    head,
    unpushed,
    unpushedSubjects,
    backedUp,
    dirty: paths.length,
    dirtyOldestMinutes,
    op: exists ? operationOf(gitDir) : null,
    mergedToMain: Boolean(head && isMergedToMain(cwd, revision, targetTree)),
    idleDays,
    prunable: entry.prunable || !exists,
  };
  return worktree;
}

function buildRisks(report) {
  for (const repo of report.repos) {
    for (const worktree of repo.worktrees) {
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

/** Scan local repositories and their linked worktrees without fetching from any remote. */
export function scan({ roots = [process.cwd()], machine = hostname(), now = Date.now() } = {}) {
  const nowMs = currentTime(now);
  const cache = readCache();
  const report = { machine: String(machine), scannedAt: new Date(nowMs).toISOString(), repos: [], risks: [] };
  for (const group of findRepositories(roots)) {
    const entries = worktreeEntries(gitText(group.path, 'worktree', 'list', '--porcelain'));
    if (!entries.length) continue;
    const repoPath = entries[0].path;
    const remote = gitText(repoPath, 'remote', 'get-url', 'origin');
    const origin = remote ? sanitizedOrigin(remote) : null;
    const targetTree = gitText(repoPath, 'show', '-s', '--format=%T', 'origin/main');
    const worktrees = entries.map((entry) => reportWorktree(repoPath, entry, origin, report.machine, cache, targetTree, nowMs));
    const stashes = gitText(repoPath, 'stash', 'list', '--format=%H').split(/\r?\n/).filter(Boolean).length;
    report.repos.push({ repo: repoPath, origin, worktrees, stashes });
  }
  buildRisks(report);
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

/** Push unpushed worktree heads only to refs/backup/<machine>/<branch>, never to branch refs. */
export function backup(report, { dryRun = false } = {}) {
  if (!report || typeof report !== 'object' || !Array.isArray(report.repos)) throw new TypeError('backup expects a scan report');
  const entries = readCache();
  let cacheChanged = false;
  for (const repo of report.repos) {
    if (!repo.origin) continue;
    for (const worktree of repo.worktrees ?? []) {
      if (worktree.unpushed <= 0 || worktree.branch === null || !worktree.branch || !worktree.head) continue;
      const ref = backupRef(report.machine, worktree.branch);
      if (!ref || !ref.startsWith('refs/backup/')) {
        worktree.backedUp = false;
        refreshRisk(report, repo, worktree, 'tên ref không hợp lệ');
        continue;
      }
      if (dryRun) continue;
      const cwd = existsSync(worktree.path) ? worktree.path : repo.repo;
      const pushed = runGit(cwd, ['push', '--no-verify', 'origin', `+${worktree.head}:${ref}`], BACKUP_TIMEOUT_MS);
      if (pushed.status === 0) {
        worktree.backedUp = true;
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

function cli(argv) {
  const roots = [];
  let machine = hostname();
  let doBackup = false;
  let json = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--root' && argv[i + 1]) roots.push(argv[++i]);
    else if (arg === '--machine' && argv[i + 1]) machine = argv[++i];
    else if (arg === '--backup') doBackup = true;
    else if (arg === '--json') json = true;
    else throw new Error(`Tham số không hợp lệ: ${arg}`);
  }
  const report = scan({ roots: roots.length ? roots : [process.cwd()], machine });
  if (doBackup) backup(report);
  if (json) console.log(JSON.stringify(report, null, 2));
  else printSummary(report);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try { cli(process.argv.slice(2)); }
  catch (error) {
    console.error(`git-guard: ${error.message}`);
    process.exitCode = 1;
  }
}

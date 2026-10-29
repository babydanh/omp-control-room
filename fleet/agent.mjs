// fleet-agent: one report (sessions, branches, dirty file paths) signed with this machine's Ed25519 key.
// Run by a systemd timer. Env: FLEET_HUB (https URL), FLEET_ID, FLEET_KEY (private key PEM path),
// FLEET_ROOT (default /data/home). Sends paths and branch names only; never file content.
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync, readlinkSync, statfsSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { signJwt } from './jwt.mjs';

const ROOT = process.env.FLEET_ROOT ?? '/data/home';
const ENGINES = { claude: /(^|\/)claude$/, codex: /(^|\/)codex$/, omp: /(^|\/)omp$/ };

const git = (cwd, ...args) => {
  try { return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 5000 }).trim(); } catch { return ''; }
};

function sessions() {
  const out = [];
  for (const pid of readdirSync('/proc').filter((p) => /^\d+$/.test(p))) {
    let argv;
    try { argv = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean); } catch { continue; }
    const exe = argv.find((a) => !a.startsWith('-') && !/node$|bun$/.test(a)) ?? '';
    const engine = Object.keys(ENGINES).find((k) => ENGINES[k].test(exe));
    if (!engine) continue;
    let cwd = '';
    try { cwd = readlinkSync(`/proc/${pid}/cwd`); } catch { /* exited */ }
    out.push({ engine, pid: Number(pid), cwd, branch: cwd ? git(cwd, 'branch', '--show-current') : '' });
  }
  return out;
}

/**
 * tmux sessions on this machine: name, attached, idle time, the active pane's command and branch.
 * Metadata only: screen content never leaves the machine (the board attaches over SSH on demand).
 */
export function parseTmux(text, nowSec, branchOf = () => '') {
  return text.split('\n').filter(Boolean).map((line) => {
    const [name, attached, activity, cwd, command] = line.split('\t');
    return {
      name,
      attached: Number(attached) > 0,
      idle_seconds: Math.max(0, nowSec - Number(activity || nowSec)),
      command: command ?? '',
      branch: cwd ? branchOf(cwd) : '',
    };
  }).filter((s) => s.name).slice(0, 30);
}

function tmuxSessions() {
  let text = '';
  try {
    text = execFileSync('tmux', ['list-sessions', '-F', '#{session_name}\t#{session_attached}\t#{session_activity}\t#{pane_current_path}\t#{pane_current_command}'],
      { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch { return []; }   // no tmux server = no sessions
  return parseTmux(text, Math.floor(Date.now() / 1000), (cwd) => git(cwd, 'branch', '--show-current'));
}

/** Open Lavish review sessions (key + artifact path) from lavish-axi's state file; never the artifact itself. */
export function parseLavish(stateText) {
  let sessions;
  try { sessions = JSON.parse(stateText).sessions; } catch { return []; }
  if (!sessions || typeof sessions !== 'object') return [];
  return Object.values(sessions)
    .filter((s) => s && /^[a-f0-9]{8,64}$/.test(String(s.key)) && typeof s.file === 'string' && !/^(ended|closed)$/.test(String(s.status)))
    .map((s) => ({ key: s.key, file: s.file }))
    .slice(0, 20);
}

function lavishSessions() {
  try { return parseLavish(readFileSync(join(process.env.HOME ?? ROOT, '.lavish-axi', 'state.json'), 'utf8')); } catch { return []; }
}


// Refresh origin/main and origin/staging at most every 5 minutes, not every 30 s report.
function refreshRemotes(repoRoots) {
  const stamp = join(process.env.HOME ?? '/tmp', '.fleet', 'last-fetch');
  try { if (Date.now() - statSync(stamp).mtimeMs < 300_000) return; } catch { /* first run */ }
  for (const root of repoRoots) git(root, 'fetch', '-q', 'origin', 'main', 'staging');
  writeFileSync(stamp, '');
}

/** True when merging HEAD into `ref` changes nothing (content check: also catches squash merges). */
function contentIn(path, ref) {
  const target = git(path, 'rev-parse', `${ref}^{tree}`);
  return Boolean(target) && git(path, 'merge-tree', '--write-tree', ref, 'HEAD').split('\n')[0] === target;
}

/**
 * Changed line ranges per file, in the coordinates of the merge base with origin/main, covering
 * committed and uncommitted edits. Line numbers only, never content. Approximate: machines on
 * different bases can be a few lines off; the local overlap.py merge-tree check is exact.
 */
function changedRanges(path) {
  const base = git(path, 'merge-base', 'origin/main', 'HEAD');
  if (!base) return [];
  const out = git(path, 'diff', '-U0', '--no-color', '--no-ext-diff', base, '--');
  const files = new Map();
  let current = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('--- ')) { current = line === '--- /dev/null' ? null : line.slice(6); continue; }
    if (line.startsWith('+++ ') && current === null && line !== '+++ /dev/null') { current = line.slice(6); continue; }
    const hunk = /^@@ -(\d+)(?:,(\d+))? /.exec(line);
    if (!hunk || current === null) continue;
    const start = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    const ranges = files.get(current) ?? [];
    if (ranges.length < 20) ranges.push([Math.max(start, 1), Math.max(start, 1) + Math.max(count, 1) - 1]);
    files.set(current, ranges);
  }
  return [...files].slice(0, 200).map(([file, ranges]) => ({ path: file, ranges }));
}

function repos() {
  const roots = [];
  for (const name of readdirSync(ROOT)) {
    const dir = join(ROOT, name);
    if (existsSync(join(dir, '.git'))) roots.push(dir);
    // `wt/` holds the worktrees cloud-giao creates (wt/<repo>-<task>, or wt/<task>/<repo> for an all-repo task);
    // `*.worktrees/` the ones made by hand.
    if (name === 'wt' || name.endsWith('.worktrees')) {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (existsSync(join(path, '.git'))) roots.push(path);
        else if (name === 'wt' && statSync(path).isDirectory()) {
          for (const inner of readdirSync(path)) if (existsSync(join(path, inner, '.git'))) roots.push(join(path, inner));
        }
      }
    }
  }
  refreshRemotes(roots.filter((p) => existsSync(join(p, '.git')) && statSync(join(p, '.git')).isDirectory()));
  return roots.map((path) => {
    const counts = git(path, 'rev-list', '--left-right', '--count', '@{upstream}...HEAD').split(/\s+/);
    // The main checkout's folder name, also for worktrees (wt/backend-xep-san -> HethongBackendApi_...).
    const common = git(path, 'rev-parse', '--path-format=absolute', '--git-common-dir');
    return {
      path,
      repo: common ? basename(dirname(common)) : basename(path),
      branch: git(path, 'branch', '--show-current'),
      behind: Number(counts[0]) || 0,
      ahead: Number(counts[1]) || 0,
      merged: contentIn(path, 'origin/main'),
      staged: contentIn(path, 'origin/staging'),
      dirty_files: git(path, 'status', '--porcelain').split('\n').filter(Boolean).map((l) => l.slice(3)).slice(0, 200),
      changes: changedRanges(path),
    };
  });
}

function diskFreeGb() {
  try {
    const { bavail, bsize } = statfsSync(ROOT);
    return Math.round((bavail * bsize) / 1e8) / 10;
  } catch { return null; }
}

/**
 * Keep the report under the hub's 64 KB limit: drop per-file line ranges from the largest repos
 * first (dirty_files stay, so overlaps fall back to file level) and flag what was cut.
 */
export function fitReport(report, limit = 60_000) {
  const size = () => Buffer.byteLength(JSON.stringify(report));
  const byChanges = [...report.repos].sort((a, b) => (b.changes?.length ?? 0) - (a.changes?.length ?? 0));
  for (const repo of byChanges) {
    if (size() <= limit) break;
    if (repo.changes?.length) { repo.changes = []; repo.changes_truncated = true; }
  }
  for (const repo of report.repos) {
    if (size() <= limit) break;
    if (repo.dirty_files.length > 20) { repo.dirty_files = repo.dirty_files.slice(0, 20); repo.dirty_truncated = true; }
  }
  // Last resort: keep only branch-level data, then drop repos from the end.
  for (const repo of report.repos) {
    if (size() <= limit) break;
    repo.dirty_files = []; repo.dirty_truncated = true;
  }
  while (size() > limit && report.repos.length > 0) { report.repos.pop(); report.repos_truncated = true; }
  if (size() > limit) throw new Error(`report still ${size()} bytes after trimming`);
  return report;
}

if (process.env.FLEET_ID) {
const id = process.env.FLEET_ID;
const token = signJwt({ iss: id, aud: 'fleet-hub', role: 'report' }, readFileSync(process.env.FLEET_KEY, 'utf8'));
const res = await fetch(`${process.env.FLEET_HUB}/v1/report`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(fitReport({ agent_id: id, disk_free_gb: diskFreeGb(), sessions: sessions(), tmux: tmuxSessions(), lavish: lavishSessions(), repos: repos() })),
  signal: AbortSignal.timeout(15000),
}).catch((e) => ({ status: 0, text: async () => e.message }));
if (res.status !== 200) {
  console.error(`fleet-agent: hub ${res.status} ${await res.text()}`);
  process.exit(1);
}
}

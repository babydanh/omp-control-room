// fleet-agent: one report (sessions, branches, dirty file paths) signed with this machine's Ed25519 key.
// Run by a systemd timer. Env: FLEET_HUB (https URL), FLEET_ID, FLEET_KEY (private key PEM path),
// FLEET_ROOT (default /data/home). Sends paths and branch names only; never file content.
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync, readlinkSync, statfsSync } from 'node:fs';
import { join } from 'node:path';
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

function repos() {
  const roots = [];
  for (const name of readdirSync(ROOT)) {
    const dir = join(ROOT, name);
    if (existsSync(join(dir, '.git'))) roots.push(dir);
    if (name.endsWith('.worktrees')) for (const wt of readdirSync(dir)) roots.push(join(dir, wt));
  }
  return roots.map((path) => {
    const counts = git(path, 'rev-list', '--left-right', '--count', '@{upstream}...HEAD').split(/\s+/);
    // Content-level check (catches squash merges): merging HEAD into origin/main changes nothing.
    const mergedTree = git(path, 'merge-tree', '--write-tree', 'origin/main', 'HEAD').split('\n')[0];
    const mainTree = git(path, 'rev-parse', 'origin/main^{tree}');
    return {
      path,
      branch: git(path, 'branch', '--show-current'),
      behind: Number(counts[0]) || 0,
      ahead: Number(counts[1]) || 0,
      merged: Boolean(mainTree) && mergedTree === mainTree,
      dirty_files: git(path, 'status', '--porcelain').split('\n').filter(Boolean).map((l) => l.slice(3)).slice(0, 200),
    };
  });
}

function diskFreeGb() {
  try {
    const { bavail, bsize } = statfsSync(ROOT);
    return Math.round((bavail * bsize) / 1e8) / 10;
  } catch { return null; }
}

const id = process.env.FLEET_ID;
const token = signJwt({ iss: id, aud: 'fleet-hub', role: 'report' }, readFileSync(process.env.FLEET_KEY, 'utf8'));
const res = await fetch(`${process.env.FLEET_HUB}/v1/report`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ agent_id: id, disk_free_gb: diskFreeGb(), sessions: sessions(), repos: repos() }),
  signal: AbortSignal.timeout(15000),
}).catch((e) => ({ status: 0, text: async () => e.message }));
if (res.status !== 200) {
  console.error(`fleet-agent: hub ${res.status} ${await res.text()}`);
  process.exit(1);
}

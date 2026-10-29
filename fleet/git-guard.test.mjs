import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { backup, classifyWorktree, prune, scan } from './git-guard.mjs';

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const gitDir = (dir, ...args) => execFileSync('git', [`--git-dir=${dir}`, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function fixture(t) {
  const temp = mkdtempSync(join(tmpdir(), 'git-guard-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const source = join(temp, 'source');
  const scanRoot = join(temp, 'scan');
  const origin = join(temp, 'origin.git');
  const main = join(scanRoot, 'main');
  const worktree = join(scanRoot, 'worktrees', 'feature');
  mkdirSync(scanRoot);
  mkdirSync(source);
  git(source, 'init', '-b', 'main');
  git(source, 'config', 'user.name', 'Git Guard Test');
  git(source, 'config', 'user.email', 'git-guard@example.invalid');
  writeFileSync(join(source, 'README.txt'), 'initial\n');
  git(source, 'add', 'README.txt');
  git(source, 'commit', '-m', 'initial');
  execFileSync('git', ['clone', '--bare', source, origin], { stdio: ['ignore', 'pipe', 'pipe'] });
  execFileSync('git', ['clone', origin, main], { stdio: ['ignore', 'pipe', 'pipe'] });
  git(main, 'config', 'user.name', 'Git Guard Test');
  git(main, 'config', 'user.email', 'git-guard@example.invalid');
  mkdirSync(join(scanRoot, 'worktrees'));
  git(main, 'worktree', 'add', '-b', 'feat/guard', worktree);
  writeFileSync(join(worktree, 'feature.txt'), 'feature\n');
  git(worktree, 'add', 'feature.txt');
  git(worktree, 'commit', '-m', 'unpublished work');
  return { temp, scanRoot, origin, main, worktree };
}

function restoreHome(t, directory) {
  const oldHome = process.env.HOME;
  const oldUserProfile = process.env.USERPROFILE;
  process.env.HOME = directory;
  process.env.USERPROFILE = directory;
  t.after(() => {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    if (oldUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = oldUserProfile;
  });
}

const reportFor = (root, now = Date.now()) => scan({ roots: [root], machine: 'test-machine', now });
const featureOf = (report) => report.repos.flatMap((repo) => repo.worktrees).find((worktree) => worktree.branch === 'feat/guard');

test('scan finds local unpushed commits and reports them as red until backed up', async (t) => {
  const f = fixture(t);
  restoreHome(t, f.temp);
  const report = await reportFor(f.scanRoot);
  const feature = featureOf(report);
  assert.ok(feature, 'the linked worktree is reported under its main repository');
  assert.equal(feature.unpushed, 1);
  assert.deepEqual(feature.unpushedSubjects, ['unpublished work']);
  assert.equal(feature.backedUp, false);
  assert.ok(report.risks.some((risk) => risk.kind === 'unpushed' && risk.level === 'red' && risk.path === f.worktree));
});

test('scan keeps looking below an unusable git directory', async (t) => {
  const f = fixture(t);
  restoreHome(t, f.temp);
  const brokenRoot = join(f.temp, 'broken-root');
  mkdirSync(join(brokenRoot, '.git'), { recursive: true });
  const nested = join(brokenRoot, 'nested');
  execFileSync('git', ['clone', f.origin, nested], { stdio: ['ignore', 'pipe', 'pipe'] });
  const report = await reportFor(brokenRoot);
  assert.ok(report.repos.some((repo) => repo.repo === nested));
});

test('backup pushes only the backup ref and cached scan reports the worktree as yellow', async (t) => {
  const f = fixture(t);
  restoreHome(t, f.temp);
  const mainBefore = gitDir(f.origin, 'rev-parse', 'refs/heads/main');
  const report = backup(await reportFor(f.scanRoot), { dryRun: false });
  const feature = featureOf(report);
  assert.equal(feature.backedUp, true);
  assert.equal(gitDir(f.origin, 'rev-parse', 'refs/backup/test-machine/feat/guard'), feature.head);
  assert.deepEqual(gitDir(f.origin, 'for-each-ref', '--format=%(refname)', 'refs/heads').split('\n'), ['refs/heads/main']);
  assert.equal(gitDir(f.origin, 'rev-parse', 'refs/heads/main'), mainBefore);
  const rescanned = await reportFor(f.scanRoot);
  assert.equal(featureOf(rescanned).backedUp, true);
  assert.ok(rescanned.risks.some((risk) => risk.kind === 'unpushed' && risk.level === 'yellow'));
});

test('scan recognizes a squash-merged topic by comparing merge trees', async (t) => {
  const f = fixture(t);
  restoreHome(t, f.temp);
  git(f.main, 'merge', '--squash', 'feat/guard');
  git(f.main, 'commit', '-m', 'squash feature');
  gitDir(f.origin, 'fetch', f.main, 'refs/heads/main:refs/heads/main');
  git(f.main, 'fetch', 'origin', 'main');
  const feature = featureOf(await reportFor(f.scanRoot));
  assert.equal(feature.mergedToMain, true);
});

test('scan reports old dirty files, stashes, and deleted worktrees as risks', async (t) => {
  const f = fixture(t);
  restoreHome(t, f.temp);
  const old = Date.now() - 25 * 60 * 60 * 1000;
  writeFileSync(join(f.worktree, 'feature.txt'), 'dirty\n');
  utimesSync(join(f.worktree, 'feature.txt'), old / 1000, old / 1000);
  const dirty = await reportFor(f.scanRoot);
  assert.equal(featureOf(dirty).dirty, 1);
  assert.ok(featureOf(dirty).dirtyOldestMinutes >= 24 * 60);
  assert.ok(dirty.risks.some((risk) => risk.kind === 'dirty' && risk.level === 'red'));

  git(f.worktree, 'stash', 'push', '-m', 'guard test');
  const stashed = await reportFor(f.scanRoot);
  assert.equal(stashed.repos[0].stashes, 1);
  assert.ok(stashed.risks.some((risk) => risk.kind === 'stash' && risk.level === 'yellow'));

  rmSync(f.worktree, { recursive: true, force: true });
  const pruned = await reportFor(f.scanRoot);
  const missing = pruned.repos[0].worktrees.find((worktree) => worktree.path === f.worktree);
  assert.equal(missing.prunable, true);
  assert.ok(pruned.risks.some((risk) => risk.kind === 'prunable' && risk.level === 'yellow'));
});

test('scan caches merge results by worktree head and origin main commit', async (t) => {
  const f = fixture(t);
  restoreHome(t, f.temp);
  await reportFor(f.scanRoot);
  const cachePath = join(f.temp, '.cache', 'git-guard', 'merged-to-main.json');
  const firstCache = JSON.parse(readFileSync(cachePath, 'utf8')).entries;
  const firstMain = git(f.main, 'rev-parse', 'origin/main');
  assert.ok(Object.keys(firstCache).some((key) => key.includes(firstMain)));

  await reportFor(f.scanRoot);
  const repeatedCache = JSON.parse(readFileSync(cachePath, 'utf8')).entries;
  assert.deepEqual(Object.keys(repeatedCache), Object.keys(firstCache));

  writeFileSync(join(f.main, 'README.txt'), 'advanced main\n');
  git(f.main, 'add', 'README.txt');
  git(f.main, 'commit', '-m', 'advance main');
  git(f.main, 'push', 'origin', 'main');
  git(f.main, 'fetch', 'origin', 'main');
  const nextMain = git(f.main, 'rev-parse', 'origin/main');
  await reportFor(f.scanRoot);
  const nextCache = JSON.parse(readFileSync(cachePath, 'utf8')).entries;
  assert.notEqual(nextMain, firstMain);
  assert.ok(Object.keys(nextCache).some((key) => key.includes(nextMain)));
});

test('worktree shelf classification protects active sessions and puts old merged worktrees in trash', () => {
  const base = {
    dirty: 0,
    dirtyKnown: true,
    ignored: 0,
    mergedToMain: true,
    unpushed: 0,
    idleDays: 8,
    idleMinutes: 120,
    prunable: false,
  };
  assert.equal(classifyWorktree(base, { sessionOpen: true }), 'doing');
  assert.equal(classifyWorktree({ ...base, idleDays: 2, idleMinutes: 10 }, {}), 'sleeping');
  assert.equal(classifyWorktree(base, {}), 'trash');
  assert.equal(classifyWorktree({ ...base, dirty: 1 }, {}), 'sleeping');
  assert.equal(classifyWorktree({ ...base, ignored: 1 }, {}), 'sleeping');
  assert.equal(classifyWorktree({ ...base, dirtyKnown: false }, {}), 'sleeping');
  assert.equal(classifyWorktree({ ...base, prunable: true }, {}), 'trash');
});

test('prune removes only idle, clean, merged worktrees and respects active paths', async (t) => {
  const f = fixture(t);
  restoreHome(t, f.temp);
  git(f.main, 'merge', '--no-ff', 'feat/guard', '-m', 'merge feature');
  git(f.main, 'push', 'origin', 'main');
  git(f.main, 'fetch', 'origin', 'main');
  const report = await scan({
    roots: [f.scanRoot],
    machine: 'test-machine',
    now: Date.now() + 2 * 60 * 60 * 1000,
  });
  const feature = featureOf(report);
  assert.equal(feature.unpushed, 0);
  assert.equal(feature.mergedToMain, true);

  assert.deepEqual(prune(report, { activePaths: [f.worktree] }), { removed: 0, skipped: 1 });
  assert.deepEqual(prune(report, { activePaths: [join(f.scanRoot, 'worktrees')] }), {
    removed: 0,
    skipped: 1,
  });
  feature.dirtyKnown = false;
  assert.deepEqual(prune(report), { removed: 0, skipped: 0 });
  assert.ok(readFileSync(join(f.worktree, 'feature.txt'), 'utf8'));
  feature.dirtyKnown = true;
  assert.deepEqual(prune(report, { activeBranches: ['feat/guard'] }), { removed: 0, skipped: 1 });
  assert.deepEqual(prune(report, { activeTaskSlugs: ['feature'] }), { removed: 0, skipped: 1 });
  assert.deepEqual(prune(report), { removed: 1, skipped: 0 });
  assert.equal(git(f.main, 'branch', '--list', 'feat/guard'), 'feat/guard');
});

test('prune leaves a clean merged worktree with a Git operation in progress', async (t) => {
  const f = fixture(t);
  restoreHome(t, f.temp);
  git(f.main, 'merge', '--no-ff', 'feat/guard', '-m', 'merge feature');
  git(f.main, 'push', 'origin', 'main');
  git(f.main, 'fetch', 'origin', 'main');
  const report = await scan({
    roots: [f.scanRoot],
    machine: 'test-machine',
    now: Date.now() + 2 * 60 * 60 * 1000,
  });
  const feature = featureOf(report);
  feature.op = 'merge';
  assert.deepEqual(prune(report), { removed: 0, skipped: 1 });
  assert.equal(readFileSync(join(f.worktree, 'feature.txt'), 'utf8'), 'feature\n');
});

test('prune leaves a dirty worktree untouched', async (t) => {
  const f = fixture(t);
  restoreHome(t, f.temp);
  git(f.main, 'merge', '--no-ff', 'feat/guard', '-m', 'merge feature');
  git(f.main, 'push', 'origin', 'main');
  git(f.main, 'fetch', 'origin', 'main');
  writeFileSync(join(f.worktree, 'uncommitted.txt'), 'keep this\n');
  const report = await scan({
    roots: [f.scanRoot],
    machine: 'test-machine',
    now: Date.now() + 2 * 60 * 60 * 1000,
  });
  assert.equal(featureOf(report).dirty, 1);
  assert.deepEqual(prune(report), { removed: 0, skipped: 0 });
  assert.equal(readFileSync(join(f.worktree, 'uncommitted.txt'), 'utf8'), 'keep this\n');
});

test('prune preserves ignored user data in a merged worktree', async (t) => {
  const f = fixture(t);
  restoreHome(t, f.temp);
  git(f.main, 'merge', '--no-ff', 'feat/guard', '-m', 'merge feature');
  git(f.main, 'push', 'origin', 'main');
  git(f.main, 'fetch', 'origin', 'main');
  writeFileSync(join(f.main, '.git', 'info', 'exclude'), 'ignored-user-data.txt\n');
  writeFileSync(join(f.worktree, 'ignored-user-data.txt'), 'keep this\n');
  const report = await scan({
    roots: [f.scanRoot],
    machine: 'test-machine',
    now: Date.now() + 2 * 60 * 60 * 1000,
  });
  const worktree = featureOf(report);
  assert.equal(worktree.ignored, 1);
  assert.deepEqual(prune(report), { removed: 0, skipped: 0 });
  assert.equal(readFileSync(join(f.worktree, 'ignored-user-data.txt'), 'utf8'), 'keep this\n');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backup, scan } from './git-guard.mjs';

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

test('scan finds local unpushed commits and reports them as red until backed up', (t) => {
  const f = fixture(t);
  const report = reportFor(f.scanRoot);
  const feature = featureOf(report);
  assert.ok(feature, 'the linked worktree is reported under its main repository');
  assert.equal(feature.unpushed, 1);
  assert.deepEqual(feature.unpushedSubjects, ['unpublished work']);
  assert.equal(feature.backedUp, false);
  assert.ok(report.risks.some((risk) => risk.kind === 'unpushed' && risk.level === 'red' && risk.path === f.worktree));
});

test('backup pushes only the backup ref and cached scan reports the worktree as yellow', (t) => {
  const f = fixture(t);
  restoreHome(t, f.temp);
  const mainBefore = gitDir(f.origin, 'rev-parse', 'refs/heads/main');
  const report = backup(reportFor(f.scanRoot), { dryRun: false });
  const feature = featureOf(report);
  assert.equal(feature.backedUp, true);
  assert.equal(gitDir(f.origin, 'rev-parse', 'refs/backup/test-machine/feat/guard'), feature.head);
  assert.deepEqual(gitDir(f.origin, 'for-each-ref', '--format=%(refname)', 'refs/heads').split('\n'), ['refs/heads/main']);
  assert.equal(gitDir(f.origin, 'rev-parse', 'refs/heads/main'), mainBefore);
  const rescanned = reportFor(f.scanRoot);
  assert.equal(featureOf(rescanned).backedUp, true);
  assert.ok(rescanned.risks.some((risk) => risk.kind === 'unpushed' && risk.level === 'yellow'));
});

test('scan recognizes a squash-merged topic by comparing merge trees', (t) => {
  const f = fixture(t);
  git(f.main, 'merge', '--squash', 'feat/guard');
  git(f.main, 'commit', '-m', 'squash feature');
  gitDir(f.origin, 'fetch', f.main, 'refs/heads/main:refs/heads/main');
  git(f.main, 'fetch', 'origin', 'main');
  const feature = featureOf(reportFor(f.scanRoot));
  assert.equal(feature.mergedToMain, true);
});

test('scan reports old dirty files, stashes, and deleted worktrees as risks', (t) => {
  const f = fixture(t);
  const old = Date.now() - 25 * 60 * 60 * 1000;
  writeFileSync(join(f.worktree, 'feature.txt'), 'dirty\n');
  utimesSync(join(f.worktree, 'feature.txt'), old / 1000, old / 1000);
  const dirty = reportFor(f.scanRoot);
  assert.equal(featureOf(dirty).dirty, 1);
  assert.ok(featureOf(dirty).dirtyOldestMinutes >= 24 * 60);
  assert.ok(dirty.risks.some((risk) => risk.kind === 'dirty' && risk.level === 'red'));

  git(f.worktree, 'stash', 'push', '-m', 'guard test');
  const stashed = reportFor(f.scanRoot);
  assert.equal(stashed.repos[0].stashes, 1);
  assert.ok(stashed.risks.some((risk) => risk.kind === 'stash' && risk.level === 'yellow'));

  rmSync(f.worktree, { recursive: true, force: true });
  const pruned = reportFor(f.scanRoot);
  const missing = pruned.repos[0].worktrees.find((worktree) => worktree.path === f.worktree);
  assert.equal(missing.prunable, true);
  assert.ok(pruned.risks.some((risk) => risk.kind === 'prunable' && risk.level === 'yellow'));
});

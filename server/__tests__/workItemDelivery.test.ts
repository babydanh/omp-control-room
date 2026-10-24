import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { runCommand } from '../src/company/workItems/squadWorktree.js';
import { probeDelivery, toDelivery } from '../src/company/workItems/workItemDelivery.js';

const dirs: string[] = [];
afterEach(() => {
  // Git on Windows may still hold a handle for a moment after it exits.
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, stdio: 'ignore' });
}

/** A repo whose "origin" refs are local refs under refs/remotes/origin, a branch with two commits, and a worktree. */
function repoWithBranch(): { repo: string; worktree: string } {
  const repo = mkdtempSync(join(tmpdir(), 'delivery-'));
  dirs.push(repo);
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'a.txt'), 'base\n');
  git(repo, 'add', 'a.txt');
  git(repo, 'commit', '-q', '-m', 'base');
  git(repo, 'update-ref', 'refs/remotes/origin/main', 'main');
  const worktree = join(repo, 'wt');
  git(repo, 'worktree', 'add', '-q', '-b', 'squad-1', worktree);
  writeFileSync(join(worktree, 'b.txt'), 'one\n');
  git(worktree, 'add', 'b.txt');
  git(worktree, 'commit', '-q', '-m', 'one');
  writeFileSync(join(worktree, 'b.txt'), 'one\ntwo\n');
  git(worktree, 'commit', '-q', '-am', 'two');
  return { repo, worktree };
}

/** Lands the branch on `target` as one squashed commit, the way merge-lane does, and moves origin/<target>. */
function squashInto(repo: string, target: string): void {
  const land = join(repo, `land-${target}`);
  git(repo, 'worktree', 'add', '-q', '-B', `land-${target}`, land, `refs/remotes/origin/${target}`);
  git(land, 'merge', '--squash', '-q', 'squad-1');
  git(land, 'commit', '-q', '-m', 'squash');
  git(repo, 'update-ref', `refs/remotes/origin/${target}`, `land-${target}`);
}

// Each step spawns git several times; on Windows that takes seconds, not milliseconds.
describe('probeDelivery', { timeout: 120_000 }, () => {
  it('reads a committed branch as not yet on staging, then as in main after a squash merge', async () => {
    const { repo, worktree } = repoWithBranch();
    git(repo, 'update-ref', 'refs/remotes/origin/staging', 'main');
    const branch = { path: worktree, branch: 'squad-1' };

    const before = await probeDelivery(repo, branch, true, runCommand);
    expect(before).toMatchObject({ dirtyFiles: 0, commitsAhead: 2, inMain: false, inStaging: false });
    expect(toDelivery(before!, 't').stage).toBe('branch');

    squashInto(repo, 'staging');
    const staged = await probeDelivery(repo, branch, true, runCommand);
    expect(toDelivery(staged!, 't').stage).toBe('staging');

    // The squash leaves the branch's own commits unknown to main by hash, yet its content is there.
    squashInto(repo, 'main');
    const landed = await probeDelivery(repo, branch, true, runCommand);
    expect(landed).toMatchObject({ commitsAhead: 2, inMain: true });
    expect(toDelivery(landed!, 't').stage).toBe('main');
  });

  it('puts uncommitted work first, and reads a repo without staging as having none', async () => {
    const { repo, worktree } = repoWithBranch();
    writeFileSync(join(worktree, 'b.txt'), 'edited\n');
    writeFileSync(join(worktree, '.ripwire_quality_baseline'), 'tool output\n');

    const facts = await probeDelivery(repo, { path: worktree, branch: 'squad-1' }, true, runCommand);
    const delivery = toDelivery(facts!, 't');

    expect(facts).toMatchObject({ dirtyFiles: 1, inStaging: null });
    expect(delivery.stage).toBe('uncommitted');
    expect(delivery.nextStep).toContain('Còn 1 file chưa commit');
  });

  it('has nothing to say for a branch that no longer exists', async () => {
    const { repo, worktree } = repoWithBranch();
    expect(await probeDelivery(repo, { path: worktree, branch: 'gone' }, true, runCommand)).toBeUndefined();
  });
});

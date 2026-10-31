import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TASK_CLEAN_SCRIPT } from '../src/fleet/taskClean.js';

/** The script runs on the cloud machine under bash; here it runs on real git repositories in a temporary home. */
const hasBash = spawnSync('bash', ['-c', 'true']).status === 0;

function sh(cwd: string, command: string): string {
  const result = spawnSync('bash', ['-c', command], { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${command}: ${result.stderr}`);
  return result.stdout.trim();
}

interface Machine {
  home: string;
  base: string;
  root: string;
}

let machine: Machine;

function toBash(value: string): string {
  return value.replace(/\\/g, '/');
}

function setup(): Machine {
  const home = toBash(realpathSync(mkdtempSync(path.join(os.tmpdir(), 'task-clean-'))));
  const origin = `${home}/origin.git`;
  const root = `${home}/repo`;
  sh(home, `git init -q --bare -b main '${origin}'`);
  sh(home, `git clone -q '${origin}' '${root}' 2>/dev/null`);
  sh(root, 'git config user.email t@example.com; git config user.name t; git checkout -q -b main 2>/dev/null; echo a > a.txt; git add a.txt; git commit -q -m init; git push -q origin main');
  mkdirSync(`${home}/wt`, { recursive: true });
  mkdirSync(`${home}/.cloud-viec`, { recursive: true });
  return { home, base: `${home}/wt`, root };
}

function addTask(slug: string, kind: 'web' | 'all' = 'web'): string {
  const cwd = kind === 'all' ? `${machine.base}/${slug}` : `${machine.base}/web-${slug}`;
  const worktree = kind === 'all' ? `${cwd}/web` : cwd;
  mkdirSync(path.dirname(worktree), { recursive: true });
  sh(machine.root, `git worktree add -q -b cloud/m-${slug} '${worktree}' origin/main`);
  sh(worktree, 'git config user.email t@example.com; git config user.name t');
  writeFileSync(`${machine.home}/.cloud-viec/${slug}.json`, JSON.stringify({ slug, cwd, kind, branch: `cloud/m-${slug}` }));
  return worktree;
}

function clean(slug: string): { code: number | null; last: string } {
  const result = spawnSync('bash', ['-s', '--', slug], {
    input: TASK_CLEAN_SCRIPT,
    encoding: 'utf8',
    env: { ...process.env, HOME: machine.home, CLOUD_WT_BASE: machine.base },
  });
  return { code: result.status, last: `${result.stdout}${result.stderr}`.trim().split('\n').pop() ?? '' };
}

// Each test runs real git and bash processes (slow on Windows and under load).
describe.skipIf(!hasBash)('TASK_CLEAN_SCRIPT', { timeout: 30_000 }, () => {
  beforeEach(() => {
    machine = setup();
  });
  afterEach(() => {
    rmSync(machine.home, { recursive: true, force: true });
  });

  it('removes the worktree, the local branch and the ledger entry of a clean task', () => {
    const worktree = addTask('viec-mot');

    expect(clean('viec-mot')).toEqual({ code: 0, last: 'OK viec-mot' });
    expect(existsSync(worktree)).toBe(false);
    expect(existsSync(`${machine.home}/.cloud-viec/viec-mot.json`)).toBe(false);
    expect(sh(machine.root, 'git branch --list "cloud/*"')).toBe('');
  });

  it('removes the task folder of an all-repositories task too', () => {
    addTask('ca-ba', 'all');

    expect(clean('ca-ba').code).toBe(0);
    expect(existsSync(`${machine.base}/ca-ba`)).toBe(false);
  });

  it('refuses a worktree with uncommitted files and removes nothing', () => {
    const worktree = addTask('viec-do');
    writeFileSync(`${worktree}/new.txt`, 'unsaved');

    const result = clean('viec-do');

    expect(result.code).toBe(7);
    expect(result.last).toContain('chua commit');
    expect(existsSync(worktree)).toBe(true);
    expect(existsSync(`${machine.home}/.cloud-viec/viec-do.json`)).toBe(true);
  });

  it('refuses a commit that was never pushed, and accepts it once it is', () => {
    const worktree = addTask('viec-commit');
    sh(worktree, 'echo b > b.txt; git add b.txt; git commit -q -m work');

    expect(clean('viec-commit')).toMatchObject({ code: 7 });
    expect(existsSync(worktree)).toBe(true);

    sh(worktree, 'git push -q origin HEAD');
    expect(clean('viec-commit').code).toBe(0);
    expect(existsSync(worktree)).toBe(false);
  });

  it('ignores the copied tsc cache, which cloud-giao puts in every worktree', () => {
    const worktree = addTask('viec-cache');
    mkdirSync(`${worktree}/.tsc-cache`);
    writeFileSync(`${worktree}/.tsc-cache/x`, 'cache');

    expect(clean('viec-cache').code).toBe(0);
  });

  it('treats a task nothing remembers as already gone, and refuses a ledger path outside the worktree base', () => {
    expect(clean('khong-co')).toMatchObject({ code: 0 });

    writeFileSync(`${machine.home}/.cloud-viec/ngoai.json`, JSON.stringify({ cwd: `${machine.home}/repo` }));
    expect(clean('ngoai')).toMatchObject({ code: 3 });
    expect(existsSync(`${machine.root}/a.txt`)).toBe(true);
  });
});

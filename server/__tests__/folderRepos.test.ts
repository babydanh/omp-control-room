import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { listFolderRepos, type RepoScanSource } from '../src/company/workItems/folderRepos.js';

const ROOT = path.join(path.sep, 'work', 'folder');

/** The path of an entry under the folder root. */
function at(...parts: string[]): string {
  return path.join(ROOT, ...parts);
}

/**
 * An in-memory directory tree. `dirs` lists every directory under the root, the root included,
 * so each intermediate directory must appear too. `repos` lists the directories that hold a
 * `.git` entry. `aliases` maps a directory to the canonical path it resolves to.
 */
function treeOf(
  dirs: readonly string[],
  repos: readonly string[] = [],
  aliases: Readonly<Record<string, string>> = {},
): RepoScanSource {
  return {
    async listDirectories(dir) {
      return dirs.filter((child) => child !== dir && path.dirname(child) === dir);
    },
    async hasGitEntry(dir) {
      return repos.includes(dir);
    },
    async canonical(candidate) {
      return aliases[candidate] ?? candidate;
    },
  };
}

describe('listFolderRepos', () => {
  it('includes the folder root when it is a repo, along with a repo nested inside it', async () => {
    const source = treeOf([ROOT, at('app')], [ROOT, at('app')]);
    expect(await listFolderRepos(ROOT, source)).toEqual([ROOT, at('app')]);
  });

  it('finds repos nested in plain directories and ignores the plain directories', async () => {
    const source = treeOf([ROOT, at('apps'), at('apps', 'web'), at('notes')], [at('apps', 'web')]);
    expect(await listFolderRepos(ROOT, source)).toEqual([at('apps', 'web')]);
  });

  it('finds linked worktrees under .worktrees of a repo', async () => {
    const source = treeOf(
      [ROOT, at('app'), at('app', '.worktrees'), at('app', '.worktrees', 'feat-login')],
      [at('app'), at('app', '.worktrees', 'feat-login')],
    );
    expect(await listFolderRepos(ROOT, source)).toEqual([
      at('app'),
      at('app', '.worktrees', 'feat-login'),
    ]);
  });

  it('skips node_modules and dot-directories other than .worktrees', async () => {
    const source = treeOf(
      [
        ROOT,
        at('node_modules'),
        at('node_modules', 'pkg'),
        at('.cache'),
        at('.cache', 'repo'),
        at('.hidden'),
        at('.hidden', 'repo'),
      ],
      [at('node_modules', 'pkg'), at('.cache', 'repo'), at('.hidden', 'repo')],
    );
    expect(await listFolderRepos(ROOT, source)).toEqual([]);
  });

  it('descends at most maxDepth levels below the folder root', async () => {
    const dirs = [ROOT, at('a'), at('a', 'b'), at('a', 'b', 'c'), at('a', 'b', 'c', 'd')];
    const source = treeOf(dirs, [at('a', 'b', 'c'), at('a', 'b', 'c', 'd')]);

    expect(await listFolderRepos(ROOT, source)).toEqual([at('a', 'b', 'c')]);
    expect(await listFolderRepos(ROOT, source, { maxDepth: 4 })).toEqual([
      at('a', 'b', 'c'),
      at('a', 'b', 'c', 'd'),
    ]);
  });

  it('lists each canonical path once', async () => {
    const source = treeOf([ROOT, at('app'), at('link')], [at('app'), at('link')], {
      [at('link')]: at('app'),
    });
    expect(await listFolderRepos(ROOT, source)).toEqual([at('app')]);
  });

  it('sorts the result ascending', async () => {
    const source = treeOf(
      [ROOT, at('zeta'), at('alpha'), at('mid')],
      [at('zeta'), at('alpha'), at('mid')],
    );
    expect(await listFolderRepos(ROOT, source)).toEqual([at('alpha'), at('mid'), at('zeta')]);
  });

  it('caps the result at 200 paths', async () => {
    const names = Array.from(
      { length: 205 },
      (_, index) => `repo-${String(index).padStart(3, '0')}`,
    );
    const dirs = [ROOT, ...names.map((name) => at(name))];
    const source = treeOf(dirs, dirs.slice(1));

    const repos = await listFolderRepos(ROOT, source);
    expect(repos).toHaveLength(200);
    expect(repos[0]).toBe(at('repo-000'));
    expect(repos[199]).toBe(at('repo-199'));
  });

  it('returns an empty list when the tree holds no repo', async () => {
    expect(await listFolderRepos(ROOT, treeOf([ROOT, at('docs')]))).toEqual([]);
  });
});

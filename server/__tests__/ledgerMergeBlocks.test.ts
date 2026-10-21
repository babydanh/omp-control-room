import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { GitRunner } from '../src/ledger/git.js';
import { MergeBlockCache } from '../src/ledger/mergeBlocks.js';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function briefName(branch: string, at: Date): string {
  const stamp = [
    at.getFullYear().toString().padStart(4, '0'),
    (at.getMonth() + 1).toString().padStart(2, '0'),
    at.getDate().toString().padStart(2, '0'),
  ].join('') + '-' + [at.getHours(), at.getMinutes(), at.getSeconds()].map((part) => part.toString().padStart(2, '0')).join('');
  const safeBranch = branch.replace(/[^A-Za-z0-9._-]/g, '_');
  return `conflict-${safeBranch}-${stamp}.md`;
}

function writeBrief(directory: string, branch: string, at: Date, files: readonly string[]): void {
  const body = [
    `# Xung dot khi rebase \`${branch}\` len \`origin/main\``,
    '',
    ...files.flatMap((file) => [`## ${file}`, 'xung dot']),
    '## Cach go (AGENTS.md §2)',
    'ignored.md',
  ].join('\n');
  fs.writeFileSync(path.join(directory, briefName(branch, at)), body);
}

function fakeGit(commonDir: string): GitRunner {
  return {
    run: async () => ({
      ok: true,
      code: 0,
      stdout: commonDir,
      stderr: '',
      timedOut: false,
      truncated: false,
    }),
  };
}

describe('MergeBlockCache', () => {
  it('keeps only the newest brief per branch, parses files, and expires briefs after seven days', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-merge-brief-'));
    directories.push(root);
    const repo = path.join(root, 'repo');
    const commonDir = path.join(root, 'common');
    const briefDir = path.join(commonDir, 'merge-lane');
    fs.mkdirSync(repo, { recursive: true });
    fs.mkdirSync(briefDir, { recursive: true });

    const now = new Date(2026, 9, 21, 12, 0, 0);
    writeBrief(briefDir, 'feat/a', new Date(now.getTime() - 2 * 60 * 60 * 1000), ['old.ts']);
    writeBrief(briefDir, 'feat/a', new Date(now.getTime() - 60 * 60 * 1000), ['src/new.ts', 'src/other.ts']);
    writeBrief(briefDir, 'feat/b', new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000), ['expired.ts']);
    writeBrief(briefDir, 'feat/c', new Date(now.getTime() - 30 * 60 * 1000), ['current.ts']);

    const cache = new MergeBlockCache();
    const blocks = await cache.read(fakeGit(commonDir), repo, now.getTime());
    expect(blocks.map((block) => block.branch)).toEqual(['feat/a', 'feat/c']);
    expect(blocks[0]).toMatchObject({
      repo,
      branch: 'feat/a',
      at: new Date(now.getTime() - 60 * 60 * 1000).toISOString(),
      files: ['src/new.ts', 'src/other.ts'],
    });
    expect(blocks[0].briefPath).toBe(path.join(briefDir, briefName('feat/a', new Date(now.getTime() - 60 * 60 * 1000))));

    expect(await cache.read(fakeGit(commonDir), repo, now.getTime() + 8 * 24 * 60 * 60 * 1000)).toEqual([]);
  });
});

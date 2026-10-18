import { describe, expect, it } from 'vitest';

import {
  LEDGER_GIT_COMMAND,
  LEDGER_GIT_ERROR_PREFIX,
  LEDGER_GIT_PROBLEM_STATUS,
} from '../src/ledger/constants.js';
import {
  createGitRunner,
  type GitRepoScan,
  type LedgerWorktreeState,
  parseAheadBehind,
  parseLastCommit,
  parseStatusZ,
  parseWorktreeList,
  readRepo,
} from '../src/ledger/git.js';
import { formatLedgerTime } from '../src/ledger/ledgerTime.js';
import type { ProcessOptions } from '../src/ledger/processRunner.js';
import { COMMIT_ISO, FakeGitRunner, type ProcessReply, replyResult } from './ledgerFixtures.js';

const MAIN = 'C:/Repo';
const FEATURE = 'C:/Repo-wt/feat';
const SHA_1 = '1'.repeat(40);
const SHA_2 = '2'.repeat(40);
const SHA_3 = '3'.repeat(40);

describe('parseWorktreeList', () => {
  it('reads branch, detached, bare, and prunable entries', () => {
    const stdout = [
      'worktree C:/Repo',
      `HEAD ${SHA_1}`,
      'branch refs/heads/main',
      '',
      'worktree C:/Repo-wt/feature',
      `HEAD ${SHA_2}`,
      'branch refs/heads/feat/a',
      '',
      'worktree C:/Repo-wt/detached',
      `HEAD ${SHA_3}`,
      'detached',
      '',
      'worktree C:/Repo.git',
      'bare',
      '',
      'worktree C:/Repo-wt/gone',
      `HEAD ${SHA_3}`,
      'branch refs/heads/old',
      'prunable gitdir file points to non-existent location',
      '',
    ].join('\n');

    expect(parseWorktreeList(stdout)).toEqual([
      {
        path: 'C:/Repo',
        head: SHA_1,
        branch: 'main',
        bare: false,
        detached: false,
        prunable: false,
      },
      {
        path: 'C:/Repo-wt/feature',
        head: SHA_2,
        branch: 'feat/a',
        bare: false,
        detached: false,
        prunable: false,
      },
      {
        path: 'C:/Repo-wt/detached',
        head: SHA_3,
        branch: null,
        bare: false,
        detached: true,
        prunable: false,
      },
      { path: 'C:/Repo.git', head: '', branch: null, bare: true, detached: false, prunable: false },
      {
        path: 'C:/Repo-wt/gone',
        head: SHA_3,
        branch: 'old',
        bare: false,
        detached: false,
        prunable: true,
      },
    ]);
  });

  it('accepts CRLF line endings', () => {
    const stdout = `worktree C:/Repo\r\nHEAD ${SHA_1}\r\nbranch refs/heads/main\r\n\r\n`;
    expect(parseWorktreeList(stdout)).toMatchObject([{ path: 'C:/Repo', branch: 'main' }]);
  });
});

describe('parseStatusZ', () => {
  it('reads NUL-separated records, trimming the status code and keeping ??', () => {
    const stdout = ' M src/a.ts\u0000?? new file.ts\u0000M  src/b.ts\u0000';
    expect(parseStatusZ(stdout)).toEqual([
      { status: 'M', path: 'src/a.ts' },
      { status: '??', path: 'new file.ts' },
      { status: 'M', path: 'src/b.ts' },
    ]);
  });

  it('returns nothing for empty output', () => {
    expect(parseStatusZ('')).toEqual([]);
  });
});

describe('parseAheadBehind', () => {
  it('reads "behind<TAB>ahead" from rev-list --left-right --count', () => {
    expect(parseAheadBehind('1\t2\n')).toEqual({ behind: 1, ahead: 2 });
  });

  it('returns null for output it cannot read', () => {
    expect(parseAheadBehind('x')).toBeNull();
    expect(parseAheadBehind('')).toBeNull();
  });
});

describe('parseLastCommit', () => {
  it('reads the subject and converts the commit time to ledger local time', () => {
    expect(parseLastCommit(`Fix the thing\u0000${COMMIT_ISO}\n`)).toEqual({
      subject: 'Fix the thing',
      committedAt: formatLedgerTime(Date.parse(COMMIT_ISO)),
    });
  });

  it('keeps the subject but drops an unreadable commit time', () => {
    expect(parseLastCommit('Subject\u0000not a date')).toEqual({
      subject: 'Subject',
      committedAt: null,
    });
  });

  it('returns null without the NUL separator', () => {
    expect(parseLastCommit('no separator here')).toBeNull();
  });
});

describe('createGitRunner', () => {
  it('runs git with optional locks off and the folder passed via -C', async () => {
    const seen: Array<{ file: string; args: readonly string[] }> = [];
    const runner = createGitRunner((file, args: readonly string[], _options: ProcessOptions) => {
      seen.push({ file, args: [...args] });
      return Promise.resolve(replyResult({}, [0]));
    });

    await runner.run('C:/Repo', ['status'], { timeoutMs: 1, okCodes: [0], maxBytes: 1 });

    expect(seen).toEqual([
      {
        file: LEDGER_GIT_COMMAND,
        args: ['--no-optional-locks', '-C', 'C:/Repo', 'status'],
      },
    ]);
  });
});

function worktreesOf(scan: GitRepoScan): LedgerWorktreeState[] {
  if (scan.kind !== 'repo') throw new Error('expected a repo scan');
  return scan.worktrees;
}

const WORKTREE_LIST = [
  `worktree ${MAIN}`,
  `HEAD ${SHA_1}`,
  'branch refs/heads/main',
  '',
  `worktree ${FEATURE}`,
  `HEAD ${SHA_2}`,
  'branch refs/heads/feat/a',
  '',
  'worktree C:/Repo-wt/gone',
  `HEAD ${SHA_3}`,
  'branch refs/heads/old',
  'prunable gitdir file points to non-existent location',
  '',
].join('\n');

/** Two checkouts plus one prunable entry: the main one dirty and ahead, the feature one clean. */
function repoScript(cwd: string, args: readonly string[]): ProcessReply {
  const key = args.join(' ');
  if (key === 'rev-parse --show-prefix') return { stdout: '\n' };
  if (key === 'worktree list --porcelain') return { stdout: WORKTREE_LIST };
  if (args[0] === 'status') return cwd === MAIN ? { stdout: ' M a.ts\u0000' } : { stdout: '' };
  if (args[0] === 'rev-list') return { stdout: '1\t2\n' };
  if (args[0] === 'merge-base') return { code: cwd === MAIN ? 0 : 1 };
  if (args[0] === 'rev-parse') return { code: cwd === MAIN ? 0 : 128 };
  if (args[0] === 'log') return { stdout: `Subject\u0000${COMMIT_ISO}\n` };
  return { code: 1 };
}

describe('readRepo', () => {
  it('treats a subfolder of a repo as not a repo root', async () => {
    const git = new FakeGitRunner((_cwd, args) =>
      args.join(' ') === 'rev-parse --show-prefix' ? { stdout: 'server/\n' } : { code: 1 },
    );
    expect(await readRepo(git, MAIN)).toEqual({ kind: 'not-repo' });
  });

  it('names a missing base once in the git error', async () => {
    const git = new FakeGitRunner((_cwd, args) => {
      const key = args.join(' ');
      if (key === 'rev-parse --show-prefix') return { stdout: '\n' };
      if (key === 'worktree list --porcelain') {
        return { stdout: `worktree ${MAIN}\nHEAD ${'a'.repeat(40)}\nbranch refs/heads/main\n` };
      }
      if (args[0] === 'rev-list' || args[0] === 'merge-base') return { code: 128 };
      if (args[0] === 'log') return { stdout: `Subject\u0000${COMMIT_ISO}\n` };
      return { stdout: '' };
    });
    const scan = await readRepo(git, MAIN);
    expect(scan.kind === 'repo' && scan.worktrees[0]?.gitError).toBe(
      'Git không đọc được: so với origin/main.',
    );
  });

  it('reads every checkout, skipping prunable entries, and fills the state', async () => {
    const git = new FakeGitRunner(repoScript);
    const worktrees = worktreesOf(await readRepo(git, MAIN));

    expect(worktrees).toHaveLength(2);
    expect(worktrees[0]).toMatchObject({
      path: MAIN,
      name: 'Repo',
      branch: 'main',
      head: SHA_1.slice(0, 8),
      isMain: true,
      ahead: 2,
      behind: 1,
      dirtyCount: 1,
      dirtyFiles: [{ status: 'M', path: 'a.ts' }],
      merged: true,
      hasUpstream: true,
      lastCommitSubject: 'Subject',
      lastCommitAt: formatLedgerTime(Date.parse(COMMIT_ISO)),
    });
    expect(worktrees[0]).not.toHaveProperty('gitError');
    expect(worktrees[1]).toMatchObject({
      path: FEATURE,
      isMain: false,
      merged: false,
      hasUpstream: false,
      dirtyCount: 0,
      dirtyFiles: [],
    });
  });

  it('never runs git inside a prunable checkout', async () => {
    const git = new FakeGitRunner(repoScript);
    await readRepo(git, MAIN);
    expect(git.calls.some((call) => call.cwd === 'C:/Repo-wt/gone')).toBe(false);
  });

  it('records a checkout whose status fails with a Vietnamese gitError', async () => {
    const git = new FakeGitRunner((cwd, args) =>
      args[0] === 'status' && cwd === FEATURE
        ? { code: 128, stderr: 'fatal: not a git repository' }
        : repoScript(cwd, args),
    );
    const feature = worktreesOf(await readRepo(git, MAIN))[1];
    expect(feature.gitError).toBe(`${LEDGER_GIT_ERROR_PREFIX} ${LEDGER_GIT_PROBLEM_STATUS}.`);
    expect(feature.dirtyFiles).toEqual([]);
  });
});

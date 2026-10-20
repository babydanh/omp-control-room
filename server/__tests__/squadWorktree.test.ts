import { delimiter, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  type CommandResult,
  type CommandRunner,
  createSquadWorktree,
  findOnPath,
  worktreeOnBranch,
} from '../src/company/workItems/squadWorktree.js';

const FOLDER = '/work/folder';
const REPO = `${FOLDER}/app`;
const GIT_WT = '/usr/local/bin/git-wt';
const SHORT = '1a2b3c4d';
const LIST = 'git worktree list --porcelain';

const OK: CommandResult = { code: 0, stdout: '', stderr: '' };

/** Any command the test did not expect fails loudly, so a wrong call shows up in the error. */
function unexpected(line: string): CommandResult {
  return { code: 1, stdout: '', stderr: `unexpected command: ${line}` };
}

/** A fake runner: records each command as one line with its cwd, and answers it with `answer`. */
function recordingRunner(answer: (line: string) => CommandResult): {
  run: CommandRunner;
  calls: { line: string; cwd: string }[];
} {
  const calls: { line: string; cwd: string }[] = [];
  const run: CommandRunner = async (file, argv, cwd) => {
    const line = [file, ...argv].join(' ');
    calls.push({ line, cwd });
    return answer(line);
  };
  return { run, calls };
}

describe('createSquadWorktree', () => {
  it('makes a git-wt worktree on a new squad branch and returns where git-wt put it', async () => {
    const placed = `${FOLDER}/app.squad-${SHORT}`;
    let listed = '';
    const { run, calls } = recordingRunner((line) => {
      if (line === 'git fetch origin') return OK;
      if (line === LIST) return { code: 0, stdout: listed, stderr: '' };
      if (line.startsWith(`${GIT_WT} switch`)) {
        listed = `worktree ${placed}\nHEAD 2\nbranch refs/heads/squad-${SHORT}\n\n`;
        return OK;
      }
      return unexpected(line);
    });

    const worktree = await createSquadWorktree({
      repo: REPO,
      folderRoot: FOLDER,
      shortId: SHORT,
      gitWt: GIT_WT,
      run,
    });

    expect(worktree).toEqual({ path: placed, branch: `squad-${SHORT}` });
    expect(calls.map((call) => call.line)).toEqual([
      'git fetch origin',
      LIST,
      `${GIT_WT} switch -c squad-${SHORT} --base origin/main --no-cd -y`,
      LIST,
    ]);
    expect(calls.every((call) => call.cwd === REPO)).toBe(true);
  });

  it('makes a plain git worktree under the repo when git-wt is not installed', async () => {
    const placed = join(REPO, '.worktrees', `squad-${SHORT}`);
    const { run, calls } = recordingRunner((line) => {
      if (line === 'git fetch origin' || line === LIST) return OK;
      if (line === `git worktree add -b squad/${SHORT} ${placed} origin/main`) return OK;
      return unexpected(line);
    });

    const worktree = await createSquadWorktree({
      repo: REPO,
      folderRoot: FOLDER,
      shortId: SHORT,
      gitWt: undefined,
      run,
    });

    expect(worktree).toEqual({ path: placed, branch: `squad/${SHORT}` });
    expect(calls.map((call) => call.line)).toEqual([
      'git fetch origin',
      LIST,
      `git worktree add -b squad/${SHORT} ${placed} origin/main`,
    ]);
  });

  it('reuses the worktree already on the squad branch instead of making another', async () => {
    const existing = `${FOLDER}/app.squad-${SHORT}`;
    const porcelain =
      `worktree ${REPO}\nHEAD 1\nbranch refs/heads/main\n\n` +
      `worktree ${existing}\nHEAD 2\nbranch refs/heads/squad-${SHORT}\n\n`;
    const { run, calls } = recordingRunner((line) => {
      if (line === 'git fetch origin') return OK;
      if (line === LIST) return { code: 0, stdout: porcelain, stderr: '' };
      return unexpected(line);
    });

    const worktree = await createSquadWorktree({
      repo: REPO,
      folderRoot: FOLDER,
      shortId: SHORT,
      gitWt: GIT_WT,
      run,
    });

    expect(worktree).toEqual({ path: existing, branch: `squad-${SHORT}` });
    expect(calls.map((call) => call.line)).toEqual(['git fetch origin', LIST]);
  });

  it('stops when git fetch fails, before any worktree is listed or made', async () => {
    const { run, calls } = recordingRunner(() => ({
      code: 128,
      stdout: '',
      stderr: 'fatal: unable to access remote\nmore detail',
    }));

    await expect(
      createSquadWorktree({ repo: REPO, folderRoot: FOLDER, shortId: SHORT, gitWt: GIT_WT, run }),
    ).rejects.toThrow('git fetch origin lỗi: fatal: unable to access remote');
    expect(calls).toHaveLength(1);
  });

  it('refuses a worktree that lands outside the folder', async () => {
    const outside = `/elsewhere/app.squad-${SHORT}`;
    const porcelain = `worktree ${outside}\nHEAD 2\nbranch refs/heads/squad-${SHORT}\n\n`;
    const { run } = recordingRunner((line) => {
      if (line === 'git fetch origin') return OK;
      if (line === LIST) return { code: 0, stdout: porcelain, stderr: '' };
      return unexpected(line);
    });

    await expect(
      createSquadWorktree({ repo: REPO, folderRoot: FOLDER, shortId: SHORT, gitWt: GIT_WT, run }),
    ).rejects.toThrow(`worktree nằm ngoài thư mục của đội (${outside})`);
  });

  it('fails when git-wt reports success but no worktree shows the squad branch', async () => {
    const { run } = recordingRunner((line) => {
      if (line === 'git fetch origin' || line === LIST) return OK;
      if (line.startsWith(`${GIT_WT} switch`)) return OK;
      return unexpected(line);
    });

    await expect(
      createSquadWorktree({ repo: REPO, folderRoot: FOLDER, shortId: SHORT, gitWt: GIT_WT, run }),
    ).rejects.toThrow('git-wt chạy xong nhưng không thấy worktree của nhánh');
  });
});

describe('worktreeOnBranch', () => {
  it('finds the path of the block with the branch checked out, across CRLF output', () => {
    const porcelain = [
      'worktree /work/folder/app',
      'HEAD 1',
      'branch refs/heads/main',
      '',
      `worktree /work/folder/app.squad-${SHORT}`,
      'HEAD 2',
      `branch refs/heads/squad-${SHORT}`,
      '',
      'worktree /work/folder/detached',
      'HEAD 3',
      'detached',
      '',
    ].join('\r\n');

    expect(worktreeOnBranch(porcelain, `squad-${SHORT}`)).toBe(`/work/folder/app.squad-${SHORT}`);
    expect(worktreeOnBranch(porcelain, 'squad-ffffffff')).toBeUndefined();
  });
});

describe('findOnPath', () => {
  it('returns the first PATH directory holding the program, skipping empty entries', () => {
    const suffix = process.platform === 'win32' ? '.exe' : '';
    const hit = join('/opt', 'b', `git-wt${suffix}`);
    const found = findOnPath(
      'git-wt',
      [join('/opt', 'a'), '', join('/opt', 'b')].join(delimiter),
      (path) => path === hit,
    );
    expect(found).toBe(hit);
  });

  it('returns undefined when no PATH directory holds the program', () => {
    expect(findOnPath('git-wt', join('/opt', 'a'), () => false)).toBeUndefined();
    expect(findOnPath('git-wt', '', () => true)).toBeUndefined();
  });
});

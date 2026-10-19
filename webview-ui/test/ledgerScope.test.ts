import { describe, expect, it } from 'vitest';

import type {
  LedgerRepo,
  LedgerUnscannedFolder,
  LedgerView,
  LedgerWorktree,
} from '../../core/src/messages.js';
import type { FolderFocusInput } from '../src/company/folderView.js';
import { ledgerFixtureView } from '../src/company/ledger/ledgerFixture.js';
import { scopeLedgerView } from '../src/company/ledger/ledgerScope.js';

const ACTIVE = 'D:\\Duancanhan\\Project_QuanLyGiaiDau';
const OTHER = 'V:\\Duancanhan\\AICheckVAR';

const folderMode: FolderFocusInput = {
  viewMode: 'folder',
  focusPath: null,
  workspaces: [
    { path: ACTIVE, active: true, open: true, working: 0, waiting: 0 },
    { path: OTHER, active: false, open: true, working: 0, waiting: 0 },
  ],
};
const allMode: FolderFocusInput = { ...folderMode, viewMode: 'all' };

function worktree(path: string, workspacePath: string | undefined): LedgerWorktree {
  return {
    path,
    name: path,
    workspacePath,
    branch: 'main',
    head: 'abc1234',
    isMain: false,
    ahead: 0,
    behind: 0,
    dirtyCount: 0,
    dirtyFiles: [],
    merged: false,
    hasUpstream: true,
    unpushed: 0,
    lastCommitSubject: 'init',
    lastCommitAt: null,
    sessionIds: [],
  };
}

function repo(
  name: string,
  workspacePath: string | undefined,
  worktrees: LedgerWorktree[],
): LedgerRepo {
  return { repo: name, name, workspacePath, worktrees };
}

function viewWith(repos: LedgerRepo[], unscannedFolders: LedgerUnscannedFolder[]): LedgerView {
  return { ...ledgerFixtureView(), repos, unscannedFolders };
}

describe('scopeLedgerView', () => {
  it('returns the same view object in all mode', () => {
    const view = viewWith([repo('shop', ACTIVE, [worktree('/shop', ACTIVE)])], []);
    expect(scopeLedgerView(view, allMode)).toBe(view);
  });

  it('keeps the repos and folders in the active folder and hides the rest in folder mode', () => {
    const inside = repo('shop', ACTIVE, [worktree('/shop', ACTIVE)]);
    const outside = repo('api', OTHER, [worktree('/api', OTHER)]);
    const untagged = repo('tool', undefined, [worktree('/tool', undefined)]);
    const view = viewWith(
      [inside, outside, untagged],
      [
        { path: 'D:/shop-scratch', workspacePath: ACTIVE },
        { path: 'V:/api-scratch', workspacePath: OTHER },
        { path: 'X:/loose' },
      ],
    );

    const scoped = scopeLedgerView(view, folderMode);

    expect(scoped.repos.map((item) => item.repo)).toEqual(['shop']);
    expect(scoped.repos[0]?.worktrees.map((item) => item.path)).toEqual(['/shop']);
    expect(scoped.unscannedFolders.map((item) => item.path)).toEqual(['D:/shop-scratch']);
    expect(scoped.sessions).toBe(view.sessions);
  });

  it('keeps a repo tagged outside when one of its checkouts is in the folder', () => {
    const mixed = repo('shop', OTHER, [
      worktree('/shop-main', OTHER),
      worktree('/shop-feat', ACTIVE),
    ]);

    const scoped = scopeLedgerView(viewWith([mixed], []), folderMode);

    expect(scoped.repos.map((item) => item.repo)).toEqual(['shop']);
    expect(scoped.repos[0]?.worktrees.map((item) => item.path)).toEqual(['/shop-feat']);
  });
});

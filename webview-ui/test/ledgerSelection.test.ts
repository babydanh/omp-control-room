import { describe, expect, it } from 'vitest';

import type {
  LedgerOverlapScan,
  LedgerRepo,
  LedgerSession,
  LedgerView,
  LedgerWorktree,
} from '../../core/src/messages.js';
import { ledgerFixtureView } from '../src/company/ledger/ledgerFixture.js';
import { normalizeCheckoutPath, resolveSelection } from '../src/company/ledger/ledgerSelection.js';

const REPO = 'D:/Code/app';
const MAIN = 'D:/Code/app';
const FEAT = 'D:/Code/app-feat';

function worktree(path: string, isMain: boolean): LedgerWorktree {
  return {
    path,
    name: path.split('/').pop() ?? path,
    branch: isMain ? 'main' : 'feat',
    head: 'abc1234',
    isMain,
    ahead: 0,
    behind: 0,
    dirtyCount: 0,
    dirtyFiles: [],
    merged: false,
    hasUpstream: true,
    lastCommitSubject: '',
    lastCommitAt: null,
    sessionIds: [],
  };
}

const repo: LedgerRepo = {
  repo: REPO,
  name: 'app',
  worktrees: [worktree(MAIN, true), worktree(FEAT, false)],
};

const scan: LedgerOverlapScan = {
  repo: REPO,
  state: 'done',
  startedAt: null,
  finishedAt: null,
  base: 'main',
  lanes: 2,
  pairs: [
    {
      a: MAIN,
      b: FEAT,
      aLabel: 'main',
      bLabel: 'feat',
      conflicts: [{ file: 'x.ts', hunks: [] }],
      auto: ['README.md'],
    },
  ],
  main: [{ lane: FEAT, label: 'feat', conflicts: [{ file: 'y.ts', hunks: [] }] }],
  pending: [],
  complete: true,
  error: null,
};

const session: LedgerSession = {
  sessionId: 'c3a9e7f1',
  agentKind: 'omp',
  agentName: 'worker',
  open: true,
  live: true,
  state: 'idle',
  cwd: FEAT,
  repo: REPO,
  checkout: FEAT,
  branch: 'feat',
  lastIntent: null,
  lastCallAt: null,
  calls5m: 0,
  calls30m: 0,
  spamming: false,
  spamReason: null,
  pid: null,
};

const view: LedgerView = {
  ...ledgerFixtureView(),
  repos: [repo],
  overlaps: [scan],
  sessions: [session],
};

describe('normalizeCheckoutPath', () => {
  it('compares paths by forward slashes, no trailing slash, and lower case', () => {
    expect(normalizeCheckoutPath('D:\\Code\\App\\')).toBe('d:/code/app');
    expect(normalizeCheckoutPath('D:/Code/App')).toBe('d:/code/app');
  });
});

describe('resolveSelection: branches', () => {
  it('finds a worktree whatever spelling the selection path uses', () => {
    const resolved = resolveSelection(view, {
      kind: 'branch',
      repo: REPO,
      path: 'd:\\code\\app-feat\\',
    });
    expect(resolved).toMatchObject({
      kind: 'branch',
      worktree: { path: FEAT },
      repo: { repo: REPO },
    });
  });

  it('resolves nothing for a path the repo does not have', () => {
    expect(resolveSelection(view, { kind: 'branch', repo: REPO, path: 'D:/Code/gone' })).toBeNull();
  });

  it('resolves nothing for a repo the view does not have', () => {
    expect(
      resolveSelection(view, { kind: 'branch', repo: 'D:/Code/other', path: FEAT }),
    ).toBeNull();
  });
});

describe('resolveSelection: sessions', () => {
  it('finds a session by id', () => {
    expect(resolveSelection(view, { kind: 'session', sessionId: 'c3a9e7f1' })).toEqual({
      kind: 'session',
      session,
    });
  });

  it('resolves nothing for an unknown session', () => {
    expect(resolveSelection(view, { kind: 'session', sessionId: 'nope' })).toBeNull();
  });
});

describe('resolveSelection: conflicts', () => {
  it('reads a pair of checkouts with its labels and its auto-merged files', () => {
    const resolved = resolveSelection(view, {
      kind: 'conflict',
      repo: REPO,
      ref: { kind: 'pair', a: MAIN, b: FEAT },
    });
    expect(resolved).toMatchObject({
      kind: 'conflict',
      leftLabel: 'main',
      rightLabel: 'feat',
      auto: ['README.md'],
    });
    expect(resolved?.kind === 'conflict' ? resolved.conflicts : []).toHaveLength(1);
  });

  it('reads a branch against main with main as the right label and nothing auto-merged', () => {
    const resolved = resolveSelection(view, {
      kind: 'conflict',
      repo: REPO,
      ref: { kind: 'main', lane: FEAT },
    });
    expect(resolved).toMatchObject({
      kind: 'conflict',
      leftLabel: 'feat',
      rightLabel: 'main',
      auto: [],
    });
  });

  it('resolves nothing for a pair or lane the scan does not list', () => {
    expect(
      resolveSelection(view, {
        kind: 'conflict',
        repo: REPO,
        ref: { kind: 'pair', a: FEAT, b: FEAT },
      }),
    ).toBeNull();
    expect(
      resolveSelection(view, {
        kind: 'conflict',
        repo: REPO,
        ref: { kind: 'main', lane: 'D:/Code/gone' },
      }),
    ).toBeNull();
  });

  it('resolves nothing when the repo has no overlap scan at all', () => {
    const unscanned: LedgerView = { ...view, overlaps: [] };
    expect(
      resolveSelection(unscanned, {
        kind: 'conflict',
        repo: REPO,
        ref: { kind: 'main', lane: FEAT },
      }),
    ).toBeNull();
  });
});

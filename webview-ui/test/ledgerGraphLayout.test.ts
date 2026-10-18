import { describe, expect, it } from 'vitest';

import type { LedgerOverlapScan, LedgerSession, LedgerWorktree } from '../../core/src/messages.js';
import {
  GRAPH_MAX_DOTS,
  GRAPH_ROW_HEIGHT,
  layoutRepoGraph,
  type RepoGraphInput,
} from '../src/company/ledger/ledgerGraphLayout.js';

const REPO = 'D:/Code/app';
const MAIN_PATH = 'D:/Code/app';

function worktree(path: string, overrides: Partial<LedgerWorktree> = {}): LedgerWorktree {
  return {
    path,
    name: path.split('/').pop() ?? path,
    branch: null,
    head: 'abc1234',
    isMain: false,
    ahead: 0,
    behind: 0,
    dirtyCount: 0,
    dirtyFiles: [],
    merged: false,
    hasUpstream: true,
    lastCommitSubject: '',
    lastCommitAt: null,
    sessionIds: [],
    ...overrides,
  };
}

const main = worktree(MAIN_PATH, { isMain: true, branch: 'main', name: 'app' });

function scan(overrides: Partial<LedgerOverlapScan> = {}): LedgerOverlapScan {
  return {
    repo: REPO,
    state: 'done',
    startedAt: null,
    finishedAt: null,
    base: 'main',
    lanes: 3,
    pairs: [],
    main: [],
    pending: [],
    complete: true,
    error: null,
    ...overrides,
  };
}

function input(
  worktrees: LedgerWorktree[],
  overlap: LedgerOverlapScan | null = null,
  sessions: LedgerSession[] = [],
): RepoGraphInput {
  return { repo: { repo: REPO, name: 'app', worktrees }, sessions, overlap };
}

describe('layoutRepoGraph: rows', () => {
  it('lays out a repo with no worktrees as nothing', () => {
    expect(layoutRepoGraph(input([]), null)).toMatchObject({
      width: 0,
      height: 0,
      mainLine: null,
      rows: [],
      connectors: [],
    });
  });

  it('puts the main line first and each branch below it, one row high', () => {
    const feat = worktree('D:/Code/app-feat', { branch: 'feat' });
    const layout = layoutRepoGraph(input([main, feat]), null);
    expect(layout.rows.map((row) => row.worktree?.path)).toEqual([MAIN_PATH, feat.path]);
    expect(layout.height).toBe(2 * GRAPH_ROW_HEIGHT);
    expect(layout.rows[0].branchPath).toBeNull();
    expect(layout.rows[1].branchPath).not.toBeNull();
  });

  it('keeps a main row with no worktree when the repo has only branches', () => {
    const feat = worktree('D:/Code/app-feat', { branch: 'feat' });
    const layout = layoutRepoGraph(input([feat]), null);
    expect(layout.rows).toHaveLength(2);
    expect(layout.rows[0].worktree).toBeNull();
  });
});

describe('layoutRepoGraph: commits and counts', () => {
  it('draws every ahead commit as a dot when there are few', () => {
    const feat = worktree('D:/Code/app-feat', { ahead: 5 });
    const row = layoutRepoGraph(input([main, feat]), null).rows[1];
    expect(row.dots).toHaveLength(5);
    expect(row.aheadMore).toBe(0);
    expect(row.moreAt).toBeNull();
  });

  it('caps the dots and reports the rest as a count', () => {
    const feat = worktree('D:/Code/app-feat', { ahead: 14 });
    const row = layoutRepoGraph(input([main, feat]), null).rows[1];
    expect(row.dots).toHaveLength(GRAPH_MAX_DOTS);
    expect(row.aheadMore).toBe(2);
    expect(row.moreAt).not.toBeNull();
  });

  it('marks commits behind main on branches only', () => {
    const feat = worktree('D:/Code/app-feat', { behind: 3 });
    const layout = layoutRepoGraph(input([main, feat]), null);
    expect(layout.rows[0].behindAt).toBeNull();
    expect(layout.rows[1].behindAt).not.toBeNull();
  });

  it('dims a branch that is already merged', () => {
    const merged = worktree('D:/Code/app-old', { merged: true });
    const layout = layoutRepoGraph(input([main, merged]), null);
    expect(layout.rows[1].dimmed).toBe(true);
    expect(layout.rows[0].dimmed).toBe(false);
  });
});

describe('layoutRepoGraph: width', () => {
  it('uses the widest dot spacing when width is plentiful', () => {
    const feat = worktree('D:/Code/app-feat', { ahead: GRAPH_MAX_DOTS });
    expect(layoutRepoGraph(input([main, feat]), 10_000).dotGap).toBe(14);
  });

  it('shrinks the spacing to fit the available width, down to the minimum', () => {
    const feat = worktree('D:/Code/app-feat', { ahead: GRAPH_MAX_DOTS });
    const fitted = layoutRepoGraph(input([main, feat]), 200);
    expect(fitted.dotGap).toBeGreaterThanOrEqual(6);
    expect(fitted.dotGap).toBeLessThan(14);
    expect(fitted.width).toBeLessThanOrEqual(200);
    expect(layoutRepoGraph(input([main, feat]), 1).dotGap).toBe(6);
  });
});

describe('layoutRepoGraph: conflict connectors', () => {
  it('draws a connector between two branches that conflict', () => {
    const a = worktree('D:/Code/app-a');
    const b = worktree('D:/Code/app-b');
    const overlap = scan({
      pairs: [
        {
          a: a.path,
          b: b.path,
          aLabel: 'a',
          bLabel: 'b',
          conflicts: [{ file: 'x.ts', hunks: [] }],
          auto: [],
        },
      ],
    });
    const layout = layoutRepoGraph(input([main, a, b], overlap), null);
    expect(layout.connectors).toHaveLength(1);
    expect(layout.connectors[0]).toMatchObject({
      ref: { kind: 'pair', a: a.path, b: b.path },
      upper: 1,
      lower: 2,
      conflictCount: 1,
    });
  });

  it('draws a connector between a branch and main when they conflict', () => {
    const a = worktree('D:/Code/app-a');
    const overlap = scan({
      main: [{ lane: a.path, label: 'a', conflicts: [{ file: 'y.ts', hunks: [] }] }],
    });
    const layout = layoutRepoGraph(input([main, a], overlap), null);
    expect(layout.connectors).toHaveLength(1);
    expect(layout.connectors[0]).toMatchObject({ ref: { kind: 'main', lane: a.path }, upper: 0 });
  });

  it('draws nothing for a pair with no conflicts or a checkout that is not present', () => {
    const a = worktree('D:/Code/app-a');
    const quiet = scan({
      pairs: [{ a: a.path, b: MAIN_PATH, aLabel: 'a', bLabel: 'main', conflicts: [], auto: [] }],
    });
    expect(layoutRepoGraph(input([main, a], quiet), null).connectors).toEqual([]);

    const gone = scan({
      pairs: [
        {
          a: a.path,
          b: 'D:/Code/gone',
          aLabel: 'a',
          bLabel: 'gone',
          conflicts: [{ file: 'z.ts', hunks: [] }],
          auto: [],
        },
      ],
    });
    expect(layoutRepoGraph(input([main, a], gone), null).connectors).toEqual([]);
  });

  it('gives overlapping connector runs different slots', () => {
    const a = worktree('D:/Code/app-a');
    const b = worktree('D:/Code/app-b');
    const c = worktree('D:/Code/app-c');
    const conflict = [{ file: 'x.ts', hunks: [] }];
    const overlap = scan({
      pairs: [
        { a: a.path, b: b.path, aLabel: 'a', bLabel: 'b', conflicts: conflict, auto: [] },
        { a: a.path, b: c.path, aLabel: 'a', bLabel: 'c', conflicts: conflict, auto: [] },
      ],
    });
    const [first, second] = layoutRepoGraph(input([main, a, b, c], overlap), null).connectors;
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(first?.slot).not.toBe(second?.slot);
  });
});

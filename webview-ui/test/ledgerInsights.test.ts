import { describe, expect, it } from 'vitest';

import type {
  LedgerOverlapScan,
  LedgerRepo,
  LedgerView,
  LedgerWorktree,
} from '../../core/src/messages.js';
import { ledgerFixtureView } from '../src/company/ledger/ledgerFixture.js';
import { actionPlan, buildInsights } from '../src/company/ledger/ledgerInsights.js';

const REPO = 'D:/Code/app';
const MAIN = `${REPO}/main`;
const A = `${REPO}/a`;
const B = `${REPO}/b`;
const C = `${REPO}/c`;
const D = `${REPO}/d`;
const NOW = Date.parse('2026-10-21T12:00:00Z');

function worktree(path: string, overrides: Partial<LedgerWorktree> = {}): LedgerWorktree {
  const name = path.slice(path.lastIndexOf('/') + 1);
  return {
    path,
    name,
    branch: name === 'main' ? 'main' : `feature/${name}`,
    head: `head-${name}`,
    isMain: name === 'main',
    ahead: 0,
    behind: 0,
    dirtyCount: 0,
    dirtyFiles: [],
    merged: false,
    hasUpstream: true,
    unpushed: 0,
    lastCommitSubject: `Sửa ${name}`,
    lastCommitAt: '2026-10-21 10:00:00',
    sessionIds: [],
    ...overrides,
  };
}

function scan(overrides: Partial<LedgerOverlapScan> = {}): LedgerOverlapScan {
  return {
    repo: REPO,
    state: 'done',
    startedAt: null,
    finishedAt: null,
    base: 'origin/main',
    lanes: 3,
    pairs: [],
    main: [],
    pending: [],
    complete: true,
    error: null,
    ...overrides,
  };
}

function view(worktrees: LedgerWorktree[], overlap: LedgerOverlapScan = scan()): LedgerView {
  const repo: LedgerRepo = { repo: REPO, name: 'app', worktrees };
  return {
    ...ledgerFixtureView(),
    repos: [repo],
    overlaps: [overlap],
    sessions: [],
    pending: [],
    mergeBlocks: [],
  };
}

function insight(worktrees: LedgerWorktree[], overlap: LedgerOverlapScan = scan()) {
  return buildInsights(view(worktrees, overlap), NOW)[0]!;
}

function branches(worktrees: LedgerWorktree[], overlap: LedgerOverlapScan = scan()) {
  return insight(worktrees, overlap).rows;
}

describe('buildInsights branch statuses', () => {
  it('classifies trunk, merged, collisions, behind, working and ready branches', () => {
    const rows = branches(
      [
        worktree(MAIN),
        worktree(A, { ahead: 2, behind: 0 }),
        worktree(B, { merged: true }),
        worktree(C, { behind: 4 }),
        worktree(`${REPO}/dirty`, { dirtyCount: 1 }),
        worktree(`${REPO}/live`, { sessionIds: ['session-live'] }),
      ],
      scan({ main: [{ lane: A, label: 'feature/a', conflicts: [{ file: 'a.ts', hunks: [] }] }] }),
    );

    expect(rows.map(({ branch, status }) => [branch, status])).toEqual([
      ['main', 'trunk'],
      ['feature/a', 'collide'],
      ['feature/b', 'merged'],
      ['feature/c', 'rebase'],
      ['feature/dirty', 'working'],
      ['feature/live', 'working'],
    ]);
    expect(insight(
      [worktree(MAIN), worktree(A, { ahead: 2 }), worktree(B, { merged: true }), worktree(C, { behind: 4 }), worktree(`${REPO}/dirty`, { dirtyCount: 1 })],
      scan({ main: [{ lane: A, label: 'feature/a', conflicts: [{ file: 'a.ts', hunks: [] }] }] }),
    ).chips).toEqual({ collide: 1, rebase: 1, unpushed: 0, dirty: 1, cleanable: 1 });
  });

  it('ignores clashes with already merged branches', () => {
    const rows = branches(
      [worktree(MAIN), worktree(A, { ahead: 2 }), worktree(B, { merged: true })],
      scan({
        pairs: [{ a: A, b: B, aLabel: 'feature/a', bLabel: 'feature/b', conflicts: [{ file: 'shared.ts', hunks: [] }], auto: [] }],
      }),
    );
    expect(rows.find((row) => row.branch === 'feature/a')?.status).toBe('ready');
  });
  it('treats a recent merge block newer than the branch commit as a collision', () => {
    const base = view([worktree(MAIN), worktree(A, { ahead: 1, lastCommitAt: '2026-10-21 10:00:00' })]);
    const result = buildInsights({
      ...base,
      mergeBlocks: [{
        repo: REPO,
        branch: 'feature/a',
        at: '2026-10-21T11:30:00Z',
        briefPath: 'conflict.md',
        files: ['src/from-merge-block.ts'],
      }],
    }, NOW)[0]!;

    expect(result.rows.find((row) => row.branch === 'feature/a')?.status).toBe('collide');
    expect(result.todos.find((todo) => todo.kind === 'resolve')?.files).toEqual(['src/from-merge-block.ts']);
  });
});

describe('collision matrix and live edits', () => {
  it('includes main, conflict hunks, auto overlaps and orders real collisions first', () => {
    const result = insight(
      [worktree(MAIN), worktree(A), worktree(B)],
      scan({
        pairs: [{
          a: A,
          b: B,
          aLabel: 'feature/a',
          bLabel: 'feature/b',
          conflicts: [{ file: 'z-conflict.ts', hunks: [{ line: 18, symbol: 'save', ours: ['ours'], theirs: ['theirs'] }] }],
          auto: ['a-auto.ts'],
        }],
        main: [{ lane: A, label: 'feature/a', conflicts: [{ file: 'main-conflict.ts', hunks: [] }] }],
      }),
    );

    expect(result.matrix.columns.map((column) => column.path)).toEqual([MAIN, A, B]);
    expect(result.matrix.rows.map((row) => row.file)).toEqual(['main-conflict.ts', 'z-conflict.ts', 'a-auto.ts']);
    expect(result.matrix.rows[0]?.cells[MAIN]).toBe('conflict');
    expect(result.matrix.rows[0]?.cells[A]).toBe('conflict');
    expect(result.matrix.rows[2]?.cells[A]).toBe('auto');
    expect(result.matrix.rows[2]?.cells[B]).toBe('auto');
    expect(result.matrix.rows[1]?.hunks[0]).toMatchObject({
      a: A,
      b: B,
      aLabel: 'feature/a',
      bLabel: 'feature/b',
      line: 18,
      symbol: 'save',
      ours: 'ours',
      theirs: 'theirs',
    });
  });

  it('finds uncommitted files edited in multiple checkouts', () => {
    const result = insight([
      worktree(MAIN, { dirtyCount: 1, dirtyFiles: [{ path: 'src/shared.ts', status: ' M' }] }),
      worktree(A, { dirtyCount: 1, dirtyFiles: [{ path: 'src/shared.ts', status: ' M' }] }),
      worktree(B, { dirtyCount: 1, dirtyFiles: [{ path: 'src/solo.ts', status: ' M' }] }),
    ]);
    expect(result.liveEdits).toEqual([
      { file: 'src/shared.ts', checkouts: [
        { path: MAIN, label: 'main', sessionIds: [] },
        { path: A, label: 'feature/a', sessionIds: [] },
      ] },
    ]);
  });
});

describe('todo ordering and merge recommendations', () => {
  it('orders resolve, notify, grouped rebase and push actions', () => {
    const result = insight(
      [worktree(MAIN), worktree(A, { ahead: 3, unpushed: 2 }), worktree(B), worktree(C, { ahead: 1, behind: 5 }), worktree(D, { ahead: 2, behind: 8 })],
      scan({
        main: [{ lane: A, label: 'feature/a', conflicts: [{ file: 'src/x.ts', hunks: [] }] }],
        pairs: [{ a: A, b: B, aLabel: 'feature/a', bLabel: 'feature/b', conflicts: [{ file: 'src/y.ts', hunks: [] }], auto: [] }],
      }),
    );
    expect(result.todos.map((todo) => todo.kind)).toEqual(['resolve', 'notify', 'rebase', 'push']);
    expect(result.todos[2]?.branches).toEqual(['feature/d', 'feature/c']);
    expect(result.todos.filter((todo) => todo.kind === 'rebase')).toHaveLength(1);
  });

  it('offers one merge for one ready branch and a train for multiple ready branches', () => {
    const one = insight([worktree(MAIN), worktree(A, { ahead: 1 })]);
    const two = insight([worktree(MAIN), worktree(A, { ahead: 1 }), worktree(B, { ahead: 2 })]);
    expect(one.todos.map((todo) => todo.kind)).toContain('merge');
    expect(one.todos.map((todo) => todo.kind)).not.toContain('train');
    expect(two.todos.map((todo) => todo.kind)).toContain('train');
    expect(two.todos.map((todo) => todo.kind)).not.toContain('merge');
  });

  it('puts the lower-cost side of a collision pair first in merge order', () => {
    const result = insight(
      [worktree(MAIN), worktree(A, { ahead: 1, behind: 1 }), worktree(B, { ahead: 6, behind: 5 }), worktree(C, { ahead: 2, behind: 0 })],
      scan({ pairs: [{ a: A, b: B, aLabel: 'feature/a', bLabel: 'feature/b', conflicts: [{ file: 'src/shared.ts', hunks: [] }], auto: [] }] }),
    );
    expect(result.mergeOrder.map((step) => step.path)).toEqual([C, A, B]);
    expect(result.mergeOrder.every((step) => step.reason.length > 0)).toBe(true);
  });
});

describe('actionPlan', () => {
  it('includes the collision file and line in the agent message and a runnable rebase command', () => {
    const result = insight(
      [worktree(MAIN), worktree(A, { ahead: 1 })],
      scan({ main: [{ lane: A, label: 'feature/a', conflicts: [{ file: 'src/save.ts', hunks: [{ line: 27, symbol: 'saveRecord', ours: ['ours'], theirs: ['theirs'] }] }] }] }),
    );
    const todo = result.todos.find((item) => item.kind === 'resolve')!;
    const plan = actionPlan(todo, result);
    expect(plan.message).toContain('src/save.ts');
    expect(plan.message).toContain('27');
    expect(plan.message).toContain('saveRecord');
    expect(plan.message).toContain('giữ ý định cả hai bên');
    expect(plan.message).toContain(plan.command);
    expect(plan.command).toBe(`git -C ${A} rebase origin/main`);
  });
});

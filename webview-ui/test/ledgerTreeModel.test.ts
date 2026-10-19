import { describe, expect, it } from 'vitest';

import type {
  LedgerOverlapScan,
  LedgerRepo,
  LedgerSession,
  LedgerWorktree,
} from '../../core/src/messages.js';
import type { PaneInput } from '../src/company/ledger/ledgerManagers.js';
import { normalizeCheckoutPath } from '../src/company/ledger/ledgerSelection.js';
import {
  buildRepoTree,
  type TreeContext,
  TRUNK_ID,
} from '../src/company/ledger/ledgerTreeModel.js';

const GENERATED = '2026-10-18 10:00:00';
const TRUNK = 'D:/Code/app';
const CLASH = 'D:/Code/app-clash';
const BEHIND = 'D:/Code/app-behind';
const READY = 'D:/Code/app-ready';
const BUSY_MERGED = 'D:/Code/app-busy';
const DONE = 'D:/Code/app-done';

function worktree(path: string, overrides: Partial<LedgerWorktree> = {}): LedgerWorktree {
  return {
    path,
    name: path.slice(path.lastIndexOf('/') + 1),
    branch: 'feat/x',
    head: 'abc1234',
    isMain: false,
    ahead: 0,
    behind: 0,
    dirtyCount: 0,
    dirtyFiles: [],
    merged: false,
    hasUpstream: true,
    unpushed: 0,
    lastCommitSubject: 'Thêm việc',
    lastCommitAt: '2026-10-18 09:00:00',
    sessionIds: [],
    ...overrides,
  };
}

/**
 * One repo with a trunk and five branches: one clashing with main, one behind, one ready,
 * one merged but still in use, and one merged and cleanable.
 */
const REPO: LedgerRepo = {
  repo: TRUNK,
  name: 'app',
  worktrees: [
    worktree(TRUNK, { isMain: true, branch: 'main' }),
    worktree(CLASH, { branch: 'feat/clash' }),
    worktree(BEHIND, { branch: 'feat/behind', behind: 2 }),
    worktree(READY, { branch: 'feat/ready' }),
    worktree(BUSY_MERGED, { branch: 'feat/busy', merged: true, sessionIds: ['s-busy'] }),
    worktree(DONE, { branch: 'feat/done', merged: true }),
  ],
};

const CLEAN_SCAN: LedgerOverlapScan = {
  repo: TRUNK,
  state: 'done',
  startedAt: null,
  finishedAt: null,
  base: 'origin/main',
  lanes: 5,
  pairs: [],
  main: [],
  pending: [],
  complete: true,
  error: null,
};

/** The clash is with main, and a merged branch also touches it: that second clash is moot. */
const SCAN: LedgerOverlapScan = {
  ...CLEAN_SCAN,
  pairs: [
    {
      a: CLASH,
      b: TRUNK,
      aLabel: 'feat/clash',
      bLabel: 'main',
      conflicts: [{ file: 'x.ts', hunks: [] }],
      auto: [],
    },
    {
      a: BUSY_MERGED,
      b: CLASH,
      aLabel: 'feat/busy',
      bLabel: 'feat/clash',
      conflicts: [{ file: 'y.ts', hunks: [] }],
      auto: [],
    },
  ],
};

function session(overrides: Partial<LedgerSession>): LedgerSession {
  return {
    sessionId: 's-1',
    agentKind: 'omp',
    agentName: 'Phiên một',
    open: true,
    live: true,
    state: 'idle',
    cwd: CLASH,
    repo: TRUNK,
    checkout: CLASH,
    branch: 'feat/clash',
    lastIntent: null,
    lastCallAt: '2026-10-18 09:58:00',
    calls5m: 0,
    calls30m: 0,
    spamming: false,
    spamReason: null,
    pid: null,
    ...overrides,
  };
}

function context(overrides: Partial<TreeContext> = {}): TreeContext {
  return {
    sessions: [],
    pending: [],
    panes: [],
    boardSessions: {},
    generatedAt: GENERATED,
    ...overrides,
  };
}

const TRUNK_KEY = normalizeCheckoutPath(TRUNK);
const CLASH_KEY = normalizeCheckoutPath(CLASH);
const BEHIND_KEY = normalizeCheckoutPath(BEHIND);
const READY_KEY = normalizeCheckoutPath(READY);
const BUSY_KEY = normalizeCheckoutPath(BUSY_MERGED);
const DONE_KEY = normalizeCheckoutPath(DONE);

describe('buildRepoTree', () => {
  it('puts the trunk first and branches by urgency, and hides cleanable merged branches until asked', () => {
    const hidden = buildRepoTree(REPO, SCAN, context(), false);
    expect(hidden.nodes.map((node) => node.id)).toEqual([
      TRUNK_KEY,
      CLASH_KEY,
      BEHIND_KEY,
      READY_KEY,
      BUSY_KEY,
    ]);
    expect(hidden.foldedCount).toBe(1);

    const shown = buildRepoTree(REPO, SCAN, context(), true);
    expect(shown.nodes.map((node) => node.id)).toEqual([
      TRUNK_KEY,
      CLASH_KEY,
      BEHIND_KEY,
      READY_KEY,
      BUSY_KEY,
      DONE_KEY,
    ]);
    expect(shown.foldedCount).toBe(1);
  });

  it('draws a conflict only between cards on the tree, and never one that ends in a merged branch', () => {
    const tree = buildRepoTree(REPO, SCAN, context(), true);
    expect(tree.conflicts.map((conflict) => conflict.id)).toEqual([
      `pair:${CLASH_KEY}|${TRUNK_KEY}`,
    ]);
  });

  it('draws a conflict between a branch and main from the main lane', () => {
    const scan: LedgerOverlapScan = {
      ...CLEAN_SCAN,
      main: [{ lane: CLASH, label: 'feat/clash', conflicts: [{ file: 'x.ts', hunks: [] }] }],
    };
    const tree = buildRepoTree(REPO, scan, context(), false);
    expect(tree.conflicts).toEqual([
      {
        id: `main:${CLASH_KEY}`,
        ref: { kind: 'main', lane: CLASH },
        a: CLASH_KEY,
        b: TRUNK_KEY,
        files: 1,
      },
    ]);
  });

  it('gives one header line that counts what needs doing across all branches', () => {
    const tree = buildRepoTree(REPO, SCAN, context(), false);
    expect(tree.summary).toBe('5 nhánh · 1 cần rebase · 1 sắp xung đột · 1 đã gộp, có thể dọn');
    expect(tree.name).toBe('app');
  });

  it('attaches each manager to the card of the checkout it runs in', () => {
    const panes: PaneInput[] = [
      {
        paneId: 'pane-7',
        kind: 'Claude',
        status: 'working',
        location: `${BEHIND}/src`,
        title: null,
        sleptAt: null,
      },
    ];
    const tree = buildRepoTree(REPO, SCAN, context({ sessions: [session({})], panes }), false);
    const byId = new Map(tree.nodes.map((node) => [node.id, node] as const));
    expect(byId.get(CLASH_KEY)?.managers.map((chip) => chip.key)).toEqual(['session:s-1']);
    expect(byId.get(BEHIND_KEY)?.managers.map((chip) => chip.key)).toEqual(['pane:pane-7']);
    expect(byId.get(READY_KEY)?.managers).toEqual([]);
  });

  it('falls back to a trunk card when this machine has no main checkout', () => {
    const noMain: LedgerRepo = {
      ...REPO,
      worktrees: REPO.worktrees.filter((item) => !item.isMain),
    };
    const tree = buildRepoTree(noMain, null, context(), false);
    expect(tree.nodes[0]).toMatchObject({
      id: TRUNK_ID,
      trunk: true,
      worktree: null,
      managers: [],
    });
  });
});

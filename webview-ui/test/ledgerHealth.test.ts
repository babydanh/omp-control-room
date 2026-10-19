import { describe, expect, it } from 'vitest';

import type { LedgerOverlapScan, LedgerWorktree } from '../../core/src/messages.js';
import {
  checkoutHealth,
  type HealthInput,
  type NodeHealth,
  repoSummary,
  type SummaryNode,
  UNSCANNED_TEXT,
} from '../src/company/ledger/ledgerHealth.js';
import { normalizeCheckoutPath } from '../src/company/ledger/ledgerSelection.js';

const NOW_MS = Date.parse('2026-10-18T10:00:00');
const TRUNK = 'D:/Code/app';
const BRANCH = 'D:/Code/app-feat';
const OTHER = 'D:/Code/app-other';
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

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

const CLEAN_SCAN: LedgerOverlapScan = {
  repo: TRUNK,
  state: 'done',
  startedAt: null,
  finishedAt: null,
  base: 'origin/main',
  lanes: 2,
  pairs: [],
  main: [],
  pending: [],
  complete: true,
  error: null,
};

/** A finished scan in which `a` and `b` clash in `files` files. */
function clashScan(a: string, b: string, files: number): LedgerOverlapScan {
  const conflicts = Array.from({ length: files }, (_, index) => ({
    file: `tep${index}.ts`,
    hunks: [],
  }));
  return {
    ...CLEAN_SCAN,
    pairs: [{ a, b, aLabel: 'feat/mine', bLabel: 'feat/other', conflicts, auto: [] }],
  };
}

function health(item: LedgerWorktree, overrides: Partial<HealthInput> = {}): NodeHealth {
  return checkoutHealth({
    worktree: item,
    scan: CLEAN_SCAN,
    pending: [],
    mergedPaths: new Set<string>(),
    nowMs: NOW_MS,
    sessionActivityMs: null,
    ...overrides,
  });
}

function texts(result: NodeHealth): string[] {
  return result.reasons.map((item) => item.text);
}

describe('checkoutHealth', () => {
  it('calls a finished, clean branch ok and gives it no reasons', () => {
    expect(health(worktree(BRANCH))).toEqual({ tone: 'ok', reasons: [], cleanable: false });
  });

  it('says a scan that never finished is unknown, not clean', () => {
    const result = health(worktree(BRANCH), { scan: null });
    expect(result.tone).toBe('attention');
    expect(texts(result)).toEqual([UNSCANNED_TEXT]);
  });

  it('names the other live branch in a conflict, and a conflict is the worst tone', () => {
    const result = health(worktree(BRANCH), { scan: clashScan(BRANCH, OTHER, 2) });
    expect(result.tone).toBe('conflict');
    expect(result.reasons[0]).toMatchObject({
      key: 'conflict',
      tone: 'conflict',
      text: 'Sẽ xung đột với feat/other ở 2 tệp',
    });
  });

  it('reports a clash with main from the main lane of this branch', () => {
    const scan: LedgerOverlapScan = {
      ...CLEAN_SCAN,
      main: [
        {
          lane: BRANCH,
          label: 'feat/mine',
          conflicts: [{ file: 'tep0.ts', hunks: [] }],
        },
      ],
    };
    expect(texts(health(worktree(BRANCH), { scan }))).toEqual(['Sẽ xung đột với main ở 1 tệp']);
  });

  it('ignores a clash with a merged branch, since that work is already in main', () => {
    const result = health(worktree(BRANCH), {
      scan: clashScan(BRANCH, OTHER, 2),
      mergedPaths: new Set([normalizeCheckoutPath(OTHER)]),
    });
    expect(result.tone).toBe('ok');
    expect(result.reasons).toEqual([]);
  });

  it('counts unpushed commits as attention', () => {
    const result = health(worktree(BRANCH, { unpushed: 3 }));
    expect(result.tone).toBe('attention');
    expect(texts(result)).toEqual(['3 commit chưa đẩy lên GitHub']);
  });

  it('says a branch with no upstream and commits ahead was never pushed', () => {
    const neverPushed = worktree(BRANCH, { hasUpstream: false, unpushed: null, ahead: 2 });
    expect(texts(health(neverPushed))).toEqual(['Chưa đẩy lên GitHub', '2 commit chưa vào main']);
  });

  it('stays quiet about a missing upstream when the pending row says there is no remote', () => {
    const neverPushed = worktree(BRANCH, { hasUpstream: false, unpushed: null, ahead: 2 });
    const pending = [
      {
        checkout: BRANCH,
        sessionId: null,
        branch: 'feat/x',
        dirty: 0,
        unpushed: 0,
        notInMain: 2,
        hasRemote: false,
        ts: '2026-10-18 09:00:00',
      },
    ];
    expect(texts(health(neverPushed, { pending }))).toEqual(['2 commit chưa vào main']);
  });

  it('says a branch that fell behind main should rebase', () => {
    expect(texts(health(worktree(BRANCH, { behind: 4 })))).toEqual([
      'Tụt sau main 4 commit — nên rebase',
    ]);
  });

  it('marks a branch idle for three days with no session as abandoned', () => {
    const result = health(worktree(BRANCH, { lastCommitAt: '2026-10-14 10:00:00' }));
    expect(result.tone).toBe('attention');
    expect(texts(result)).toEqual(['Bỏ quên: không ai động 4 ngày']);
  });

  it('keeps a branch out of the abandoned list while a session is in it or it was recently used', () => {
    const idle = { lastCommitAt: '2026-10-14 10:00:00' };
    expect(health(worktree(BRANCH, { ...idle, sessionIds: ['s1'] })).reasons).toEqual([]);
    expect(health(worktree(BRANCH, idle), { sessionActivityMs: NOW_MS - HOUR_MS }).reasons).toEqual(
      [],
    );
  });

  it('reads the age of an abandoned branch in whole days', () => {
    const threeAndAHalfDays = NOW_MS - 3.5 * DAY_MS;
    const result = health(worktree(BRANCH, { lastCommitAt: null }), {
      sessionActivityMs: threeAndAHalfDays,
    });
    expect(texts(result)).toEqual(['Bỏ quên: không ai động 3 ngày']);
  });

  it('calls a merged, clean, idle branch cleanable and toned merged', () => {
    const merged = health(worktree(BRANCH, { merged: true, lastCommitAt: '2026-10-01 10:00:00' }));
    expect(merged.tone).toBe('merged');
    expect(merged.cleanable).toBe(true);
    expect(texts(merged)).toEqual(['Đã gộp vào main']);
  });

  it('keeps a merged branch with a session, unsaved files, or unpushed commits out of the cleanable list', () => {
    expect(health(worktree(BRANCH, { merged: true, sessionIds: ['s1'] })).cleanable).toBe(false);
    expect(health(worktree(BRANCH, { merged: true, dirtyCount: 1 })).cleanable).toBe(false);
    expect(health(worktree(BRANCH, { merged: true, unpushed: 1 })).cleanable).toBe(false);
  });

  it('reads the trunk for its own unsaved files only, never conflicts or staleness', () => {
    const trunk = worktree(TRUNK, {
      isMain: true,
      dirtyCount: 2,
      behind: 5,
      lastCommitAt: '2026-10-01 10:00:00',
    });
    const result = health(trunk, { scan: clashScan(TRUNK, OTHER, 2) });
    expect(texts(result)).toEqual(['2 file sửa chưa commit']);
    expect(result.tone).toBe('attention');
  });
});

describe('repoSummary', () => {
  it('counts what needs doing across the branches of a repo', () => {
    const trunk: SummaryNode = {
      trunk: true,
      health: health(worktree(TRUNK, { isMain: true })),
    };
    const clashing: SummaryNode = {
      trunk: false,
      health: health(worktree(BRANCH), { scan: clashScan(BRANCH, OTHER, 2) }),
    };
    const behind: SummaryNode = {
      trunk: false,
      health: health(worktree(OTHER, { behind: 2 })),
    };
    const merged: SummaryNode = {
      trunk: false,
      health: health(worktree('D:/Code/app-old', { merged: true })),
    };
    expect(repoSummary([trunk, clashing, behind, merged])).toBe(
      '3 nhánh · 1 cần rebase · 1 sắp xung đột · 1 đã gộp, có thể dọn',
    );
  });

  it('says there are no branches when only the trunk exists', () => {
    const trunk: SummaryNode = { trunk: true, health: health(worktree(TRUNK, { isMain: true })) };
    expect(repoSummary([trunk])).toBe('Chưa có nhánh phụ');
  });
});

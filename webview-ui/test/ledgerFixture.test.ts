import { describe, expect, it } from 'vitest';

import {
  LEDGER_FIXTURE_NOW,
  ledgerFixtureTimeline,
  ledgerFixtureView,
} from '../src/company/ledger/ledgerFixture.js';
import { LEDGER_WINDOWS } from '../src/company/ledger/ledgerFormat.js';
import { layoutTimeline } from '../src/company/ledger/ledgerTimelineLayout.js';
import { buildRepoTree } from '../src/company/ledger/ledgerTreeModel.js';

describe('ledger fixture view', () => {
  it('is a board with repos and sessions, stamped with the fixture clock', () => {
    const view = ledgerFixtureView();
    expect(view.generatedAt).toBe(LEDGER_FIXTURE_NOW);
    expect(view.repos.length).toBeGreaterThan(0);
    expect(view.sessions.length).toBeGreaterThan(0);
  });

  it('builds one card per checkout: the trunk plus every branch, folded ones included', () => {
    const view = ledgerFixtureView();
    for (const repo of view.repos) {
      const overlap = view.overlaps.find((scan) => scan.repo === repo.repo) ?? null;
      const tree = buildRepoTree(
        repo,
        overlap,
        {
          sessions: view.sessions,
          pending: view.pending,
          panes: [],
          boardSessions: {},
          generatedAt: view.generatedAt,
        },
        true,
      );
      const branches = repo.worktrees.filter((worktree) => !worktree.isMain).length;
      expect(tree.nodes).toHaveLength(1 + branches);
    }
  });
});

describe('ledger fixture timeline', () => {
  it('answers every timeline window with that window and lays out each of its lanes', () => {
    for (const windowMinutes of LEDGER_WINDOWS) {
      const timeline = ledgerFixtureTimeline(windowMinutes);
      expect(timeline.windowMinutes).toBe(windowMinutes);
      expect(layoutTimeline(timeline, 600).lanes).toHaveLength(timeline.lanes.length);
    }
  });
});

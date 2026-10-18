import { describe, expect, it } from 'vitest';

import {
  LEDGER_FIXTURE_NOW,
  ledgerFixtureTimeline,
  ledgerFixtureView,
} from '../src/company/ledger/ledgerFixture.js';
import { LEDGER_WINDOWS } from '../src/company/ledger/ledgerFormat.js';
import { layoutRepoGraph } from '../src/company/ledger/ledgerGraphLayout.js';
import { layoutTimeline } from '../src/company/ledger/ledgerTimelineLayout.js';

describe('ledger fixture view', () => {
  it('is a board with repos and sessions, stamped with the fixture clock', () => {
    const view = ledgerFixtureView();
    expect(view.generatedAt).toBe(LEDGER_FIXTURE_NOW);
    expect(view.repos.length).toBeGreaterThan(0);
    expect(view.sessions.length).toBeGreaterThan(0);
  });

  it('lays out every repo as one row for main plus one per branch', () => {
    const view = ledgerFixtureView();
    for (const repo of view.repos) {
      const overlap = view.overlaps.find((scan) => scan.repo === repo.repo) ?? null;
      const layout = layoutRepoGraph({ repo, sessions: view.sessions, overlap }, 800);
      const branches = repo.worktrees.filter((worktree) => !worktree.isMain).length;
      expect(layout.rows).toHaveLength(1 + branches);
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

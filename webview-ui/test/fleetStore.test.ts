import { describe, expect, it } from 'vitest';

import type { ClientMessage, FleetPullRequest, ServerMessage } from '../../core/src/messages.js';
import { createFleetStore } from '../src/company/fleet/fleetStore.js';

const failedPullRequest: FleetPullRequest = {
  number: 42,
  state: 'open',
  isDraft: false,
  reviewDecision: null,
  url: 'https://github.com/org/repo/pull/42',
  ci: 'red',
  failedChecks: ['lint', 'typecheck'],
};

describe('fleet comment actions', () => {
  it('sends cloud comments as bounded structured requests and clears successful actions', () => {
    const sent: ClientMessage[] = [];
    const store = createFleetStore({ send: (message) => sent.push(message), newRequestId: () => 'r1' });
    const comment = {
      machine: 'cloud-a',
      path: '/data/home/wt/repo-task',
      session: 'repo-task',
      branch: 'cloud/repo-task',
      file: 'src/a.ts',
      line: 12,
      snippet: '+const broken = true;',
      content: 'Please fix this line.',
    };

    store.sendCloudComment(comment);

    expect(sent).toEqual([{ type: 'fleetCloudCommentSend', requestId: 'r1', ...comment }]);
    expect(store.getSnapshot().action).toMatchObject({ kind: 'comment', machine: 'cloud-a', session: 'repo-task' });
    store.accept({ type: 'fleetCommandResult', requestId: 'r1', ok: true, code: 'success' } as ServerMessage);
    expect(store.getSnapshot().action).toBeNull();
    expect(store.getSnapshot().actionError).toBeNull();
  });

  it('runs a local branch action and refreshes PR status after success', () => {
    let requestIndex = 0;
    const sent: ClientMessage[] = [];
    const store = createFleetStore({
      send: (message) => sent.push(message),
      newRequestId: () => `branch-${++requestIndex}`,
    });

    store.runBranchAction({ action: 'push', checkout: 'C:/repo/.worktrees/task', branch: 'feature/task' });
    expect(sent[0]).toEqual({
      type: 'fleetBranchAction',
      requestId: 'branch-1',
      action: 'push',
      checkout: 'C:/repo/.worktrees/task',
      branch: 'feature/task',
    });
    expect(store.getSnapshot().action).toMatchObject({
      kind: 'branch',
      machine: 'local',
      session: 'feature/task',
    });

    store.accept({ type: 'fleetCommandResult', requestId: 'branch-1', ok: true, code: 'success' } as ServerMessage);
    expect(sent[1]).toEqual({ type: 'fleetRequest', requestId: 'branch-2' });
    expect(store.getSnapshot().action).toBeNull();
    expect(store.getSnapshot().latestRequestId).toBe('branch-2');
  });

  it('routes a local CI failure through the existing project diff comment message', () => {
    const sent: ClientMessage[] = [];
    const store = createFleetStore({ send: (message) => sent.push(message), newRequestId: () => 'r2' });

    store.sendLocalCiFailureComment('C:/repo/.worktrees/task', 'session-1', failedPullRequest);

    expect(sent).toEqual([{
      type: 'projectComment',
      requestId: 'r2',
      checkout: 'C:/repo/.worktrees/task',
      receivingSessionId: 'session-1',
      file: 'CI / PR #42',
      line: 1,
      snippet: 'lint\ntypecheck',
      content: 'CI đỏ · PR #42 · https://github.com/org/repo/pull/42. Hãy xử lý lỗi CI; không tự gộp.',
    }]);
  });

  it('accepts a late background analysis for the current fleet snapshot', () => {
    let requestIndex = 0;
    const store = createFleetStore({
      send: () => undefined,
      newRequestId: () => `r${++requestIndex}`,
    });
    const requestId = store.requestFleet();
    store.accept({
      type: 'fleetSnapshot',
      requestId,
      machines: [],
      overlaps: [],
      branchAnalyses: [],
      branchAnalysisPending: true,
    });
    store.accept({
      type: 'fleetSnapshot',
      requestId,
      machines: [],
      overlaps: [],
      branchAnalyses: [{
        id: 'local:/repo:feature',
        repo: 'repo',
        checkout: '/repo',
        branch: 'feature',
        changedFileCount: 1,
        modules: [{ name: 'src', count: 1 }],
        changedFiles: ['src/a.ts'],
        overlaps: [],
        suggestion: 'Gộp qua merge-lane',
      }],
      branchAnalysisPending: false,
    });

    expect(store.getSnapshot().snapshot?.branchAnalysisPending).toBe(false);
    expect(store.getSnapshot().snapshot?.branchAnalyses?.[0]?.changedFiles).toEqual(['src/a.ts']);
  });
});

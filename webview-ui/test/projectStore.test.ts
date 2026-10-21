import { describe, expect, it } from 'vitest';

import type { ClientMessage, ServerMessage } from '../../core/src/messages.js';
import { createProjectStore } from '../src/company/projects/projectStore.js';

const snapshot = (requestId: string, name: string, partial = false): ServerMessage =>
  ({
    type: 'projectTreeSnapshot',
    requestId,
    nodes: [{ id: name, kind: 'project', name }],
    ...(partial ? { partial: true } : {}),
  }) as ServerMessage;

describe('project store tree snapshots', () => {
  it('takes the quick and the full snapshot of one request, and later pushes the server sends unasked', () => {
    const store = createProjectStore({ send: () => undefined, newRequestId: () => 'r1' });
    store.requestTree();
    store.accept(snapshot('r1', 'quick', true));
    expect(store.getSnapshot().treeComplete).toBe(false);
    store.accept(snapshot('r1', 'full'));
    expect(store.getSnapshot().nodes.map((node) => node.name)).toEqual(['full']);
    expect(store.getSnapshot().treeComplete).toBe(true);
    expect(store.getSnapshot().pending).toEqual({});
    store.accept(snapshot('project-tree-refresh', 'refreshed'));
    expect(store.getSnapshot().nodes.map((node) => node.name)).toEqual(['refreshed']);
  });

  it('keeps the full tree when a quick snapshot arrives after it, so repos never blink away', () => {
    const store = createProjectStore({ send: () => undefined });
    store.accept(snapshot('a', 'full'));
    store.accept(snapshot('b', 'quick', true));
    expect(store.getSnapshot().nodes.map((node) => node.name)).toEqual(['full']);
    expect(store.getSnapshot().treeComplete).toBe(true);
  });
});

describe('project store branch comparison', () => {
  it('sends comparisons, replaces the latest identical request and stores the matching result', () => {
    const sent: ClientMessage[] = [];
    let nextId = 0;
    const store = createProjectStore({
      send: (message) => sent.push(message),
      newRequestId: () => `compare-${++nextId}`,
    });
    const input = { repo: '/repo', branchA: 'feature-a', branchB: 'feature-b' };

    store.requestBranchCompare(input);
    store.requestBranchCompare(input);

    expect(sent).toEqual([
      { ...input, type: 'projectBranchCompareRequest', requestId: 'compare-1' },
      { ...input, type: 'projectBranchCompareRequest', requestId: 'compare-2' },
    ]);
    expect(Object.keys(store.getSnapshot().pending)).toEqual(['compare-2']);
    const result: ServerMessage = {
      type: 'projectBranchCompare',
      requestId: 'compare-2',
      ...input,
      a: { branch: 'feature-a', head: 'a', lastCommitAt: null, lastCommitSubject: null, dirtyFiles: [] },
      b: { branch: 'feature-b', head: 'b', lastCommitAt: null, lastCommitSubject: null, dirtyFiles: [] },
      mergeBase: null,
      onlyA: [],
      onlyB: [],
      commitsTruncated: false,
      files: [],
      mergeClean: true,
      conflicts: [],
    };
    store.accept(result);
    expect(store.getSnapshot().results['compare-2']).toEqual(result);
    expect(store.getSnapshot().pending).toEqual({});
  });
});

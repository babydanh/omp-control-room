import { describe, expect, it } from 'vitest';

import type { ServerMessage } from '../../core/src/messages.js';
import { createProjectStore } from '../src/company/projects/projectStore.js';
import { parseTreeCache } from '../src/company/projects/projectTreeCache.js';

const node = (id: string, kind: string) => ({ id, kind, name: id });
const snapshot = (requestId: string, nodes: object[], partial = false): ServerMessage =>
  ({ type: 'projectTreeSnapshot', requestId, nodes, ...(partial ? { partial: true } : {}) }) as ServerMessage;

describe('parseTreeCache', () => {
  it('reads a stored node list and drops anything without a string id and kind', () => {
    const raw = JSON.stringify([node('p', 'project'), { id: 7, kind: 'folder' }, null, { id: 'x' }]);
    expect(parseTreeCache(raw).map((entry) => entry.id)).toEqual(['p']);
  });

  it('answers an empty list for missing, broken or non-array storage', () => {
    expect(parseTreeCache(null)).toEqual([]);
    expect(parseTreeCache('{oops')).toEqual([]);
    expect(parseTreeCache('{"a":1}')).toEqual([]);
  });
});

describe('project store with a saved tree', () => {
  const saved = [node('proj', 'project'), node('repo', 'repository')] as never;

  it('shows the saved full tree at once and marks it stale until the real full tree arrives', () => {
    const store = createProjectStore({ send: () => undefined, restoreNodes: saved });
    expect(store.getSnapshot().nodes.map((entry) => entry.id)).toEqual(['proj', 'repo']);
    expect(store.getSnapshot().treeComplete).toBe(true);
    expect(store.getSnapshot().treeStale).toBe(true);
  });

  it('ignores the quick snapshot while stale, so the saved repos never blink away', () => {
    const store = createProjectStore({ send: () => undefined, restoreNodes: saved });
    store.accept(snapshot('r', [node('proj', 'project')], true));
    expect(store.getSnapshot().nodes.map((entry) => entry.id)).toEqual(['proj', 'repo']);
    expect(store.getSnapshot().treeStale).toBe(true);
  });

  it('replaces the saved tree with the full one, clears stale and saves it', () => {
    const writes: string[][] = [];
    const store = createProjectStore({ send: () => undefined, restoreNodes: saved, saveNodes: (nodes) => writes.push(nodes.map((entry) => entry.id)) });
    store.accept(snapshot('r', [node('proj', 'project'), node('repo2', 'repository')]));
    expect(store.getSnapshot().nodes.map((entry) => entry.id)).toEqual(['proj', 'repo2']);
    expect(store.getSnapshot().treeStale).toBe(false);
    expect(writes).toEqual([['proj', 'repo2']]);
  });

  it('never saves a quick snapshot', () => {
    const writes: string[][] = [];
    const store = createProjectStore({ send: () => undefined, saveNodes: (nodes) => writes.push(nodes.map((entry) => entry.id)) });
    store.accept(snapshot('r', [node('proj', 'project')], true));
    expect(writes).toEqual([]);
    expect(store.getSnapshot().treeStale).toBe(false);
  });

  it('starts empty and complete-less when nothing was saved', () => {
    const store = createProjectStore({ send: () => undefined, restoreNodes: [] });
    expect(store.getSnapshot()).toMatchObject({ nodes: [], treeComplete: false, treeStale: false });
  });
});

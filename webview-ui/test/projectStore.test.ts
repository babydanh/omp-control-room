import { describe, expect, it } from 'vitest';

import type { ServerMessage } from '../../core/src/messages.js';
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

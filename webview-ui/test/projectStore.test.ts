import { describe, expect, it } from 'vitest';

import type { ServerMessage } from '../../core/src/messages.js';
import { createProjectStore } from '../src/company/projects/projectStore.js';

const snapshot = (requestId: string, name: string): ServerMessage =>
  ({ type: 'projectTreeSnapshot', requestId, nodes: [{ id: name, kind: 'project', name }] }) as ServerMessage;

describe('project store tree snapshots', () => {
  it('takes the quick and the full snapshot of one request, and later pushes the server sends unasked', () => {
    const store = createProjectStore({ send: () => undefined, newRequestId: () => 'r1' });
    store.requestTree();
    store.accept(snapshot('r1', 'quick'));
    store.accept(snapshot('r1', 'full'));
    expect(store.getSnapshot().nodes.map((node) => node.name)).toEqual(['full']);
    expect(store.getSnapshot().pending).toEqual({});
    store.accept(snapshot('project-tree-refresh', 'refreshed'));
    expect(store.getSnapshot().nodes.map((node) => node.name)).toEqual(['refreshed']);
  });
});

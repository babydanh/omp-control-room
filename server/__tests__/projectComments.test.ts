import { describe, expect, it, vi } from 'vitest';

import type { ProjectCommentMessage, ProjectTreeNode } from '../../core/src/messages.js';
import { type ProjectCommentServices, sendProjectComment } from '../src/projects/comments.js';
import type { ProjectStore } from '../src/projects/projectStore.js';
import type { ProjectModuleDeps } from '../src/projects/services.js';

const checkout = 'V:/repo/worktree';
const session: ProjectTreeNode = { id: 'omp:session-1', parentId: checkout, kind: 'session', name: 'worker', sessionId: 'session-1', agentKind: 'omp', engine: 'omp', state: 'running' };
const request: ProjectCommentMessage = { type: 'projectComment', requestId: 'req', checkout, file: 'src/app.ts', line: 7, snippet: '7 const value = 1;', content: 'Please rename this.', receivingSessionId: 'session-1' };

function makeDeps(nodes: ProjectTreeNode[], services: ProjectCommentServices): ProjectModuleDeps<ProjectCommentServices> {
  return { store: {} as ProjectStore, loadTree: async () => ({ nodes }), services };
}

function services() {
  return { sendToBoardSession: vi.fn(async () => {}), sendToLedgerSession: vi.fn(async () => {}) };
}

describe('project diff comments', () => {
  it('refuses a recipient not attached to the selected checkout', async () => {
    const senders = services();
    const deps = makeDeps([{ id: checkout, kind: 'checkout', name: 'worktree', path: checkout } as ProjectTreeNode], senders);
    await expect(sendProjectComment(request, deps)).rejects.toThrow('không còn gắn với worktree');
    expect(senders.sendToLedgerSession).not.toHaveBeenCalled();
  });

  it('sends the anchored diff context and comment in the prescribed format', async () => {
    const senders = services();
    const deps = makeDeps([
      { id: checkout, kind: 'checkout', name: 'worktree', path: checkout } as ProjectTreeNode,
      session,
    ], senders);
    await sendProjectComment(request, deps);
    expect(senders.sendToLedgerSession).toHaveBeenCalledWith(
      'session-1',
      '[Nhận xét trên diff] src/app.ts:7\n7 const value = 1;\nNhận xét: Please rename this.',
    );
  });
});

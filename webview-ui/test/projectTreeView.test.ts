import { describe, expect, it } from 'vitest';

import type { ProjectTreeNode } from '../../core/src/messages.js';
import {
  buildAgentTree,
  canMoveProjectNode,
  countSessions,
  filterProjectTree,
  projectNodeMenuItems,
} from '../src/company/projects/projectTreeView.js';

const node = (id: string, kind: ProjectTreeNode['kind'], parentId?: string, extra: Partial<ProjectTreeNode> = {}): ProjectTreeNode => ({
  id,
  kind,
  name: id,
  ...(parentId === undefined ? {} : { parentId }),
  ...extra,
});

const nodes: ProjectTreeNode[] = [
  node('project', 'project'),
  node('group', 'group', 'project'),
  node('folder', 'folder', 'group'),
  node('repo', 'repository', 'folder'),
  node('checkout', 'checkout', 'repo', { branch: 'feature', overlap: true, path: '/work/repo/.worktrees/feature' }),
  node('file', 'file-agg', 'checkout'),
  node('session', 'session', 'checkout', { agentKind: 'claude', state: 'running' }),
  node('idle', 'session', 'checkout', { agentKind: 'omp', state: 'idle' }),
  node('empty', 'folder', 'project'),
  node('other', 'project'),
];

describe('projectTreeView', () => {
  it('shows sessions directly under their folder, with the branch they work on, and no git or file rows', () => {
    const roots = buildAgentTree(nodes);
    expect(roots.map((entry) => entry.node.id)).toEqual(['project', 'other']);
    const folder = roots[0]?.children[0]?.children[0];
    expect(folder?.node.id).toBe('folder');
    expect(folder?.children.map((child) => child.node.id)).toEqual(['session', 'idle']);
    expect(folder?.children[0]).toMatchObject({ where: 'feature', checkoutPath: '/work/repo/.worktrees/feature' });
    expect(countSessions(roots[0]!)).toEqual({ total: 2, running: 1 });
  });

  it('filters session rows only: folders stay so a new empty folder is always visible', () => {
    const claude = filterProjectTree(buildAgentTree(nodes), { agentKind: 'claude', liveOnly: false });
    expect(claude[0]?.children.map((child) => child.node.id)).toEqual(['group', 'empty']);
    expect(claude[0]?.children[0]?.children[0]?.children.map((child) => child.node.id)).toEqual(['session']);
    const agy = filterProjectTree(buildAgentTree(nodes), { agentKind: 'agy', liveOnly: false });
    expect(agy.map((entry) => entry.node.id)).toEqual(['project', 'other']);
    expect(agy[0]?.children[0]?.children[0]?.children).toEqual([]);
  });

  it('live filter hides idle sessions and keeps running ones and ones waiting on you', () => {
    const waiting = node('waiting', 'session', 'checkout', { agentKind: 'claude', state: 'waiting_input' });
    const live = filterProjectTree(buildAgentTree([...nodes, waiting]), { agentKind: 'all', liveOnly: true });
    expect(live[0]?.children[0]?.children[0]?.children.map((child) => child.node.id)).toEqual(['session', 'waiting']);
  });

  it('provides menu actions for each node category', () => {
    expect(projectNodeMenuItems(nodes[0]!).map((item) => item.action.kind === 'projectNodeAction' ? item.action.action : '')).toContain('delete');
    expect(projectNodeMenuItems(nodes[1]!).map((item) => item.label)).toContain('Tạo nhóm con…');
    expect(projectNodeMenuItems(nodes[2]!).map((item) => item.action.kind === 'projectNodeAction' ? item.action.action : '')).toContain('removeFolder');
    expect(projectNodeMenuItems(nodes[3]!).map((item) => item.label)).toContain('Thử gộp với…');
    expect(projectNodeMenuItems(nodes[4]!).map((item) => item.action.kind === 'projectNodeAction' ? item.action.action : '')).toContain('copyBranch');
  });

  it('rejects drag destinations inside the dragged node subtree', () => {
    expect(canMoveProjectNode(nodes, 'group', 'folder')).toBe(false);
    expect(canMoveProjectNode(nodes, 'group', 'group')).toBe(false);
    expect(canMoveProjectNode(nodes, 'group', 'other')).toBe(true);
  });
});

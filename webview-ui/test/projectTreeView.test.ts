import { describe, expect, it } from 'vitest';

import type { ProjectTreeNode } from '../../core/src/messages.js';
import { buildProjectTree, canMoveProjectNode, filterProjectTree, projectNodeMenuItems } from '../src/company/projects/projectTreeView.js';

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
  node('checkout', 'checkout', 'repo', { branch: 'feature', overlap: true }),
  node('session', 'session', 'checkout', { agentKind: 'claude', state: 'running' }),
  node('other', 'project'),
];

describe('projectTreeView', () => {
  it('builds nested display branches from parent-linked flat nodes', () => {
    const roots = buildProjectTree(nodes);
    expect(roots.map((entry) => entry.node.id)).toEqual(['project', 'other']);
    expect(roots[0]?.children[0]?.children[0]?.children[0]?.children[0]?.children[0]?.node.id).toBe('session');
  });

  it('filters by tool and preserves matching ancestors', () => {
    const filtered = filterProjectTree(buildProjectTree(nodes), {
      agentKind: 'claude',
      overlapOnly: false,
      runningOnly: false,
    });
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.children[0]?.children[0]?.children[0]?.children[0]?.children[0]?.node.id).toBe('session');
    expect(filterProjectTree(buildProjectTree(nodes), { agentKind: 'omp', overlapOnly: false, runningOnly: false })).toEqual([]);
  });

  it('filters overlap and running state while keeping ancestors', () => {
    const filtered = filterProjectTree(buildProjectTree(nodes), { agentKind: 'all', overlapOnly: true, runningOnly: false });
    expect(filtered[0]?.children[0]?.children[0]?.children[0]?.children[0]?.node.id).toBe('checkout');
    expect(filterProjectTree(buildProjectTree(nodes), { agentKind: 'all', overlapOnly: false, runningOnly: true })).toHaveLength(1);
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

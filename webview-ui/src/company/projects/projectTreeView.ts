import type { ProjectTreeNode } from '../../../../core/src/messages.js';
export { projectNodeMenuItems } from '../agentMenu.js';

export interface ProjectTreeBranch {
  node: ProjectTreeNode;
  children: ProjectTreeBranch[];
}

export function buildProjectTree(nodes: readonly ProjectTreeNode[]): ProjectTreeBranch[] {
  const branches = new Map<string, ProjectTreeBranch>();
  const roots: ProjectTreeBranch[] = [];
  for (const node of nodes) branches.set(node.id, { node, children: [] });
  for (const branch of branches.values()) {
    const parent = branch.node.parentId === undefined ? undefined : branches.get(branch.node.parentId);
    if (parent === undefined) roots.push(branch);
    else parent.children.push(branch);
  }
  return roots;
}

export interface ProjectTreeFilters {
  agentKind: ProjectTreeNode['agentKind'] | 'all';
  overlapOnly: boolean;
  runningOnly: boolean;
}

export function filterProjectTree(
  roots: readonly ProjectTreeBranch[],
  filters: ProjectTreeFilters,
): ProjectTreeBranch[] {
  const filterBranch = (branch: ProjectTreeBranch): ProjectTreeBranch | null => {
    const children = branch.children.map(filterBranch).filter((child): child is ProjectTreeBranch => child !== null);
    const { node } = branch;
    const matched =
      (filters.agentKind === 'all' || node.agentKind === filters.agentKind || children.length > 0) &&
      (!filters.overlapOnly || node.overlap === true || children.length > 0) &&
      (!filters.runningOnly || isRunningNode(node) || children.length > 0);
    if (!matched) return null;
    return { node, children };
  };
  return roots.map(filterBranch).filter((branch): branch is ProjectTreeBranch => branch !== null);
}

function isRunningNode(node: ProjectTreeNode): boolean {
  return node.kind === 'session' && (node.state === 'running' || node.state === 'busy' || node.state === 'active');
}


export function canMoveProjectNode(nodes: readonly ProjectTreeNode[], nodeId: string, targetId: string): boolean {
  if (nodeId === targetId) return false;
  const children = new Map<string, string[]>();
  for (const node of nodes) {
    if (node.parentId === undefined) continue;
    const siblings = children.get(node.parentId) ?? [];
    siblings.push(node.id);
    children.set(node.parentId, siblings);
  }
  const descendants = new Set<string>();
  const pending = [nodeId];
  while (pending.length > 0) {
    const id = pending.pop();
    if (id === undefined || descendants.has(id)) continue;
    descendants.add(id);
    pending.push(...(children.get(id) ?? []));
  }
  return !descendants.has(targetId);
}

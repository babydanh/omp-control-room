import type { ProjectTreeNode } from '../../../../core/src/messages.js';
import type { ProjectNodeAction, ProjectNodeMenuContext } from '../agentMenu.js';

export type ProjectSessionEngine = 'omp' | 'claude' | 'agy';

/** The nearest ancestor of `node` of the given kind, if any. */
export function ancestorOf(
  nodes: readonly ProjectTreeNode[],
  node: ProjectTreeNode,
  kind: ProjectTreeNode['kind'],
): ProjectTreeNode | undefined {
  let cursor = node.parentId === undefined ? undefined : nodes.find((candidate) => candidate.id === node.parentId);
  while (cursor !== undefined && cursor.kind !== kind) {
    const parentId = cursor.parentId;
    cursor = parentId === undefined ? undefined : nodes.find((candidate) => candidate.id === parentId);
  }
  return cursor;
}

function descendants(nodes: readonly ProjectTreeNode[], node: ProjectTreeNode): ProjectTreeNode[] {
  const children = new Map<string, ProjectTreeNode[]>();
  for (const candidate of nodes) {
    if (candidate.parentId === undefined) continue;
    const list = children.get(candidate.parentId);
    if (list === undefined) children.set(candidate.parentId, [candidate]);
    else list.push(candidate);
  }
  const found: ProjectTreeNode[] = [];
  const queue = [...(children.get(node.id) ?? [])];
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    found.push(next);
    queue.push(...(children.get(next.id) ?? []));
  }
  return found;
}

/**
 * The checkout a "changes" action on `node` opens: the node itself when it is a
 * checkout; for a session, the checkout it works in, else the one it last edited
 * (a session at a folder's root works across repos); otherwise the first checkout
 * below it (a repository's main worktree is listed first). Null when there is none.
 */
export function checkoutPathFor(
  nodes: readonly ProjectTreeNode[],
  node: ProjectTreeNode,
): string | null {
  if (node.kind === 'checkout') return node.path ?? null;
  if (node.kind === 'session') return ancestorOf(nodes, node, 'checkout')?.path ?? node.editCheckout ?? null;
  return descendants(nodes, node).find((candidate) => candidate.kind === 'checkout' && candidate.path !== undefined)?.path ?? null;
}

/** Folders under a Project or group: the ones "Phiên mới…" lets you pick. */
export function foldersUnder(nodes: readonly ProjectTreeNode[], node: ProjectTreeNode): ProjectTreeNode[] {
  if (node.kind === 'folder') return [node];
  return descendants(nodes, node).filter((candidate) => candidate.kind === 'folder');
}

/** What the right-click menu of `node` can offer. */
export function projectMenuContext(nodes: readonly ProjectTreeNode[], node: ProjectTreeNode): ProjectNodeMenuContext {
  return {
    hasCheckout: checkoutPathFor(nodes, node) !== null,
    folderCount: foldersUnder(nodes, node).length,
  };
}

/** Engine preselected by a "new session" menu action; undefined lets the dialog decide. */
export function engineForAction(action: ProjectNodeAction): ProjectSessionEngine | undefined {
  if (action === 'newSessionOmp') return 'omp';
  if (action === 'newSessionClaude') return 'claude';
  if (action === 'newSessionAgy') return 'agy';
  return undefined;
}

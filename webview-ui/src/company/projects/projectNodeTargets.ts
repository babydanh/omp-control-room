import type { ProjectTreeNode } from '../../../../core/src/messages.js';
import type { ProjectNodeAction } from '../agentMenu.js';

export type ProjectSessionEngine = 'omp' | 'claude' | 'agy';

/**
 * The checkout a "changes" action on `node` opens: the node itself when it is a
 * checkout, otherwise its first checkout descendant (a repository's main
 * worktree is listed first). Null when the subtree holds no checkout.
 */
export function checkoutPathFor(
  nodes: readonly ProjectTreeNode[],
  node: ProjectTreeNode,
): string | null {
  if (node.kind === 'checkout') return node.path ?? null;
  const children = new Map<string, ProjectTreeNode[]>();
  for (const candidate of nodes) {
    if (candidate.parentId === undefined) continue;
    const list = children.get(candidate.parentId);
    if (list === undefined) children.set(candidate.parentId, [candidate]);
    else list.push(candidate);
  }
  const queue = [...(children.get(node.id) ?? [])];
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    if (next.kind === 'checkout' && next.path !== undefined) return next.path;
    queue.push(...(children.get(next.id) ?? []));
  }
  return null;
}

/** Engine preselected by a "new session" menu action; undefined lets the dialog decide. */
export function engineForAction(action: ProjectNodeAction): ProjectSessionEngine | undefined {
  if (action === 'newSessionOmp') return 'omp';
  if (action === 'newSessionClaude') return 'claude';
  if (action === 'newSessionAgy') return 'agy';
  return undefined;
}

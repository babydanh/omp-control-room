import type { ProjectSessionEngine } from '../../../../core/src/agentEngines.js';
import type { ProjectTreeNode } from '../../../../core/src/messages.js';
import type { ProjectNodeAction, ProjectNodeMenuContext } from '../agentMenu.js';

export type { ProjectSessionEngine } from '../../../../core/src/agentEngines.js';

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
 * checkout; for a session, the first with uncommitted lines among the checkouts it
 * edited (newest first) and the one it works in, else the one it works in, else the
 * one it edited last (a session at a folder's root works across repos); otherwise the
 * first checkout below it (a repository's main worktree is listed first). Null when
 * there is none.
 */
export function checkoutPathFor(
  nodes: readonly ProjectTreeNode[],
  node: ProjectTreeNode,
): string | null {
  if (node.kind === 'checkout') return node.path ?? null;
  if (node.kind === 'session') {
    const own = ancestorOf(nodes, node, 'checkout')?.path;
    const edited = node.editCheckouts ?? [];
    const changes = checkoutChangesByPath(nodes);
    const busy = [...edited, ...(own === undefined ? [] : [own])].find((path) => {
      const counts = changesAt(changes, path);
      return counts !== null && counts.additions + counts.deletions > 0;
    });
    return busy ?? own ?? edited[0] ?? null;
  }
  return descendants(nodes, node).find((candidate) => candidate.kind === 'checkout' && candidate.path !== undefined)?.path ?? null;
}

/** A path compared case-, separator- and trailing-slash-blind, as Windows paths are. */
function pathKey(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/**
 * Lines each checkout in the tree adds and removes, keyed for `changesAt`. Only the
 * full snapshot carries them; the quick one has no checkouts yet.
 */
export function checkoutChangesByPath(
  nodes: readonly ProjectTreeNode[],
): ReadonlyMap<string, { additions: number; deletions: number }> {
  const changes = new Map<string, { additions: number; deletions: number }>();
  for (const node of nodes) {
    if (node.kind !== 'checkout' || node.path === undefined) continue;
    changes.set(pathKey(node.path), { additions: node.additions ?? 0, deletions: node.deletions ?? 0 });
  }
  return changes;
}

/** The lines this one session added and removed (not its checkout's total); null when it has none. */
export function sessionChanges(node: ProjectTreeNode | undefined): { additions: number; deletions: number } | null {
  const additions = node?.additions ?? 0;
  const deletions = node?.deletions ?? 0;
  return additions + deletions > 0 ? { additions, deletions } : null;
}

/** The changes `checkoutChangesByPath` holds for `path`; null when the tree does not hold it. */
export function changesAt(
  changes: ReadonlyMap<string, { additions: number; deletions: number }>,
  path: string,
): { additions: number; deletions: number } | null {
  return changes.get(pathKey(path)) ?? null;
}

/**
 * The checkout each herdr pane works in, from the session the tree joined to it: a
 * pane's own cwd is where its shell started (often a folder holding several repos),
 * while the session knows the checkout it works in or last edited.
 */
export function paneCheckouts(nodes: readonly ProjectTreeNode[]): ReadonlyMap<string, string> {
  const checkouts = new Map<string, string>();
  for (const node of nodes) {
    if (node.kind !== 'session' || node.herdrPaneId === undefined) continue;
    const checkout = checkoutPathFor(nodes, node);
    if (checkout !== null) checkouts.set(node.herdrPaneId, checkout);
  }
  return checkouts;
}

/** Folders under a Project or group: the ones "Phiên mới…" lets you pick. */
export function foldersUnder(nodes: readonly ProjectTreeNode[], node: ProjectTreeNode): ProjectTreeNode[] {
  if (node.kind === 'folder') return [node];
  return descendants(nodes, node).filter((candidate) => candidate.kind === 'folder');
}

/** What the right-click menu of `node` can offer. */
export function projectMenuContext(nodes: readonly ProjectTreeNode[], node: ProjectTreeNode, cloud = false): ProjectNodeMenuContext {
  return {
    hasCheckout: checkoutPathFor(nodes, node) !== null,
    folderCount: foldersUnder(nodes, node).length,
    ...(cloud ? { cloud } : {}),
  };
}

/** Agent a "cloud session" menu action starts; undefined for every other action. */
export function cloudEngineForAction(action: ProjectNodeAction): 'claude' | 'omp' | undefined {
  if (action === 'newCloudClaude') return 'claude';
  if (action === 'newCloudOmp') return 'omp';
  return undefined;
}

/** Engine preselected by a "new session" menu action; undefined lets the dialog decide. */
export function engineForAction(action: ProjectNodeAction): ProjectSessionEngine | undefined {
  if (action === 'newSessionOmp') return 'omp';
  if (action === 'newSessionClaude') return 'claude';
  if (action === 'newSessionAgy') return 'agy';
  if (action === 'newSessionCodex') return 'codex';
  if (action === 'newSessionPi') return 'pi';
  if (action === 'newSessionThinkRail') return 'thinkrail';
  return undefined;
}

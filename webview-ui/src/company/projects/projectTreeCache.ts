import type { ProjectTreeNode } from '../../../../core/src/messages.js';

/** The last full Project tree, kept in this browser so a reload shows repos at once instead of the quick folder-only tree. */
export const PROJECT_TREE_CACHE_KEY = 'omp.company.projectTree';

export function parseTreeCache(raw: string | null): ProjectTreeNode[] {
  if (raw === null) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value.filter((entry): entry is ProjectTreeNode => typeof entry?.id === 'string' && typeof entry.kind === 'string' && typeof entry.name === 'string');
  } catch {
    return [];
  }
}

/** Text a user typed or an agent answered: it stays on the server, never in this browser's storage. */
const PRIVATE_FIELDS = ['request', 'lastRequest', 'recentRequests', 'lastReply', 'title', 'interrupted', 'progress'] as const;

export function storedTreeNodes(nodes: readonly ProjectTreeNode[]): ProjectTreeNode[] {
  return nodes.map((node) => {
    const kept: Partial<ProjectTreeNode> = { ...node };
    for (const field of PRIVATE_FIELDS) delete kept[field];
    return kept as ProjectTreeNode;
  });
}

export function readTreeCache(): ProjectTreeNode[] {
  try {
    return parseTreeCache(window.localStorage.getItem(PROJECT_TREE_CACHE_KEY));
  } catch {
    return [];
  }
}

let lastWritten = '';

export function writeTreeCache(nodes: readonly ProjectTreeNode[]): void {
  const json = JSON.stringify(storedTreeNodes(nodes));
  // The server pushes a full tree every few seconds: write only when it changed.
  if (json === lastWritten) return;
  try {
    window.localStorage.setItem(PROJECT_TREE_CACHE_KEY, json);
    lastWritten = json;
  } catch {
    // Storage is optional and may be full: the tree then simply loads fresh next time.
  }
}

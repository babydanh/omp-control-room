import type { ProjectTreeNode } from '../../../../core/src/messages.js';

/** The last full Project tree, kept in this browser so a reload shows repos at once instead of the quick folder-only tree. */
export const PROJECT_TREE_CACHE_KEY = 'omp.company.projectTree';

export function parseTreeCache(raw: string | null): ProjectTreeNode[] {
  if (raw === null) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value.filter((entry): entry is ProjectTreeNode => typeof entry?.id === 'string' && typeof entry.kind === 'string');
  } catch {
    return [];
  }
}

export function readTreeCache(): ProjectTreeNode[] {
  try {
    return parseTreeCache(window.localStorage.getItem(PROJECT_TREE_CACHE_KEY));
  } catch {
    return [];
  }
}

export function writeTreeCache(nodes: readonly ProjectTreeNode[]): void {
  try {
    window.localStorage.setItem(PROJECT_TREE_CACHE_KEY, JSON.stringify(nodes));
  } catch {
    // Storage is optional and may be full: the tree then simply loads fresh next time.
  }
}

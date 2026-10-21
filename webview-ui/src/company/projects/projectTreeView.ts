import type { ProjectTreeNode } from '../../../../core/src/messages.js';
import type { ActivityCounts } from '../agentSidebarView.js';
export { projectNodeMenuItems } from '../agentMenu.js';

export interface ProjectTreeBranch {
  node: ProjectTreeNode;
  children: ProjectTreeBranch[];
  /** Session rows: the branch (or worktree name) the session works on. */
  where?: string;
  /** Session rows: the checkout the session works in, for its changes. */
  checkoutPath?: string;
  /** Session rows: the Project folder the session works under. */
  folderPath?: string;
}

const STRUCTURE_KINDS: ReadonlySet<ProjectTreeNode['kind']> = new Set(['project', 'group', 'folder']);

/**
 * The sidebar's tree: Project → groups → folders → the sessions working there.
 * Repos, worktrees and files are not rows: each session is lifted to its nearest
 * folder and keeps its branch as a label. The git and file tree lives on the
 * Thay đổi and Cây git pages.
 */
export function buildAgentTree(nodes: readonly ProjectTreeNode[]): ProjectTreeBranch[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const branches = new Map<string, ProjectTreeBranch>();
  const roots: ProjectTreeBranch[] = [];
  for (const node of nodes) {
    if (STRUCTURE_KINDS.has(node.kind)) branches.set(node.id, { node, children: [] });
  }
  for (const node of nodes) {
    const own = branches.get(node.id);
    if (own !== undefined) {
      const parent = node.parentId === undefined ? undefined : branches.get(node.parentId);
      if (parent === undefined) roots.push(own);
      else parent.children.push(own);
      continue;
    }
    if (node.kind !== 'session') continue;
    let checkout: ProjectTreeNode | undefined;
    let cursor = node.parentId === undefined ? undefined : byId.get(node.parentId);
    while (cursor !== undefined && !STRUCTURE_KINDS.has(cursor.kind)) {
      if (cursor.kind === 'checkout') checkout ??= cursor;
      cursor = cursor.parentId === undefined ? undefined : byId.get(cursor.parentId);
    }
    const folder = cursor === undefined ? undefined : branches.get(cursor.id);
    if (folder === undefined) continue;
    // The quick snapshot has no checkouts: the session's own folder name stands in for its branch.
    const where = checkout?.branch ?? checkout?.name ?? lastPathSegment(node.path);
    folder.children.push({
      node,
      children: [],
      ...(where === undefined ? {} : { where }),
      ...(checkout?.path === undefined ? {} : { checkoutPath: checkout.path }),
      ...(folder.node.path === undefined ? {} : { folderPath: folder.node.path }),
    });
  }
  return roots;
}

function lastPathSegment(value: string | undefined): string | undefined {
  return value?.split(/[\\/]/).filter((part) => part !== '').pop();
}

export interface ProjectTreeFilters {
  agentKind: ProjectTreeNode['agentKind'] | 'all';
  /** Hide idle and ended sessions; running ones and ones waiting on you stay. */
  liveOnly: boolean;
}

/** Filters session rows only: Projects, groups and folders always stay, so a new empty folder is visible. */
export function filterProjectTree(
  roots: readonly ProjectTreeBranch[],
  filters: ProjectTreeFilters,
): ProjectTreeBranch[] {
  const filterBranch = (branch: ProjectTreeBranch): ProjectTreeBranch | null => {
    if (branch.node.kind !== 'session') {
      const children = branch.children.map(filterBranch).filter((child): child is ProjectTreeBranch => child !== null);
      return { ...branch, children };
    }
    const matched =
      (filters.agentKind === 'all' || branch.node.agentKind === filters.agentKind) &&
      (!filters.liveOnly || isLiveNode(branch.node));
    return matched ? branch : null;
  };
  return roots.map(filterBranch).filter((branch): branch is ProjectTreeBranch => branch !== null);
}

/** Sessions in a branch, at any depth: the count a folder row shows. */
export function countSessions(branch: ProjectTreeBranch): { total: number; running: number } {
  if (branch.node.kind === 'session') return { total: 1, running: isRunningNode(branch.node) ? 1 : 0 };
  return branch.children.reduce(
    (sum, child) => {
      const counts = countSessions(child);
      return { total: sum.total + counts.total, running: sum.running + counts.running };
    },
    { total: 0, running: 0 },
  );
}

const RUNNING_STATES: ReadonlySet<string> = new Set(['running', 'busy', 'active', 'working']);
const WAITING_ON_YOU_STATES: ReadonlySet<string> = new Set(['waiting_input', 'blocked', 'permission']);

export function isRunningNode(node: ProjectTreeNode): boolean {
  return node.kind === 'session' && RUNNING_STATES.has((node.state ?? '').toLowerCase());
}

/** A session worth showing by default: working now, or stopped waiting for you. */
export function isLiveNode(node: ProjectTreeNode): boolean {
  return isRunningNode(node) || (node.kind === 'session' && WAITING_ON_YOU_STATES.has((node.state ?? '').toLowerCase()));
}

/** The heading's counts, over each session once even when two Projects hold its folder; hibernated ones are not agents. */
export function sessionActivityCounts(nodes: readonly ProjectTreeNode[]): ActivityCounts & { total: number } {
  const counts = { total: 0, working: 0, needs: 0, idle: 0, error: 0 };
  const seen = new Set<string>();
  for (const node of nodes) {
    if (node.kind !== 'session' || node.state === 'sleeping') continue;
    const key = node.sessionId ?? node.id;
    if (seen.has(key)) continue;
    seen.add(key);
    counts.total += 1;
    const state = (node.state ?? '').toLowerCase();
    if (RUNNING_STATES.has(state)) counts.working += 1;
    else if (WAITING_ON_YOU_STATES.has(state)) counts.needs += 1;
    else if (state === 'error') counts.error += 1;
    else counts.idle += 1;
  }
  return counts;
}

/** A herdr pane no Project folder holds: listed below the tree so it stays reachable. */
export interface OutsideHerdrRow {
  paneId: string;
  title: string;
  /** The folder it works in, last segment; empty when herdr does not say. */
  where: string;
  status: string;
  sleeping: boolean;
}

/** Herdr panes and hibernated sessions the Project tree does not show, live ones first. */
export function herdrOutsideProjects(
  nodes: readonly ProjectTreeNode[],
  roster: {
    readonly agents: readonly { paneId: string; status: string; title?: string; name?: string; cwd?: string }[];
    readonly sleeping: readonly { paneId: string; title: string; cwd?: string }[];
  },
): OutsideHerdrRow[] {
  const shown = new Set(
    nodes.flatMap((node) => (node.kind === 'session' && node.agentKind === 'herdr' && node.sessionId !== undefined ? [node.sessionId] : [])),
  );
  const where = (cwd: string | undefined) => lastPathSegment(cwd) ?? cwd ?? '';
  return [
    ...roster.agents
      .filter((agent) => !shown.has(agent.paneId))
      .map((agent) => ({
        paneId: agent.paneId,
        title: agent.title || agent.name || agent.paneId,
        where: where(agent.cwd),
        status: agent.status,
        sleeping: false,
      })),
    ...roster.sleeping
      .filter((session) => !shown.has(session.paneId))
      .map((session) => ({
        paneId: session.paneId,
        title: session.title || session.paneId,
        where: where(session.cwd),
        status: 'sleeping',
        sleeping: true,
      })),
  ];
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

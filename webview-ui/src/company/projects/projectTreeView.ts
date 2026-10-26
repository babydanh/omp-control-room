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

const SESSION_LABEL_MAX = 40;
const UUID_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A session row's name: its own name, or the first request when the name is just the session id. */
export function sessionDisplayName(node: ProjectTreeNode): string {
  const unnamed = node.name === node.sessionId || UUID_NAME.test(node.name);
  const request = node.request?.trim().replace(/\s+/g, ' ');
  if (!unnamed || request === undefined || request === '') return node.name;
  return request.length > SESSION_LABEL_MAX ? `${request.slice(0, SESSION_LABEL_MAX - 1)}…` : request;
}

/** The one-line "what it is doing" under a session's name: the newest user message, else the first request. */
export function sessionSummary(node: ProjectTreeNode): string | undefined {
  const text = (node.lastRequest ?? node.request)?.trim().replace(/\s+/g, ' ');
  if (text === undefined || text === '' || text === sessionDisplayName(node)) return undefined;
  return text;
}

/**
 * The sidebar's tree: Project → groups → folders → repos → the sessions working
 * there, each subagent under the session that spawned it. A folder that holds
 * several repos gets one heading per repo; a folder that is itself the repo, and the
 * quick snapshot (which has no repos yet), list sessions straight under the folder.
 * Worktrees and files are not rows: each session keeps its branch as a label. The
 * git and file tree lives on the Thay đổi and Cây git pages.
 */
export function buildAgentTree(nodes: readonly ProjectTreeNode[]): ProjectTreeBranch[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const branches = new Map<string, ProjectTreeBranch>();
  const roots: ProjectTreeBranch[] = [];
  for (const node of nodes) {
    if (STRUCTURE_KINDS.has(node.kind)) branches.set(node.id, { node, children: [] });
  }
  const repoHeadings = new Map<string, ProjectTreeBranch>();
  const sessionRows = new Map<string, ProjectTreeBranch>();
  const spawned: { row: ProjectTreeBranch; home: ProjectTreeBranch; key: string }[] = [];
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
    let repo: ProjectTreeNode | undefined;
    let cursor = node.parentId === undefined ? undefined : byId.get(node.parentId);
    while (cursor !== undefined && !STRUCTURE_KINDS.has(cursor.kind)) {
      if (cursor.kind === 'checkout') checkout ??= cursor;
      if (cursor.kind === 'repository') repo ??= cursor;
      cursor = cursor.parentId === undefined ? undefined : byId.get(cursor.parentId);
    }
    const folder = cursor === undefined ? undefined : branches.get(cursor.id);
    if (folder === undefined) continue;
    const home = repo === undefined || samePath(repo.path, folder.node.path) ? folder : repoHeading(folder, repo);
    // The quick snapshot has no checkouts: the session's own folder name stands in for its branch,
    // unless that is just the folder the row sits under.
    const ownFolder = lastPathSegment(node.path);
    const where = checkout?.branch ?? checkout?.name ?? (ownFolder === lastPathSegment(folder.node.path) ? undefined : ownFolder);
    // A session at the folder's root has no checkout of its own: its changes are where it edits.
    const checkoutPath = checkout?.path ?? node.editCheckouts?.[0];
    const row: ProjectTreeBranch = {
      node,
      children: [],
      ...(where === undefined ? {} : { where }),
      ...(checkoutPath === undefined ? {} : { checkoutPath }),
      ...(folder.node.path === undefined ? {} : { folderPath: folder.node.path }),
    };
    // Keyed per folder: two Projects holding one folder each nest their own copy.
    if (node.sessionId !== undefined) sessionRows.set(`${folder.node.id}:${node.sessionId}`, row);
    if (node.parentSessionId === undefined) home.children.push(row);
    else spawned.push({ row, home, key: `${folder.node.id}:${node.parentSessionId}` });
  }
  // A subagent whose parent the tree does not hold stays where it works.
  for (const { row, home, key } of spawned) (sessionRows.get(key) ?? home).children.push(row);
  for (const branch of branches.values()) {
    if (branch.node.kind === 'folder') branch.children.sort(sessionsBeforeRepos);
  }
  return roots;

  function repoHeading(folder: ProjectTreeBranch, repo: ProjectTreeNode): ProjectTreeBranch {
    const key = `${folder.node.id}:${repo.id}`;
    const existing = repoHeadings.get(key);
    if (existing !== undefined) return existing;
    const heading: ProjectTreeBranch = { node: repo, children: [] };
    repoHeadings.set(key, heading);
    folder.children.push(heading);
    return heading;
  }
}

/** A folder lists its own sessions first, then its repos by name. */
function sessionsBeforeRepos(a: ProjectTreeBranch, b: ProjectTreeBranch): number {
  const rank = (branch: ProjectTreeBranch) => (branch.node.kind === 'repository' ? 1 : 0);
  return rank(a) - rank(b) || (rank(a) === 1 ? a.node.name.localeCompare(b.node.name) : 0);
}

function samePath(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined) return false;
  const normal = (value: string) => value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return normal(a) === normal(b);
}

function lastPathSegment(value: string | undefined): string | undefined {
  return value?.split(/[\\/]/).filter((part) => part !== '').pop();
}

export interface ProjectTreeFilters {
  agentKind: ProjectTreeNode['agentKind'] | 'all';
  /** Hide idle and ended sessions; running ones and ones waiting on you stay. */
  liveOnly: boolean;
  /** The session the drawer shows: kept whatever the filters say, so its row can be pointed at. */
  keep?: TreeSelection;
}

/**
 * Filters session rows only: Projects, groups and folders always stay, so a new empty
 * folder is visible; a repo heading goes when none of its sessions is left. A session
 * stays when it matches or when one of its subagents does, so a subagent is never
 * shown without the session that spawned it.
 */
export function filterProjectTree(
  roots: readonly ProjectTreeBranch[],
  filters: ProjectTreeFilters,
): ProjectTreeBranch[] {
  const filterBranch = (branch: ProjectTreeBranch): ProjectTreeBranch | null => {
    const children = branch.children.map(filterBranch).filter((child): child is ProjectTreeBranch => child !== null);
    if (branch.node.kind === 'repository') return children.length > 0 ? { ...branch, children } : null;
    if (branch.node.kind !== 'session') return { ...branch, children };
    const matched =
      (filters.keep !== undefined && isSelectedSession(branch.node, filters.keep)) ||
      ((filters.agentKind === 'all' || branch.node.agentKind === filters.agentKind) &&
        (!filters.liveOnly || isLiveNode(branch.node)));
    return matched || children.length > 0 ? { ...branch, children } : null;
  };
  return roots.map(filterBranch).filter((branch): branch is ProjectTreeBranch => branch !== null);
}

/** Sessions in a branch, at any depth and subagents included: the count a folder row shows. */
export function countSessions(branch: ProjectTreeBranch): { total: number; running: number } {
  const own = branch.node.kind === 'session' ? { total: 1, running: isRunningNode(branch.node) ? 1 : 0 } : { total: 0, running: 0 };
  return branch.children.reduce(
    (sum, child) => {
      const counts = countSessions(child);
      return { total: sum.total + counts.total, running: sum.running + counts.running };
    },
    own,
  );
}

const RUNNING_STATES: ReadonlySet<string> = new Set(['running', 'busy', 'active', 'working']);
const WAITING_ON_YOU_STATES: ReadonlySet<string> = new Set(['waiting_input', 'blocked', 'permission']);

/** A session row's todo progress as the sidebar shows it: "3/7 · 43%", the task in hand, and why it is stuck. */
export interface SessionProgressView {
  readonly percent: number;
  readonly label: string;
  readonly current?: string;
  readonly blocked?: string;
}

export function sessionProgressView(progress: ProjectTreeNode['progress']): SessionProgressView | null {
  if (progress === undefined || progress.total <= 0) return null;
  const percent = Math.round((Math.min(progress.done, progress.total) / progress.total) * 100);
  return {
    percent,
    label: `${progress.done}/${progress.total} · ${percent}%`,
    ...(progress.current === undefined ? {} : { current: progress.current }),
    ...(progress.blocked === undefined ? {} : { blocked: progress.blocked }),
  };
}

export function isRunningNode(node: ProjectTreeNode): boolean {
  return node.kind === 'session' && RUNNING_STATES.has((node.state ?? '').toLowerCase());
}

/**
 * The feeling a session's face shows, from its real state: asleep (eyes shut, a drifting "z"),
 * at work (eyes glancing), waiting on you (eyes wide, a little hop), in error (dizzy "× ×", a
 * shiver), done (happy "^ ^", a hop and a sparkle) or at rest (a slow blink).
 */
export type SessionFaceMood = 'sleep' | 'work' | 'waiting' | 'error' | 'done' | 'idle';

/**
 * The face actually drawn. The cheer only ever stands in for rest: a session that falls asleep,
 * errs, waits on you or starts working again shows that at once, cheer or not.
 */
export function shownFaceMood(mood: SessionFaceMood, cheering: boolean): SessionFaceMood {
  return cheering && (mood === 'idle' || mood === 'done') ? 'done' : mood;
}

export function sessionFaceMood(node: ProjectTreeNode): SessionFaceMood {
  const state = (node.state ?? '').toLowerCase();
  if (state === 'sleeping') return 'sleep';
  if (isRunningNode(node)) return 'work';
  if (state === 'error') return 'error';
  if (state === 'done') return 'done';
  return waitsOnYou(node) ? 'waiting' : 'idle';
}

/** How long the happy face shows after a session finishes a turn. */
export const SESSION_FACE_CHEER_MS = 3200;

/** A session that was working and now rests has just finished a turn: the face cheers for a moment. */
export function finishedTurn(previous: SessionFaceMood, next: SessionFaceMood): boolean {
  return previous === 'work' && (next === 'idle' || next === 'done');
}

/**
 * A steady hue per session, so a face keeps its colour across renders and reloads: identity, not
 * status. Red (330°–30°) is left out, so a busy session never reads as one in error.
 */
export function sessionFaceHue(id: string): number {
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) hash = (hash * 31 + id.charCodeAt(index)) >>> 0;
  return 30 + (hash % 300);
}

/** The session or herdr pane the detail drawer shows, so the tree can point at its row. */
export interface TreeSelection {
  readonly sessionId: string | null;
  readonly paneId: string | null;
}

/** True when this tree row is the session the drawer shows, by its pane or its board/native id. */
export function isSelectedSession(node: ProjectTreeNode, selection: TreeSelection): boolean {
  if (node.kind !== 'session') return false;
  const pane = node.herdrPaneId ?? (node.agentKind === 'herdr' ? node.sessionId : undefined);
  if (selection.paneId !== null && pane === selection.paneId) return true;
  return selection.sessionId !== null && (node.boardSessionId === selection.sessionId || node.sessionId === selection.sessionId);
}

/** The rows above the session the drawer shows, which must be expanded for its row to appear. */
export function selectedAncestorIds(nodes: readonly ProjectTreeNode[], selection: TreeSelection): string[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const ids: string[] = [];
  for (const node of nodes) {
    if (!isSelectedSession(node, selection)) continue;
    for (let parent = node.parentId; parent !== undefined; parent = byId.get(parent)?.parentId) ids.push(parent);
  }
  return ids;
}

/**
 * A session that waits on you: its agent says so (waiting for input, a permission), or it stopped
 * with a todo task marked blocked, the way omp asks the user to choose before going on.
 */
function waitsOnYou(node: ProjectTreeNode): boolean {
  if (node.kind !== 'session' || isRunningNode(node)) return false;
  return WAITING_ON_YOU_STATES.has((node.state ?? '').toLowerCase()) || node.progress?.blocked !== undefined;
}

/** A session the "Đang hoạt động" filter keeps: working now, or stopped waiting for you. */
export function isLiveNode(node: ProjectTreeNode): boolean {
  return isRunningNode(node) || waitsOnYou(node);
}

/** States the "rảnh" chip counts: stopped, nothing asked of you. */
const IDLE_STATES: ReadonlySet<string> = new Set(['idle', 'waiting']);

/**
 * The heading's counts, over each session once even when two Projects hold its folder.
 * Only sessions in a chip count toward the total: hibernated, finished and unknown
 * ones are not agents at work.
 */
export function sessionActivityCounts(nodes: readonly ProjectTreeNode[]): ActivityCounts & { total: number } {
  const counts = { total: 0, working: 0, needs: 0, idle: 0, error: 0 };
  const seen = new Set<string>();
  for (const node of nodes) {
    if (node.kind !== 'session') continue;
    const key = node.sessionId ?? node.id;
    if (seen.has(key)) continue;
    seen.add(key);
    const state = (node.state ?? '').toLowerCase();
    if (RUNNING_STATES.has(state)) counts.working += 1;
    else if (waitsOnYou(node)) counts.needs += 1;
    else if (state === 'error') counts.error += 1;
    else if (IDLE_STATES.has(state)) counts.idle += 1;
    else continue;
    counts.total += 1;
  }
  return counts;
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

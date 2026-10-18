/**
 * agentTree: the agent sidebar's project tree, and the collapsed rail built from
 * it, as pure data.
 *
 * A project is either a folder the board can work in or a herdr repo group. The
 * board's active folder is the only one whose company sessions the server loads,
 * so it alone lists its roles and rows; every other board folder shows the counts
 * the server reports for it. Herdr agents keep the repo grouping the sidebar
 * already builds. The rail is the same tree reduced to one marker per project
 * followed by its badges, so collapsing the sidebar never leaves an agent unnamed.
 */

import type { CompanyWorkspaceEntry, CompanyWorkspaceSession } from '../../../core/src/messages.js';
import {
  type ActivityCounts,
  type AgentRoleGroup,
  type AgentRow,
  buildAgentGroups,
  type HerdrGroup,
  herdrGroup,
  type HerdrRow,
  isFolded,
  type RepoPlacement,
  type SleepingRow,
  workspaceSessionRow,
} from './agentSidebarView.js';
import type { CompanyViewState } from './companyState.js';
import { removableErroredSessionIds } from './sessionRemoval.js';
import { workspaceName } from './workspaces.js';

/** How many colour slots a project's left tick cycles through. */
export const PROJECT_TONE_COUNT = 5;

/** The name a board with no folder path shows: its company sessions have no folder to name them. */
export const COMPANY_PROJECT_NAME = 'Công ty';

/** The most characters a rail marker prints before its ellipsis. */
const RAIL_NAME_MAX_CHARS = 8;

/** What a herdr repo group's tooltip says about how the group was found. */
const REPO_SOURCE_TITLE: Readonly<Record<RepoPlacement['source'], string>> = {
  repo: 'Nhóm theo repository git',
  workspace: 'Nhóm theo workspace của herdr (chưa có repository)',
  folder: 'Nhóm theo tên thư mục (chưa có repository hay workspace)',
  other: 'Chưa rõ repository, workspace hay thư mục',
};

/** A background folder's sessions as the tree lists them: live rows, and parked rows folded under "Tạm trữ". */
export interface FolderRows {
  /** The folder's path: a click on one of its sessions switches the board to it. */
  path: string;
  live: AgentRow[];
  parked: AgentRow[];
}

export interface ProjectNode {
  /** Stable identity: `board:<path>` for a folder, `herdr:<repo key>` for a herdr group. */
  key: string;
  kind: 'board' | 'herdr';
  name: string;
  /** The full folder path; null when unknown. */
  path: string | null;
  /** What the header's tooltip says: the full path, and for a herdr group how it was found. */
  tooltip: string;
  /** True for the board's active folder, the only one whose sessions are loaded. */
  active: boolean;
  /** A board folder that is not active: the folder the board switches to. Null otherwise. */
  switchTo: string | null;
  /** A board folder the board remembers but has not opened: switching to it opens it. */
  notOpen: boolean;
  /** The git branch a herdr group reports, shown as a chip; null when none does. */
  branch: string | null;
  /** The colour slot of the project's left tick, 0 up to PROJECT_TONE_COUNT. */
  tone: number;
  counts: ActivityCounts;
  collapsed: boolean;
  /** The active folder's roles, in role order, each with its live and parked rows. */
  groups: AgentRoleGroup[];
  /** A herdr group's agents, most urgent first. */
  panes: HerdrRow[];
  /** A herdr group's hibernated sessions, most recently slept first; listed after its panes. */
  sleeping: SleepingRow[];
  /**
   * A background folder's sessions from the folder list. Null for the active folder, for a
   * folder that is not open, and when the server sent no sessions (the tree then shows counts).
   */
  folderRows: FolderRows | null;
  /** Parked sessions under the active folder, counted across its roles. */
  parkedCount: number;
  /** Session ids the errored-session cleanup may delete under the active folder. */
  cleanable: string[];
}

export interface AgentTree {
  projects: ProjectNode[];
  /** The herdr state the groups came from, so the sidebar can say why herdr shows nothing. */
  herdr: HerdrGroup;
}

/** One thing the collapsed rail draws, top to bottom. */
export type RailEntry =
  | { kind: 'project'; project: ProjectNode }
  | { kind: 'summary'; project: ProjectNode }
  | { kind: 'session'; row: AgentRow; projectKey: string }
  | { kind: 'remoteSession'; row: AgentRow; project: ProjectNode; path: string }
  | { kind: 'pane'; row: HerdrRow; projectKey: string }
  | { kind: 'sleeping'; row: SleepingRow; projectKey: string }
  | { kind: 'parked'; count: number; projectKey: string }
  | { kind: 'break' };

/** The key of a board folder. Its collapse state is stored under this key. */
export function boardProjectKey(path: string | null): string {
  return `board:${path ?? ''}`;
}

/** The tree the sidebar and the rail draw. `collapsed` holds the keys of folded projects. */
export function buildProjectTree(
  state: CompanyViewState,
  now: number,
  collapsed: ReadonlySet<string>,
): AgentTree {
  const groups = buildAgentGroups(state, now);
  const herdr = herdrGroup(state.herdr, now);
  const listed = state.workspaces ?? [];
  const activePath =
    listed.find((entry) => entry.active)?.path ?? state.settings?.workspacePath ?? null;

  const projects: ProjectNode[] = [activeBoardProject(state, groups, activePath, collapsed)];
  for (const entry of listed) {
    if (entry.active || entry.path === activePath) continue;
    projects.push(inactiveBoardProject(entry, collapsed));
  }
  if (herdr.kind === 'ready') {
    for (const repo of herdr.repos) {
      const key = `herdr:${repo.key}`;
      const placed = [...repo.rows, ...repo.sleeping];
      const path = placed.find((row) => row.worktreeRoot !== null)?.worktreeRoot ?? null;
      projects.push({
        key,
        kind: 'herdr',
        name: repo.label,
        path,
        tooltip:
          path === null
            ? REPO_SOURCE_TITLE[repo.source]
            : `${REPO_SOURCE_TITLE[repo.source]} · ${path}`,
        active: false,
        switchTo: null,
        notOpen: false,
        branch: placed.find((row) => row.branch !== null)?.branch ?? null,
        tone: projectTone(key),
        counts: countTones(repo.rows.map((row) => row.tone)),
        collapsed: collapsed.has(key),
        groups: [],
        panes: repo.rows,
        sleeping: repo.sleeping,
        folderRows: null,
        parkedCount: 0,
        cleanable: [],
      });
    }
  }
  return { projects, herdr };
}

function activeBoardProject(
  state: CompanyViewState,
  groups: AgentRoleGroup[],
  activePath: string | null,
  collapsed: ReadonlySet<string>,
): ProjectNode {
  const key = boardProjectKey(activePath);
  return {
    key,
    kind: 'board',
    name: activePath === null ? COMPANY_PROJECT_NAME : workspaceName(activePath),
    path: activePath,
    tooltip: activePath ?? COMPANY_PROJECT_NAME,
    active: true,
    switchTo: null,
    notOpen: false,
    branch: null,
    tone: projectTone(key),
    counts: countTones(groups.flatMap((group) => group.active.map((row) => row.tone))),
    collapsed: collapsed.has(key),
    groups,
    panes: [],
    sleeping: [],
    folderRows: null,
    parkedCount: groups.reduce((sum, group) => sum + group.parked.length, 0),
    cleanable: groups.flatMap((group) => removableErroredSessionIds(state, group)),
  };
}

function inactiveBoardProject(
  entry: CompanyWorkspaceEntry,
  collapsed: ReadonlySet<string>,
): ProjectNode {
  const key = boardProjectKey(entry.path);
  const sessions = entry.open ? entry.sessions : undefined;
  return {
    key,
    kind: 'board',
    name: workspaceName(entry.path),
    path: entry.path,
    tooltip: entry.path,
    active: false,
    switchTo: entry.path,
    notOpen: !entry.open,
    branch: null,
    tone: projectTone(key),
    counts: { working: entry.working, needs: entry.waiting, idle: 0, error: 0 },
    collapsed: collapsed.has(key),
    groups: [],
    panes: [],
    sleeping: [],
    folderRows: sessions === undefined ? null : folderRowsOf(entry.path, sessions),
    parkedCount: 0,
    cleanable: [],
  };
}

/**
 * A background folder's sessions as its tree lists them: the live ones in the server's
 * order (waiting on the user first), and the parked ones, which fold under "Tạm trữ".
 */
function folderRowsOf(path: string, sessions: readonly CompanyWorkspaceSession[]): FolderRows {
  const rows = sessions.map(workspaceSessionRow);
  return {
    path,
    live: rows.filter((row) => !isFolded(row)),
    parked: rows.filter((row) => isFolded(row)),
  };
}

/** Counts the live tones only: parked, done and unknown agents are not counted. */
function countTones(tones: readonly string[]): ActivityCounts {
  const counts: ActivityCounts = { working: 0, needs: 0, idle: 0, error: 0 };
  for (const tone of tones) {
    if (tone === 'working' || tone === 'needs' || tone === 'idle' || tone === 'error') {
      counts[tone] += 1;
    }
  }
  return counts;
}

/** A stable colour slot for a project key, so a project keeps its tick across renders. */
export function projectTone(key: string): number {
  let hash = 0;
  for (const char of key) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash % PROJECT_TONE_COUNT;
}

/** The counts as the tree prints them: "đang làm 2 · chờ bạn 1", or what there is instead. */
export function projectCountsText(counts: ActivityCounts): string {
  const parts: string[] = [];
  if (counts.working > 0) parts.push(`đang làm ${counts.working}`);
  if (counts.needs > 0) parts.push(`chờ bạn ${counts.needs}`);
  if (counts.error > 0) parts.push(`lỗi ${counts.error}`);
  if (parts.length === 0 && counts.idle > 0) parts.push(`rảnh ${counts.idle}`);
  return parts.length === 0 ? 'chưa có agent' : parts.join(' · ');
}

/** Total live agents a project holds. */
export function projectAgentTotal(counts: ActivityCounts): number {
  return counts.working + counts.needs + counts.idle + counts.error;
}

/** A rail marker's name: the first characters, then an ellipsis when the name is longer. */
export function shortProjectName(name: string): string {
  const chars = Array.from(name);
  if (chars.length <= RAIL_NAME_MAX_CHARS + 1) return name;
  return `${chars.slice(0, RAIL_NAME_MAX_CHARS).join('')}…`;
}

/**
 * The rail, top to bottom. Each project opens with its marker. An expanded
 * active folder shows the sessions that wait on the user first, then the other
 * live sessions in role order, then one "+N" badge for its parked sessions. An
 * expanded herdr group shows its panes, then its hibernated sessions. A collapsed
 * project shows one summary badge instead. A break separates projects.
 */
export function buildRailTree(projects: readonly ProjectNode[]): RailEntry[] {
  const entries: RailEntry[] = [];
  projects.forEach((project, index) => {
    if (index > 0) entries.push({ kind: 'break' });
    entries.push({ kind: 'project', project });
    if (project.collapsed) {
      entries.push({ kind: 'summary', project });
      return;
    }
    if (project.active) {
      const rows = project.groups.flatMap((group) => group.active);
      for (const row of rows) {
        if (row.needsYou) entries.push({ kind: 'session', row, projectKey: project.key });
      }
      for (const row of rows) {
        if (!row.needsYou) entries.push({ kind: 'session', row, projectKey: project.key });
      }
      if (project.parkedCount > 0) {
        entries.push({ kind: 'parked', count: project.parkedCount, projectKey: project.key });
      }
    }
    if (project.folderRows !== null) {
      for (const row of project.folderRows.live) {
        entries.push({
          kind: 'remoteSession',
          row,
          project,
          path: project.folderRows.path,
        });
      }
      if (project.folderRows.parked.length > 0) {
        entries.push({
          kind: 'parked',
          count: project.folderRows.parked.length,
          projectKey: project.key,
        });
      }
    }
    for (const row of project.panes) {
      entries.push({ kind: 'pane', row, projectKey: project.key });
    }
    for (const row of project.sleeping) {
      entries.push({ kind: 'sleeping', row, projectKey: project.key });
    }
  });
  return entries;
}

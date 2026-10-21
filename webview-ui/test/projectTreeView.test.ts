import { describe, expect, it } from 'vitest';

import type { ProjectTreeNode } from '../../core/src/messages.js';
import { checkoutPathFor, projectMenuContext } from '../src/company/projects/projectNodeTargets.js';
import {
  buildAgentTree,
  canMoveProjectNode,
  countSessions,
  filterProjectTree,
  herdrOutsideProjects,
  projectNodeMenuItems,
  sessionActivityCounts,
} from '../src/company/projects/projectTreeView.js';

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
  node('folder', 'folder', 'group', { path: '/work' }),
  node('repo', 'repository', 'folder', { path: '/work/repo' }),
  node('checkout', 'checkout', 'repo', { branch: 'feature', overlap: true, path: '/work/repo/.worktrees/feature' }),
  node('file', 'file-agg', 'checkout'),
  node('session', 'session', 'checkout', { agentKind: 'claude', state: 'running' }),
  node('idle', 'session', 'checkout', { agentKind: 'omp', state: 'idle' }),
  node('empty', 'folder', 'project'),
  node('other', 'project'),
];

describe('projectTreeView', () => {
  it('shows sessions under their repo heading, with the branch they work on, and no worktree or file rows', () => {
    const roots = buildAgentTree(nodes);
    expect(roots.map((entry) => entry.node.id)).toEqual(['project', 'other']);
    const folder = roots[0]?.children[0]?.children[0];
    expect(folder?.node.id).toBe('folder');
    expect(folder?.children.map((child) => child.node.id)).toEqual(['repo']);
    expect(folder?.children[0]?.children.map((child) => child.node.id)).toEqual(['session', 'idle']);
    expect(folder?.children[0]?.children[0]).toMatchObject({ where: 'feature', checkoutPath: '/work/repo/.worktrees/feature' });
    expect(countSessions(roots[0]!)).toEqual({ total: 2, running: 1 });
  });

  it('lists sessions straight under a folder that is itself the repo', () => {
    const own = [
      node('p', 'project'),
      node('f', 'folder', 'p', { path: 'D:\\Work\\Repo\\' }),
      node('r', 'repository', 'f', { path: 'd:/work/repo' }),
      node('c', 'checkout', 'r', { branch: 'main', path: 'd:/work/repo' }),
      node('s', 'session', 'c', { state: 'running' }),
    ];
    expect(buildAgentTree(own)[0]?.children[0]?.children.map((child) => child.node.id)).toEqual(['s']);
  });

  it('nests each subagent under the session that spawned it, and keeps that session when only a subagent matches', () => {
    const family = [
      ...nodes,
      node('scout', 'session', 'checkout', { agentKind: 'sub', state: 'running', sessionId: 'sub-1', parentSessionId: 'main-1' }),
      node('orphan', 'session', 'checkout', { agentKind: 'sub', state: 'running', sessionId: 'sub-2', parentSessionId: 'gone' }),
    ].map((entry) => (entry.id === 'idle' ? { ...entry, sessionId: 'main-1' } : entry));
    const repo = buildAgentTree(family)[0]?.children[0]?.children[0]?.children[0];
    expect(repo?.children.map((child) => child.node.id)).toEqual(['session', 'idle', 'orphan']);
    expect(repo?.children[1]?.children.map((child) => child.node.id)).toEqual(['scout']);
    // The parent is idle, so the live filter alone would hide it; its running subagent keeps it.
    const live = filterProjectTree(buildAgentTree(family), { agentKind: 'all', liveOnly: true });
    const liveRepo = live[0]?.children[0]?.children[0]?.children[0];
    expect(liveRepo?.children.map((child) => child.node.id)).toEqual(['session', 'idle', 'orphan']);
    expect(countSessions(liveRepo!)).toEqual({ total: 4, running: 3 });
  });

  it('filters session rows only: folders stay so a new empty folder is always visible, empty repo headings go', () => {
    const claude = filterProjectTree(buildAgentTree(nodes), { agentKind: 'claude', liveOnly: false });
    expect(claude[0]?.children.map((child) => child.node.id)).toEqual(['group', 'empty']);
    expect(claude[0]?.children[0]?.children[0]?.children[0]?.children.map((child) => child.node.id)).toEqual(['session']);
    const agy = filterProjectTree(buildAgentTree(nodes), { agentKind: 'agy', liveOnly: false });
    expect(agy.map((entry) => entry.node.id)).toEqual(['project', 'other']);
    expect(agy[0]?.children[0]?.children[0]?.children).toEqual([]);
  });

  it('live filter hides idle sessions and keeps running ones and ones waiting on you', () => {
    const waiting = node('waiting', 'session', 'checkout', { agentKind: 'claude', state: 'waiting_input' });
    const live = filterProjectTree(buildAgentTree([...nodes, waiting]), { agentKind: 'all', liveOnly: true });
    expect(live[0]?.children[0]?.children[0]?.children[0]?.children.map((child) => child.node.id)).toEqual(['session', 'waiting']);
  });

  it('offers only what works for each node, from the tree around it', () => {
    const actions = (id: string) => {
      const target = nodes.find((entry) => entry.id === id)!;
      return projectNodeMenuItems(target, projectMenuContext(nodes, target))
        .map((entry) => (entry.action.kind === 'projectNodeAction' ? entry.action.action : ''));
    };
    // A Project with folders starts a session (choosing the folder in the dialog).
    expect(actions('project')[0]).toBe('newSession');
    // A Project with no folder cannot: adding one comes first.
    expect(actions('other')[0]).toBe('addFolder');
    expect(actions('folder')).toEqual(expect.arrayContaining(['newSessionClaude', 'changes', 'removeFolder']));
    // A folder that is not a git repo has no diff to show.
    expect(actions('empty')).not.toContain('changes');
    expect(actions('checkout')).toEqual(expect.arrayContaining(['merge', 'copyBranch']));
    // A session the board does not run offers its changes, not an "open" that goes nowhere.
    expect(actions('session')).toEqual(['changes', 'copySessionId', 'copyPath']);
    const boardRun = { ...nodes.find((entry) => entry.id === 'session')!, boardSessionId: 'board-1' };
    expect(projectNodeMenuItems(boardRun, projectMenuContext(nodes, boardRun))[0]?.label).toBe('Mở phiên');
    expect(checkoutPathFor(nodes, nodes.find((entry) => entry.id === 'session')!)).toBe('/work/repo/.worktrees/feature');
  });

  it('rejects drag destinations inside the dragged node subtree', () => {
    expect(canMoveProjectNode(nodes, 'group', 'folder')).toBe(false);
    expect(canMoveProjectNode(nodes, 'group', 'group')).toBe(false);
    expect(canMoveProjectNode(nodes, 'group', 'other')).toBe(true);
  });

  it('offers waking a hibernated herdr session, and opening it', () => {
    const asleep = node('pane', 'session', 'checkout', { agentKind: 'herdr', state: 'sleeping', sessionId: 'w1:p2' });
    const items = projectNodeMenuItems(asleep, projectMenuContext([...nodes, asleep], asleep));
    expect(items.slice(0, 2).map((item) => item.label)).toEqual(['Đánh thức', 'Mở phiên']);
    const awake = { ...asleep, state: 'idle' };
    expect(projectNodeMenuItems(awake, projectMenuContext([...nodes, awake], awake)).map((item) => item.label)).not.toContain('Đánh thức');
  });

  it('counts each session once across Projects, leaving hibernated, finished and unknown ones out', () => {
    const shared = [
      node('a', 'session', 'folder', { sessionId: 's1', state: 'running' }),
      node('b', 'session', 'empty', { sessionId: 's1', state: 'running' }),
      node('c', 'session', 'folder', { sessionId: 's2', state: 'waiting_input' }),
      node('d', 'session', 'folder', { sessionId: 's3', state: 'idle' }),
      node('e', 'session', 'folder', { sessionId: 's4', state: 'sleeping' }),
      node('f', 'session', 'folder', { sessionId: 's5', state: 'done' }),
      node('g', 'session', 'folder', { sessionId: 's6', state: 'unknown' }),
    ];
    expect(sessionActivityCounts(shared)).toEqual({ total: 3, working: 1, needs: 1, idle: 1, error: 0 });
  });

  it('keeps herdr panes outside every Project reachable, live ones before hibernated', () => {
    const inTree = node('pane', 'session', 'folder', { agentKind: 'herdr', sessionId: 'w1:p1' });
    const rows = herdrOutsideProjects([...nodes, inTree], {
      agents: [
        { paneId: 'w1:p1', status: 'working', cwd: 'D:/repo' },
        { paneId: 'w1:p3', status: 'idle', name: 'omp', cwd: 'D:\\other\\tool' },
      ],
      sleeping: [{ paneId: 'w1:p9', title: 'Ngủ', cwd: 'D:/away' }],
    });
    expect(rows).toEqual([
      { paneId: 'w1:p3', title: 'omp', where: 'tool', status: 'idle', sleeping: false },
      { paneId: 'w1:p9', title: 'Ngủ', where: 'away', status: 'sleeping', sleeping: true },
    ]);
  });
});

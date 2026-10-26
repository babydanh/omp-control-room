import { describe, expect, it } from 'vitest';

import type { ProjectTreeNode } from '../../core/src/messages.js';
import { awakePaneOf } from '../src/company/agentMenu.js';
import {
  changesAt,
  checkoutChangesByPath,
  checkoutPathFor,
  projectMenuContext,
  sessionChanges,
} from '../src/company/projects/projectNodeTargets.js';
import {
  buildAgentTree,
  canMoveProjectNode,
  countSessions,
  filterProjectTree,
  finishedTurn,
  isSelectedSession,
  projectNodeMenuItems,
  selectedAncestorIds,
  sessionActivityCounts,
  sessionDisplayName,
  sessionFaceHue,
  sessionFaceMood,
  sessionSummary,
  shownFaceMood,
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

  it('live filter hides idle sessions and keeps running ones, ones waiting on you, and idle ones with a blocked todo', () => {
    const waiting = node('waiting', 'session', 'checkout', { agentKind: 'claude', state: 'waiting_input' });
    const stuck = node('stuck', 'session', 'checkout', { agentKind: 'omp', state: 'idle', sessionId: 'stuck-1', progress: { done: 3, total: 6, blocked: 'Gộp main: chờ người dùng cho phép' } });
    const live = filterProjectTree(buildAgentTree([...nodes, waiting, stuck]), { agentKind: 'all', liveOnly: true });
    expect(live[0]?.children[0]?.children[0]?.children[0]?.children.map((child) => child.node.id)).toEqual(['session', 'waiting', 'stuck']);
    expect(sessionActivityCounts([stuck]).needs).toBe(1);
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
    expect(actions('checkout')).toEqual(expect.arrayContaining(['merge', 'compare', 'copyBranch']));
    // A session the board does not run offers its changes, not an "open" that goes nowhere; its process can be stopped.
    expect(actions('session')).toEqual(['changes', 'copySessionId', 'copyPath', 'stop']);
    // A subagent shares its parent's process: no stop of its own.
    const sub = node('sub', 'session', 'checkout', { agentKind: 'sub', state: 'running' });
    expect(projectNodeMenuItems(sub, projectMenuContext([...nodes, sub], sub)).map((entry) => entry.label)).not.toContain('Tắt phiên…');
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

  it('offers the cloud handoff only to an omp session in an awake herdr pane, the one it messages', () => {
    const labels = (entry: ProjectTreeNode) => projectNodeMenuItems(entry, projectMenuContext([...nodes, entry], entry)).map((item) => item.label);
    const omp = node('omp', 'session', 'checkout', { agentKind: 'omp', state: 'running', herdrPaneId: 'w1:p7' });
    expect(labels(omp)).toContain('Đẩy lên cloud làm tiếp');
    expect(awakePaneOf(omp)).toBe('w1:p7');
    // fast-handoff would carry some other omp transcript for a Claude session.
    expect(labels({ ...omp, agentKind: 'claude' })).not.toContain('Đẩy lên cloud làm tiếp');
    // A joined pane that sleeps has no agent to read the message.
    expect(labels({ ...omp, state: 'sleeping' })).not.toContain('Đẩy lên cloud làm tiếp');
    expect(awakePaneOf({ ...omp, state: 'sleeping' })).toBeNull();
    // Not in herdr: the board has no pane to message.
    expect(labels(node('out', 'session', 'checkout', { agentKind: 'omp', state: 'running' }))).not.toContain('Đẩy lên cloud làm tiếp');
  });

  it('points at the row of the session the drawer shows, by its pane or its board or native id', () => {
    const joined = node('claude', 'session', 'checkout', { agentKind: 'claude', sessionId: 'abc', herdrPaneId: 'w1:p7' });
    expect(isSelectedSession(joined, { sessionId: null, paneId: 'w1:p7' })).toBe(true);
    expect(isSelectedSession(joined, { sessionId: 'abc', paneId: null })).toBe(true);
    expect(isSelectedSession({ ...joined, boardSessionId: 'board-1' }, { sessionId: 'board-1', paneId: null })).toBe(true);
    const pane = node('pane', 'session', 'checkout', { agentKind: 'herdr', sessionId: 'w1:p2' });
    expect(isSelectedSession(pane, { sessionId: null, paneId: 'w1:p2' })).toBe(true);
    expect(isSelectedSession(joined, { sessionId: null, paneId: 'w1:p2' })).toBe(false);
    // A folder holding the session is not the session.
    expect(isSelectedSession(node('f', 'folder'), { sessionId: null, paneId: 'w1:p7' })).toBe(false);
  });

  it('keeps the session the drawer shows past the filters, and names the folders to unfold above it', () => {
    const idle = { ...nodes.find((entry) => entry.id === 'idle')!, sessionId: 'omp-1' };
    const all = nodes.map((entry) => (entry.id === 'idle' ? idle : entry));
    const sessionsOf = (roots: ReturnType<typeof filterProjectTree>) => JSON.stringify(roots).includes('"id":"idle"');
    expect(sessionsOf(filterProjectTree(buildAgentTree(all), { agentKind: 'claude', liveOnly: true }))).toBe(false);
    expect(sessionsOf(filterProjectTree(buildAgentTree(all), { agentKind: 'claude', liveOnly: true, keep: { sessionId: 'omp-1', paneId: null } }))).toBe(true);
    expect(selectedAncestorIds(all, { sessionId: 'omp-1', paneId: null })).toEqual(['checkout', 'repo', 'folder', 'group', 'project']);
    expect(selectedAncestorIds(all, { sessionId: 'none', paneId: null })).toEqual([]);
  });

  it('opens the herdr pane and the last edited checkout of a session at a folder root', () => {
    const root = node('root', 'session', 'folder', { agentKind: 'omp', state: 'running', herdrPaneId: 'w1:p5', editCheckouts: ['/work/repo'] });
    const all = [...nodes, root];
    const labels = projectNodeMenuItems(root, projectMenuContext(all, root)).map((item) => item.label);
    expect(labels.slice(0, 2)).toEqual(['Mở phiên', 'Xem thay đổi']);
    expect(checkoutPathFor(all, root)).toBe('/work/repo');
    const folder = buildAgentTree(all)[0]?.children[0]?.children[0];
    expect(folder?.children.find((child) => child.node.id === 'root')).toMatchObject({ checkoutPath: '/work/repo' });
  });

  it('opens the changes of the newest edited checkout that still has uncommitted lines', () => {
    const tree = [
      node('f', 'folder', undefined, { path: '/w' }),
      node('r', 'repository', 'f', { path: '/w' }),
      node('root', 'checkout', 'r', { path: '/w', additions: 0, deletions: 0 }),
      node('a', 'checkout', 'r', { path: '/w/a', additions: 0, deletions: 0 }),
      node('b', 'checkout', 'r', { path: '/w/b', additions: 4, deletions: 1 }),
      node('s', 'session', 'root', { editCheckouts: ['/w', '/w/a', '/w/b'] }),
    ];
    expect(checkoutPathFor(tree, tree[5]!)).toBe('/w/b');
    // Nothing uncommitted anywhere: the checkout it works in.
    const clean = tree.map((entry) => (entry.id === 'b' ? { ...entry, additions: 0, deletions: 0 } : entry));
    expect(checkoutPathFor(clean, clean[5]!)).toBe('/w');
  });

  it('finds a checkout\u2019s added and removed lines by a path written the Windows way', () => {
    const tree = [node('wt', 'checkout', 'repo', { path: 'V:/Work/Repo/.worktrees/feat', additions: 12, deletions: 3 })];
    const byPath = checkoutChangesByPath(tree);
    expect(changesAt(byPath, 'v:\\work\\repo\\.worktrees\\feat\\')).toEqual({ additions: 12, deletions: 3 });
    expect(changesAt(byPath, 'V:/Work/Other')).toBeNull();
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
});

describe('TC-FEAT-02: a session face in the tree shows how the session is doing', () => {
  const session = (state: string): ProjectTreeNode => ({ id: `s-${state}`, kind: 'session', name: 'phiên', state });

  it('sleeps, works, waits on you, errs, or rests, from the session state', () => {
    expect(sessionFaceMood(session('sleeping'))).toBe('sleep');
    expect(sessionFaceMood(session('running'))).toBe('work');
    expect(sessionFaceMood(session('busy'))).toBe('work');
    expect(sessionFaceMood(session('waiting_input'))).toBe('waiting');
    expect(sessionFaceMood(session('permission'))).toBe('waiting');
    expect(sessionFaceMood(session('error'))).toBe('error');
    expect(sessionFaceMood(session('idle'))).toBe('idle');
    // "waiting" is an idle session with nothing asked of you; a blocked step is a question for you.
    expect(sessionFaceMood(session('waiting'))).toBe('idle');
    expect(sessionFaceMood({ ...session('idle'), progress: { done: 1, total: 3, blocked: 'chờ duyệt' } })).toBe('waiting');
    expect(sessionFaceMood(session('done'))).toBe('done');
  });

  it('cheers only when a working session comes to rest, not when it sleeps, errs or starts', () => {
    expect(finishedTurn('work', 'idle')).toBe(true);
    expect(finishedTurn('work', 'done')).toBe(true);
    expect(finishedTurn('work', 'sleep')).toBe(false);
    expect(finishedTurn('work', 'error')).toBe(false);
    expect(finishedTurn('idle', 'work')).toBe(false);
    expect(finishedTurn('idle', 'idle')).toBe(false);
  });

  it('lets the cheer stand in only for rest: a mood change mid-cheer shows the new mood at once', () => {
    // work → idle starts a cheer; idle → sleep/error/waiting/work before it ends must not stay "done".
    expect(shownFaceMood('idle', true)).toBe('done');
    expect(shownFaceMood('sleep', true)).toBe('sleep');
    expect(shownFaceMood('error', true)).toBe('error');
    expect(shownFaceMood('waiting', true)).toBe('waiting');
    expect(shownFaceMood('work', true)).toBe('work');
    expect(shownFaceMood('idle', false)).toBe('idle');
  });

  it('keeps one colour per session id, never the red that means an error', () => {
    const id = 'df490920-498d-4f6f-a082-92307c3ffac5';
    expect(sessionFaceHue(id)).toBe(sessionFaceHue(id));
    const hues = Array.from({ length: 500 }, (_, index) => sessionFaceHue(`phiên-${index}`));
    expect(hues.every((hue) => hue >= 30 && hue < 330)).toBe(true);
    expect(new Set(hues).size).toBeGreaterThan(100);
  });
});

describe('a session row names itself and says what it does', () => {
  const uuid = '3f2c1a9e-1b2c-4d5e-8f90-a1b2c3d4e5f6';
  const session = (extra: Partial<ProjectTreeNode>): ProjectTreeNode => ({ id: 's', kind: 'session', name: uuid, sessionId: uuid, ...extra });

  it('uses the first request when the name is only the session id', () => {
    expect(sessionDisplayName(session({ request: '  sửa lỗi\n đổi tên phiên ' }))).toBe('sửa lỗi đổi tên phiên');
    expect(sessionDisplayName(session({ request: 'x'.repeat(80) }))).toHaveLength(40);
  });

  it('keeps a real name, and the id when there is no request', () => {
    expect(sessionDisplayName(session({ name: 'Sửa board', request: 'khác' }))).toBe('Sửa board');
    expect(sessionDisplayName(session({}))).toBe(uuid);
  });

  it('summarises with the newest message, and stays silent when it repeats the name', () => {
    expect(sessionSummary(session({ request: 'a', lastRequest: 'b' }))).toBe('b');
    expect(sessionSummary(session({ request: 'a' }))).toBeUndefined();
    expect(sessionSummary(session({ name: 'a', request: 'a' }))).toBeUndefined();
  });
});

describe('changed lines belong to the session, not to every session in its checkout', () => {
  it('reads the session node own counts and stays silent without any', () => {
    expect(sessionChanges({ id: 's', kind: 'session', name: 's', additions: 3, deletions: 1 })).toEqual({ additions: 3, deletions: 1 });
    expect(sessionChanges({ id: 's', kind: 'session', name: 's', additions: 0, deletions: 0 })).toBeNull();
    expect(sessionChanges({ id: 's', kind: 'session', name: 's' })).toBeNull();
    expect(sessionChanges(undefined)).toBeNull();
  });
});

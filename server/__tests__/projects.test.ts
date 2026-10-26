import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { GitRunner } from '../src/ledger/git.js';
import { openLedgerSource, type SqliteDatabase } from '../src/ledger/ledgerDb.js';
import { normalizeLedgerPath } from '../src/ledger/ledgerPath.js';
import type { ProcessResult } from '../src/ledger/processRunner.js';
import { toPathKey } from '../src/pathKey.js';
import { handleProjectMessage } from '../src/projects/handler.js';
import { ProjectStore } from '../src/projects/projectStore.js';
import { buildProjectTreeSnapshot, linkHerdrPanes, parentSessions } from '../src/projects/projectTree.js';
import { sessionRow } from './ledgerFixtures.js';

function processResult(stdout = '', code = 0, ok = code === 0): ProcessResult {
  return { ok, code, stdout, stderr: '', timedOut: false, truncated: false };
}


let tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pxl-projects-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

describe('ProjectStore', () => {
  it('migrates recent folders once, preserving configured display names and canonical paths', async () => {
    const root = await makeTempDir();
    const folder = path.join(root, 'workspace');
    await fs.mkdir(folder);
    const store = new ProjectStore({
      filePath: path.join(root, 'projects.json'),
      recentFolders: () => [folder],
      folderNames: () => ({ [toPathKey(folder)]: 'Tên workspace' }),
    });

    const first = await store.load();
    expect(first.projects).toHaveLength(1);
    expect(first.projects[0]?.name).toBe('Mặc định');
    expect(first.projects[0]?.children).toMatchObject([
      { type: 'folder', name: 'Tên workspace', path: await fs.realpath(folder) },
    ]);

    const reloaded = await new ProjectStore({
      filePath: path.join(root, 'projects.json'),
      recentFolders: () => [],
    }).load();
    expect(reloaded).toEqual(first);
  });

  it('creates, nests, moves and removes nodes; rejects moving a group into its descendant', async () => {
    const root = await makeTempDir();
    const folderA = path.join(root, 'a');
    const folderB = path.join(root, 'b');
    await fs.mkdir(folderA);
    await fs.mkdir(folderB);
    const store = new ProjectStore({ filePath: path.join(root, 'projects.json'), recentFolders: () => [] });
    const projectA = await store.createProject('Alpha');
    const projectB = await store.createProject('Beta');
    const outer = await store.createGroup(projectA.id, 'Outer');
    const inner = await store.createGroup(projectA.id, 'Inner', outer.id);
    const folder = await store.addFolder(projectA.id, folderA, inner.id);

    await expect(store.moveNode(outer.id, projectB.id, inner.id)).rejects.toThrow('Không thể di chuyển nhóm');
    await store.moveNode(folder.id, projectB.id);
    expect(store.snapshot().projects[1]?.children).toContainEqual(folder);

    await store.renameGroup(inner.id, 'Nested');
    // A folder's display name changes; its path does not.
    await store.renameFolder(folder.id, 'Backend');
    expect(store.snapshot().projects[1]?.children).toContainEqual({ ...folder, name: 'Backend' });
    await store.moveNode(folder.id, projectA.id, inner.id);
    await store.deleteGroup(outer.id);
    // Deleting a group keeps what it held: Inner (with its folder) moves up.
    expect(store.snapshot().projects[0]?.children.map((node) => node.id)).toEqual([inner.id]);
    await store.removeFolder(folder.id);
    await store.deleteGroup(inner.id);
    expect(store.snapshot().projects[0]?.children).toEqual([]);
    await expect(store.addFolder(projectB.id, folderB)).resolves.toMatchObject({ path: await fs.realpath(folderB) });
    await store.renameProject(projectA.id, 'Alpha renamed');
    await store.moveProject(projectB.id, 0);
    expect(store.snapshot().projects.map((project) => project.name)).toEqual(['Beta', 'Alpha renamed']);
    await store.deleteProject(projectA.id);
    expect(store.snapshot().projects.map((project) => project.id)).toEqual([projectB.id]);
  });
});

describe('buildProjectTreeSnapshot', () => {
  it('builds folder → repo → worktree → ledger session rows from disk and a temporary ledger source', async () => {
    const root = await makeTempDir();
    const folder = path.join(root, 'folder');
    const repo = path.join(folder, 'repo');
    const worktree = path.join(repo, '.worktrees', 'feature');
    const ledgerPath = path.join(root, 'activity.db');
    await fs.mkdir(path.join(repo, '.git'), { recursive: true });
    await fs.mkdir(worktree, { recursive: true });
    await fs.writeFile(ledgerPath, 'temporary-ledger');
    // New files are counted from disk: 3 lines in each checkout.
    await fs.writeFile(path.join(repo, 'new.txt'), 'a\nb\nc\n');
    await fs.writeFile(path.join(worktree, 'new.txt'), 'a\nb\nc');

    const database: SqliteDatabase = {
      prepare: (sql) => ({
        all: () => sql.includes('FROM sessions') ? [{
          session_id: 'session-1', pid: 1, cwd: worktree, agent_kind: 'main', agent_name: 'Implement tree',
          parent_id: null, started_at: '2026-10-20', last_seen: '2026-10-20', ended_at: null,
          state: 'working', heartbeat: null,
        }] : sql.includes('FROM events') ? [{
          id: 1, ts: '2026-10-20', session_id: 'session-1', kind: 'edit', tool: 'Edit',
          path: path.join(worktree, 'src', 'main.ts'), path_key: null, repo: null, checkout: null,
          is_main_checkout: 0, branch: null, intent: null,
        }] : sql.includes('FROM pending') ? [{
          checkout: worktree, session_id: 'session-1', branch: 'feature', dirty: 1, unpushed: 0,
          not_in_main: 0, has_remote: true, ts: '2026-10-20',
        }] : [],
      }),
      close: () => undefined,
    };
    const ledger = openLedgerSource(ledgerPath, () => database);
    const git: GitRunner = {
      async run(_cwd, args) {
        if (args[0] === 'rev-parse') return processResult();
        if (args[0] === 'worktree') {
          return processResult(
            `worktree ${repo}\nHEAD abc123\nbranch refs/heads/main\n\nworktree ${worktree}\nHEAD def456\nbranch refs/heads/feature\n`,
          );
        }
        if (args[0] === 'status') return processResult(' M source.ts\0');
        if (args[0] === 'rev-list') return processResult('2\t3');
        if (args[0] === 'merge-base') return processResult();
        if (args[0] === 'log') return processResult('feature\x002026-10-20T00:00:00Z');
        if (args[0] === 'diff' && args[1] === '--numstat') return processResult('1\t2\tsrc/main.ts\0');
        if (args[0] === 'ls-files') return processResult('new.txt\0');
        return processResult('', 128);
      },
    };
    const store = new ProjectStore({ filePath: path.join(root, 'projects.json'), recentFolders: () => [] });
    const project = await store.createProject('Test');
    await store.addFolder(project.id, folder);
    const snapshot = await buildProjectTreeSnapshot(store, {
      ledger,
      git,
      overlapScans: async () => [{
        repo,
        state: 'done',
        startedAt: null,
        finishedAt: null,
        base: 'origin/main',
        lanes: 2,
        pairs: [{
          a: repo,
          b: worktree,
          aLabel: 'main',
          bLabel: 'feature',
          conflicts: [{ file: 'src/main.ts', hunks: [] }],
          auto: [],
        }],
        main: [],
        pending: [],
        complete: true,
        error: null,
      }],
    });

    const featureNode = snapshot.nodes.find((node) => node.kind === 'checkout' && node.branch === 'feature');
    const mainNode = snapshot.nodes.find((node) => node.kind === 'checkout' && node.branch === 'main');
    const trackedFile = snapshot.nodes.find((node) => node.kind === 'file-agg' && node.name === 'main.ts');
    const untrackedFile = snapshot.nodes.find((node) => node.kind === 'file-agg' && node.name === 'new.txt');

    expect(snapshot.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: project.id, kind: 'project', name: 'Test', additions: 8, deletions: 4 }),
      expect.objectContaining({ kind: 'folder', name: 'folder', path: await fs.realpath(folder) }),
      expect.objectContaining({ kind: 'repository', name: 'repo', path: await fs.realpath(repo), overlap: true }),
      expect.objectContaining({
        kind: 'checkout', branch: 'main', dirty: true, ahead: 3, behind: 2, additions: 4, deletions: 2,
      }),
      expect.objectContaining({
        kind: 'checkout', branch: 'feature', dirty: true, ahead: 3, behind: 2, additions: 4,
        deletions: 2, overlap: true, pendingWork: true,
      }),
      expect.objectContaining({
        kind: 'session', engine: 'omp', agentKind: 'omp', sessionId: 'session-1',
        state: 'running', title: 'Implement tree',
      }),
    ]));
    expect(featureNode?.overlappingWorktrees).toEqual([normalizeLedgerPath(repo)]);
    expect(mainNode?.overlappingWorktrees).toEqual([normalizeLedgerPath(worktree)]);
    expect(trackedFile).toMatchObject({ additions: 1, deletions: 2, overlap: true });
    expect(untrackedFile).toMatchObject({ additions: 3, deletions: 0 });
    // The session's own lines are only the changed files it edited (main.ts), not its checkout's total (4/2).
    expect(snapshot.nodes.find((node) => node.kind === 'session')).toMatchObject({ additions: 1, deletions: 2 });
    // The session's cwd is inside both checkouts (feature nests under main): only the deeper one owns it.
    const sessionParents = snapshot.nodes.filter((node) => node.kind === 'session').map((node) => node.parentId);
    expect(sessionParents).toEqual([featureNode?.id]);
    ledger.close();
  });

  it('scans a linked worktree through its main repo but keeps a submodule as its own repo', async () => {
    const root = await makeTempDir();
    const folder = path.join(root, 'folder');
    const repo = path.join(folder, 'repo');
    const worktree = path.join(repo, '.worktrees', 'feature');
    const submodule = path.join(repo, 'vendor', 'lib');
    await fs.mkdir(path.join(repo, '.git', 'worktrees', 'feature'), { recursive: true });
    await fs.mkdir(worktree, { recursive: true });
    await fs.mkdir(submodule, { recursive: true });
    await fs.writeFile(path.join(worktree, '.git'), `gitdir: ${path.join(repo, '.git', 'worktrees', 'feature')}\n`);
    await fs.writeFile(path.join(submodule, '.git'), 'gitdir: ../../.git/modules/lib\n');
    const scanned: string[] = [];
    const git: GitRunner = {
      async run(cwd, args) {
        if (args[0] === 'rev-parse') scanned.push(path.resolve(cwd));
        return processResult('', 128);
      },
    };
    const store = new ProjectStore({ filePath: path.join(root, 'projects.json'), recentFolders: () => [] });
    const project = await store.createProject('Test');
    await store.addFolder(project.id, folder);
    await buildProjectTreeSnapshot(store, {
      ledger: openLedgerSource(path.join(root, 'missing.db'), () => {
        throw new Error('no database');
      }),
      git,
      listRepos: async () => [repo, worktree, submodule],
    });
    expect(scanned.sort()).toEqual([path.resolve(repo), path.resolve(submodule)].sort());
  });

  it('gives a herdr pane no ledger session joins, such as a sleeping one, what its transcript says it was doing', async () => {
    const root = await makeTempDir();
    const folder = path.join(root, 'folder');
    await fs.mkdir(folder);
    const cwd = await fs.realpath(folder);
    const store = new ProjectStore({ filePath: path.join(root, 'projects.json'), recentFolders: () => [] });
    const project = await store.createProject('Test');
    await store.addFolder(project.id, folder);
    const read: string[] = [];
    const snapshot = await buildProjectTreeSnapshot(store, {
      ledger: openLedgerSource(path.join(root, 'missing.db'), () => {
        throw new Error('no database');
      }),
      git: { run: async () => processResult() },
      sessionsOnly: true,
      herdrSessions: () => [
        { id: 'zz:1', cwd, status: 'sleeping', title: '3d6cdbd2', sessionFile: 'C:/s/a.jsonl' },
        { id: 'w1:p2', cwd, status: 'sleeping', title: 'Không có transcript' },
      ],
      sessionFacts: async (file) => {
        read.push(file);
        return { progress: { done: 1, total: 3, current: 'Thêm animation' }, request: 'làm animation nhân vật', lastRequest: 'làm tiếp', interrupted: "You've hit your session limit" };
      },
    });
    const sessions = snapshot.nodes.filter((node) => node.kind === 'session');
    expect(sessions.find((node) => node.id === 'herdr:zz:1')).toMatchObject({
      progress: { done: 1, total: 3, current: 'Thêm animation' },
      request: 'làm animation nhân vật',
      lastRequest: 'làm tiếp',
      interrupted: "You've hit your session limit",
    });
    expect(sessions.find((node) => node.id === 'herdr:w1:p2')).not.toHaveProperty('request');
    expect(read).toEqual(['C:/s/a.jsonl']);
  });
});

describe('parentSessions', () => {
  it('links a subagent to the live session whose transcript folder holds its file, else to the main one in its process', () => {
    const main = 'C:\\s\\2026-10-16T03_01a1.jsonl';
    const rows = [
      sessionRow('main-1', { pid: 7, sessionFile: main }),
      sessionRow('sub-1', { pid: 7, agentKind: 'sub', sessionFile: 'c:/s/2026-10-16T03_01a1/ScoutWebAppUi.jsonl' }),
      // A subagent of a subagent belongs to the deeper transcript.
      sessionRow('sub-2', { pid: 7, agentKind: 'sub', sessionFile: 'C:\\s\\2026-10-16T03_01a1\\ScoutWebAppUi\\Deeper.jsonl' }),
      // No file: the live main session in the same process.
      sessionRow('sub-3', { pid: 7, agentKind: 'sub' }),
      // A same-named prefix that is not its folder does not count.
      sessionRow('main-2', { pid: 8, sessionFile: 'C:\\s\\2026-10-16T03_01a1-other.jsonl' }),
      sessionRow('sub-old', { pid: 7, agentKind: 'sub', sessionFile: 'C:\\s\\gone\\X.jsonl', endedAt: '2026-10-16' }),
    ];
    expect(Object.fromEntries(parentSessions(rows))).toEqual({ 'sub-1': 'main-1', 'sub-2': 'sub-1', 'sub-3': 'main-1' });
  });

  it('leaves a subagent without a file unlinked when its process holds two main sessions', () => {
    const rows = [
      sessionRow('main-a', { pid: 12, sessionFile: 'C:\\s\\a.jsonl' }),
      sessionRow('main-b', { pid: 12, sessionFile: 'C:\\s\\b.jsonl' }),
      sessionRow('sub-x', { pid: 12, agentKind: 'sub' }),
    ];
    expect(parentSessions(rows).has('sub-x')).toBe(false);
  });
});

describe('linkHerdrPanes', () => {
  it('gives a live session the herdr pane reporting its transcript or id, and lists only the panes left over', () => {
    const rows = [
      sessionRow('omp-1', { sessionFile: 'C:\\s\\a.jsonl' }),
      sessionRow('claude-1'),
      sessionRow('ended', { sessionFile: 'C:\\s\\old.jsonl', endedAt: '2026-10-20' }),
    ];
    const pane = (id: string, extra: object = {}) => ({ id, cwd: 'C:/w', status: 'working', title: id, ...extra });
    const { rows: linked, panes } = linkHerdrPanes(rows, [
      pane('w1:p1', { sessionFile: 'c:/s/a.jsonl' }),
      pane('w1:p2', { sessionId: 'claude-1' }),
      pane('w1:p3', { sessionFile: 'C:\\s\\old.jsonl' }),
      pane('w1:p4'),
    ]);
    expect(linked.map((row) => row.herdrPaneId)).toEqual(['w1:p1', 'w1:p2', undefined]);
    expect(panes.map((entry) => entry.id)).toEqual(['w1:p3', 'w1:p4']);
  });
});

describe('project tree request', () => {
  it('answers with folders and live sessions first when the git scan is slow, then the full tree', async () => {
    const root = await makeTempDir();
    const folder = path.join(root, 'folder');
    const repo = path.join(folder, 'repo');
    await fs.mkdir(path.join(repo, '.git'), { recursive: true });
    const ledgerPath = path.join(root, 'activity.db');
    await fs.writeFile(ledgerPath, 'temporary-ledger');
    const database: SqliteDatabase = {
      prepare: (sql) => ({
        all: () => sql.includes('FROM sessions') ? [{
          session_id: 'session-1', pid: 1, cwd: repo, agent_kind: 'main', agent_name: 'main',
          parent_id: null, started_at: '2026-10-20', last_seen: '2026-10-20', ended_at: null,
          state: 'working', heartbeat: null,
        }] : sql.includes('FROM events') ? [{
          id: 1, ts: '2099-01-01 00:00:00', session_id: 'session-1', kind: 'tool', tool: 'edit', path: null,
          path_key: null, repo: null, checkout: null, is_main_checkout: 0, branch: null, intent: 'Sửa trang đăng ký',
        }] : [],
      }),
      close: () => undefined,
    };
    const ledger = openLedgerSource(ledgerPath, () => database);
    const git: GitRunner = {
      async run(_cwd, args) {
        if (args[0] === 'rev-parse') return processResult();
        if (args[0] === 'worktree') return processResult(`worktree ${repo}\nHEAD abc\nbranch refs/heads/main\n`);
        return processResult();
      },
    };
    const store = new ProjectStore({ filePath: path.join(root, 'projects.json'), recentFolders: () => [] });
    const project = await store.createProject('Test');
    await store.addFolder(project.id, folder);
    const sent: Array<{ type: string; partial?: boolean; nodes?: Array<{ id: string; kind: string; parentId?: string; name: string }> }> = [];
    handleProjectMessage({ type: 'projectTreeRequest', requestId: 'r1' }, (message) => sent.push(message as never), {
      privileged: true,
      // The board runs session-1 as its own session "board-1".
      boardSessionFor: (nativeSessionId) => (nativeSessionId === 'session-1' ? 'board-1' : undefined),
      store,
      tree: {
        ledger,
        git,
        listRepos: async () => {
          await new Promise((resolve) => setTimeout(resolve, 800));
          return [repo];
        },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 1500));

    const snapshots = sent.filter((message) => message.type === 'projectTreeSnapshot');
    expect(snapshots).toHaveLength(2);
    expect(snapshots.map((message) => message.partial === true)).toEqual([true, false]);
    const [quick, full] = snapshots.map((message) => message.nodes ?? []);
    const folderNode = quick?.find((node) => node.kind === 'folder');
    expect(quick?.some((node) => node.kind === 'repository')).toBe(false);
    // The session sits under its folder and is named by what it is doing.
    expect(quick?.find((node) => node.kind === 'session')).toMatchObject({
      parentId: folderNode?.id,
      name: 'Sửa trang đăng ký',
      boardSessionId: 'board-1',
    });
    expect(full?.some((node) => node.kind === 'repository')).toBe(true);
    ledger.close();
  });
});

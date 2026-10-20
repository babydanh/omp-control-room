import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { GitRunner } from '../src/ledger/git.js';
import { openLedgerSource, type SqliteDatabase } from '../src/ledger/ledgerDb.js';
import { normalizeLedgerPath } from '../src/ledger/ledgerPath.js';
import type { ProcessResult } from '../src/ledger/processRunner.js';
import { toPathKey } from '../src/pathKey.js';
import { ProjectStore } from '../src/projects/projectStore.js';
import { buildProjectTreeSnapshot } from '../src/projects/projectTree.js';

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
    await store.removeFolder(folder.id);
    await store.deleteGroup(inner.id);
    expect(store.snapshot().projects[0]?.children).toEqual([outer]);
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

    const database: SqliteDatabase = {
      prepare: (sql) => ({
        all: () => sql.includes('FROM sessions') ? [{
          session_id: 'session-1', pid: 1, cwd: worktree, agent_kind: 'main', agent_name: 'Implement tree',
          parent_id: null, started_at: '2026-10-20', last_seen: '2026-10-20', ended_at: null,
          state: 'working', heartbeat: null,
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
        if (args[0] === 'diff' && args[1] === '--no-index') {
          return processResult('3\t0\tb/new.txt\0', 1, true);
        }
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
    ledger.close();
  });
});

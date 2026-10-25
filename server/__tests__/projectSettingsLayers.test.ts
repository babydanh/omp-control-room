import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProjectSettingsValues, ProjectTreeNode, SquadSettings } from '../../core/src/messages.js';
import { SQUAD_SETTINGS_DEFAULT } from '../src/company/workItems/squadSettings.js';
import { ProjectStore } from '../src/projects/projectStore.js';
import type { ProjectTreeSnapshot } from '../src/projects/projectTree.js';
import type { ProjectModuleDeps } from '../src/projects/services.js';
import {
  clearProjectSettings,
  getProjectSettings,
  type ProjectSettingsServices,
  setProjectSettings,
} from '../src/projects/settingsLayers.js';

const osHome = vi.hoisted(() => ({ path: process.env.TEMP ?? process.env.TMP ?? 'C:\\Temp' }));
vi.mock('node:os', async (importOriginal) => {
  const os = await importOriginal<typeof import('node:os')>();
  return { ...os, homedir: () => osHome.path };
});

const testRoot = path.join(osHome.path, 'pixel-agents-layered-settings-tests');
const folderPath = path.join(testRoot, 'folder');
let projectStore: ProjectStore;
let tree: ProjectTreeSnapshot;
let projectId: string;
let folderId: string;
let folderSettings: SquadSettings;
let applied: SquadSettings[];
let deps: ProjectModuleDeps<ProjectSettingsServices>;

beforeEach(async () => {
  await fs.rm(testRoot, { recursive: true, force: true });
  await fs.rm(path.join(osHome.path, '.pixel-agents'), { recursive: true, force: true });
  await fs.mkdir(folderPath, { recursive: true });
  projectStore = new ProjectStore({ filePath: path.join(testRoot, 'projects.json') });
  const project = await projectStore.createProject('Workspace');
  projectId = project.id;
  const folder = await projectStore.addFolder(projectId, folderPath);
  folderId = folder.id;
  tree = {
    nodes: [
      { id: projectId, kind: 'project', name: 'Workspace' } as ProjectTreeNode,
      { id: folderId, kind: 'folder', parentId: projectId, name: 'folder', path: folderPath } as ProjectTreeNode,
    ],
  };
  folderSettings = { ...SQUAD_SETTINGS_DEFAULT };
  applied = [];
  const services: ProjectSettingsServices = {
    globalSettings: async () => ({
      engineLeader: 'claude',
      engineJudge: 'omp',
      engineWorker: 'agy',
      claudeModelLeader: 'opus',
      claudeModelJudge: 'sonnet',
      maxParallel: 3,
      maxClaudeRuns: 2,
      maxAgyRuns: 2,
    }),
    folderSettingsTargets: () => [{
      folder: folderPath,
      current: () => ({ ...folderSettings }),
      apply: async (next) => { folderSettings = { ...next }; applied.push({ ...next }); },
    }],
  };
  deps = { store: projectStore, loadTree: async () => tree, services };
});

afterEach(async () => {
  await fs.rm(testRoot, { recursive: true, force: true });
  await fs.rm(path.join(osHome.path, '.pixel-agents'), { recursive: true, force: true });
});

describe('project settings layers', () => {
  it('resolves global, project, then folder values and reports each winning source', async () => {
    await setProjectSettings({
      type: 'projectSettingsSet', requestId: 'p1', scope: 'project', nodeId: projectId,
      field: 'engineLeader', value: 'omp',
    }, deps);
    await setProjectSettings({
      type: 'projectSettingsSet', requestId: 'f1', scope: 'folder', nodeId: folderId,
      field: 'engineLeader', value: 'agy',
    }, deps);
    await setProjectSettings({
      type: 'projectSettingsSet', requestId: 'f2', scope: 'folder', nodeId: folderId,
      field: 'maxParallel', value: 6,
    }, deps);

    const result = await getProjectSettings({ type: 'projectSettingsRequest', requestId: 'read', nodeId: folderId }, deps);
    expect(result.values.engineLeader).toBe('agy');
    expect(result.sources.engineLeader).toBe('folder');
    expect(result.values.engineJudge).toBe('omp');
    expect(result.sources.engineJudge).toBe('global');
    expect(result.values.maxParallel).toBe(6);
    expect(result.sources.maxParallel).toBe('folder');
    expect(folderSettings.engineLeader).toBe('agy');
    expect(folderSettings.maxParallel).toBe(6);
  });

  it('clears a folder override to reveal project, then global values', async () => {
    await setProjectSettings({
      type: 'projectSettingsSet', requestId: 'p1', scope: 'project', nodeId: projectId,
      field: 'engineLeader', value: 'omp',
    }, deps);
    await setProjectSettings({
      type: 'projectSettingsSet', requestId: 'f1', scope: 'folder', nodeId: folderId,
      field: 'engineLeader', value: 'agy',
    }, deps);
    await clearProjectSettings({
      type: 'projectSettingsClear', requestId: 'c1', scope: 'folder', nodeId: folderId, field: 'engineLeader',
    }, deps);
    let result = await getProjectSettings({ type: 'projectSettingsRequest', requestId: 'read1', nodeId: folderId }, deps);
    expect(result.values.engineLeader).toBe('omp');
    expect(result.sources.engineLeader).toBe('project');
    await clearProjectSettings({
      type: 'projectSettingsClear', requestId: 'c2', scope: 'project', nodeId: projectId, field: 'engineLeader',
    }, deps);
    result = await getProjectSettings({ type: 'projectSettingsRequest', requestId: 'read2', nodeId: folderId }, deps);
    expect(result.values.engineLeader).toBe('claude');
    expect(result.sources.engineLeader).toBe('global');
  });

  it('rejects invalid field values without changing scheduler settings', async () => {
    await expect(setProjectSettings({
      type: 'projectSettingsSet', requestId: 'bad', scope: 'folder', nodeId: folderId,
      field: 'maxParallel', value: 0,
    }, deps)).rejects.toThrow('Giá trị cài đặt không hợp lệ.');
    await expect(setProjectSettings({
      type: 'projectSettingsSet', requestId: 'bad-disk', scope: 'folder', nodeId: folderId,
      field: 'minFreeDiskGb', value: 501,
    }, deps)).rejects.toThrow('Giá trị cài đặt không hợp lệ.');
    expect(applied).toHaveLength(0);
    expect(folderSettings.maxParallel).toBe(SQUAD_SETTINGS_DEFAULT.maxParallel);
  });

  it('layers the disk threshold and applies it to the active folder', async () => {
    await setProjectSettings({
      type: 'projectSettingsSet', requestId: 'project-disk', scope: 'project', nodeId: projectId,
      field: 'minFreeDiskGb', value: 24.5,
    }, deps);
    await setProjectSettings({
      type: 'projectSettingsSet', requestId: 'folder-disk', scope: 'folder', nodeId: folderId,
      field: 'minFreeDiskGb', value: 7.5,
    }, deps);

    let result = await getProjectSettings({ type: 'projectSettingsRequest', requestId: 'disk-read', nodeId: folderId }, deps);
    expect(result.values.minFreeDiskGb).toBe(7.5);
    expect(result.sources.minFreeDiskGb).toBe('folder');
    expect(folderSettings.minFreeDiskGb).toBe(7.5);

    await clearProjectSettings({
      type: 'projectSettingsClear', requestId: 'folder-disk-clear', scope: 'folder', nodeId: folderId,
      field: 'minFreeDiskGb',
    }, deps);
    result = await getProjectSettings({ type: 'projectSettingsRequest', requestId: 'disk-read-project', nodeId: folderId }, deps);
    expect(result.values.minFreeDiskGb).toBe(24.5);
    expect(result.sources.minFreeDiskGb).toBe('project');
    expect(folderSettings.minFreeDiskGb).toBe(24.5);
  });

  it('migrates legacy folder settings that differ from defaults as folder overrides', async () => {
    folderSettings = { ...SQUAD_SETTINGS_DEFAULT, engineWorker: 'claude', maxClaudeRuns: 4 };
    const result = await getProjectSettings({ type: 'projectSettingsRequest', requestId: 'legacy', nodeId: folderId }, deps);
    expect(result.values.engineWorker).toBe('claude');
    expect(result.sources.engineWorker).toBe('folder');
    expect(result.values.maxClaudeRuns).toBe(4);
    expect(result.sources.maxClaudeRuns).toBe('folder');
  });

  it('persists worktree commands as argv arrays with timeout', async () => {
    const script: ProjectSettingsValues['worktreePrepare'] = { argv: ['npm', 'install'], timeoutMs: 30_000 };
    await setProjectSettings({
      type: 'projectSettingsSet', requestId: 'script', scope: 'project', nodeId: projectId,
      field: 'worktreePrepare', value: script,
    }, deps);
    const result = await getProjectSettings({ type: 'projectSettingsRequest', requestId: 'script-read', nodeId: projectId }, deps);
    expect(result.values.worktreePrepare).toEqual(script);
    expect(result.sources.worktreePrepare).toBe('project');
  });

  it('rejects a worktree program whose path carries a pasted newline, which spawn cannot find', async () => {
    await expect(setProjectSettings({
      type: 'projectSettingsSet', requestId: 'script-newline', scope: 'project', nodeId: projectId,
      field: 'worktreePrepare', value: { argv: ['D:\\DevTools\\Python312\\python.exe\n', 'copy-local-env.py', '.'], timeoutMs: 30_000 },
    }, deps)).rejects.toThrow('Giá trị cài đặt không hợp lệ.');
  });
});

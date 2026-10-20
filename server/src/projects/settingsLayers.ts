import { randomUUID } from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';

import type {
  ProjectSettingField,
  ProjectSettingsClearMessage,
  ProjectSettingsMessage,
  ProjectSettingsRequestMessage,
  ProjectSettingsSetMessage,
  ProjectSettingsSources,
  ProjectSettingsValues,
  ProjectTreeNode,
  SquadSettings,
} from '../../../core/src/messages.js';
import { DurableJsonFile } from '../company/durableJsonFile.js';
import { isRecord } from '../company/typeGuards.js';
import { isSquadSettings, SQUAD_SETTINGS_BOUNDS, SQUAD_SETTINGS_DEFAULT } from '../company/workItems/squadSettings.js';
import type { WorkItemService } from '../company/workItems/workItemService.js';
import { LibraryUserError } from '../library/libraryError.js';
import type { ProjectTreeSnapshot } from './projectTree.js';
import type { ProjectModuleDeps } from './services.js';

interface ProjectSettingsFile {
  readonly version: 1;
  readonly projects: Record<string, Partial<ProjectSettingsValues>>;
  readonly folderOverrides: Record<string, Partial<ProjectSettingsValues>>;
}

interface ParsedProjectSettingsFile extends ProjectSettingsFile {
  readonly corrupt: boolean;
}

export interface ProjectSettingsServices {
  globalSettings(): Promise<Partial<ProjectSettingsValues>>;
  folderSettingsTargets(): Iterable<{
    readonly folder: string;
    current(): SquadSettings;
    apply(next: SquadSettings): Promise<void>;
  }>;
}

export interface ProjectSettingsRuntime {
  globalSettings(): Promise<Partial<ProjectSettingsValues>>;
  workItemServices(): Iterable<{ readonly folder: string; readonly service: WorkItemService }>;
}

/** Adapt active folder work-item services to layered settings reads and scheduler updates. */
export function createProjectSettingsServices(runtime: ProjectSettingsRuntime): ProjectSettingsServices {
  return {
    globalSettings: async () => ({
      engineLeader: SQUAD_SETTINGS_DEFAULT.engineLeader,
      engineJudge: SQUAD_SETTINGS_DEFAULT.engineJudge,
      engineWorker: SQUAD_SETTINGS_DEFAULT.engineWorker,
      claudeModelLeader: SQUAD_SETTINGS_DEFAULT.claudeModelLeader,
      claudeModelJudge: SQUAD_SETTINGS_DEFAULT.claudeModelJudge,
      maxParallel: SQUAD_SETTINGS_DEFAULT.maxParallel,
      maxClaudeRuns: SQUAD_SETTINGS_DEFAULT.maxClaudeRuns,
      maxAgyRuns: SQUAD_SETTINGS_DEFAULT.maxAgyRuns,
      ...(await runtime.globalSettings()),
    }),
    folderSettingsTargets: () => [...runtime.workItemServices()].map(({ folder, service }) => ({
      folder,
      current: () => service.currentSettings(),
      apply: (settings: SquadSettings) => service.setSettings({ requestId: randomUUID(), settings }),
    })),
  };
}
const EMPTY_FILE: ProjectSettingsFile = { version: 1, projects: {}, folderOverrides: {} };
let settingsFileInstance: DurableJsonFile<ParsedProjectSettingsFile> | undefined;
/** Resolved on first use: importing this module must not read the home directory. */
function settingsFile(): DurableJsonFile<ParsedProjectSettingsFile> {
  settingsFileInstance ??= new DurableJsonFile<ParsedProjectSettingsFile>(
    path.join(os.homedir(), '.pixel-agents'),
    'project-settings.json',
    parseSettingsFile,
  );
  return settingsFileInstance;
}
const SETTING_FIELDS: readonly ProjectSettingField[] = [
  'engineLeader', 'engineJudge', 'engineWorker', 'claudeModelLeader', 'claudeModelJudge',
  'maxParallel', 'maxClaudeRuns', 'maxAgyRuns', 'worktreePrepare',
];
const SQUAD_FIELDS: readonly Exclude<ProjectSettingField, 'worktreePrepare'>[] =
  SETTING_FIELDS.filter((field): field is Exclude<ProjectSettingField, 'worktreePrepare'> => field !== 'worktreePrepare');

/** Reapply inherited values after a folder moves between Projects or global settings change. */
export async function refreshProjectSettings(deps: ProjectModuleDeps<ProjectSettingsServices>): Promise<void> {
  await applyEffectiveFolderSettings(deps);
}
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/[\]-]{0,63}$/;

function parseSettingsFile(raw: unknown): ParsedProjectSettingsFile {
  if (raw === null) return { ...EMPTY_FILE, corrupt: false };
  if (!isRecord(raw) || raw.version !== 1 || !isRecord(raw.projects) || !isRecord(raw.folderOverrides)) {
    return { ...EMPTY_FILE, corrupt: true };
  }
  return {
    version: 1,
    projects: raw.projects as Record<string, Partial<ProjectSettingsValues>>,
    folderOverrides: raw.folderOverrides as Record<string, Partial<ProjectSettingsValues>>,
    corrupt: false,
  };
}

function validSetting(field: ProjectSettingField, value: unknown): boolean {
  switch (field) {
    case 'engineLeader':
    case 'engineJudge':
    case 'engineWorker':
      return value === 'omp' || value === 'claude' || value === 'agy';
    case 'claudeModelLeader':
    case 'claudeModelJudge':
      return typeof value === 'string' && MODEL_PATTERN.test(value);
    case 'maxParallel':
      return typeof value === 'number' && Number.isInteger(value) &&
        value >= SQUAD_SETTINGS_BOUNDS.maxParallel.min && value <= SQUAD_SETTINGS_BOUNDS.maxParallel.max;
    case 'maxClaudeRuns':
      return typeof value === 'number' && Number.isInteger(value) &&
        value >= SQUAD_SETTINGS_BOUNDS.maxClaudeRuns.min && value <= SQUAD_SETTINGS_BOUNDS.maxClaudeRuns.max;
    case 'maxAgyRuns':
      return typeof value === 'number' && Number.isInteger(value) &&
        value >= SQUAD_SETTINGS_BOUNDS.maxAgyRuns.min && value <= SQUAD_SETTINGS_BOUNDS.maxAgyRuns.max;
    case 'worktreePrepare': {
      if (!isRecord(value)) return false;
      const argv = value['argv'];
      const timeoutMs = value['timeoutMs'];
      if (!Array.isArray(argv)) return false;
      const argumentsList: unknown[] = argv;
      return argumentsList.length > 0 && argumentsList.length <= 128 &&
        argumentsList.every((arg) => typeof arg === 'string' && arg.length <= 4096 && !arg.includes('\0')) &&
        typeof argumentsList[0] === 'string' && argumentsList[0].length > 0 &&
        typeof timeoutMs === 'number' && Number.isInteger(timeoutMs) &&
        timeoutMs >= 1_000 && timeoutMs <= 600_000;
    }
  }
}

function cleanOverrides(value: unknown): Partial<ProjectSettingsValues> {
  if (!isRecord(value)) return {};
  const clean: Partial<ProjectSettingsValues> = {};
  for (const field of SETTING_FIELDS) {
    const fieldValue = value[field];
    if (validSetting(field, fieldValue)) Object.assign(clean, { [field]: fieldValue });
  }
  return clean;
}

function treeNodes(tree: ProjectTreeSnapshot): Map<string, ProjectTreeNode> {
  return new Map(tree.nodes.map((node) => [node.id, node]));
}

function projectIdFor(nodeId: string, nodes: ReadonlyMap<string, ProjectTreeNode>): string | undefined {
  let node = nodes.get(nodeId);
  while (node !== undefined) {
    if (node.kind === 'project') return node.id;
    node = node.parentId === undefined ? undefined : nodes.get(node.parentId);
  }
  return undefined;
}

function folderPathFor(node: ProjectTreeNode): string {
  if (node.kind !== 'folder' || typeof node.path !== 'string') {
    throw new LibraryUserError('Chỉ có thể sửa cài đặt cho Project hoặc thư mục.');
  }
  return path.resolve(node.path);
}

function legacyFolderOverrides(
  targets: Iterable<{ readonly folder: string; current(): SquadSettings }>,
  folderPath: string,
): Partial<ProjectSettingsValues> {
  for (const target of targets) {
    if (path.resolve(target.folder) !== folderPath) continue;
    const current = target.current();
    const overrides: Partial<ProjectSettingsValues> = {};
    for (const field of SQUAD_FIELDS) {
      const existing = current[field as keyof SquadSettings];
      const fallback = SQUAD_SETTINGS_DEFAULT[field as keyof SquadSettings];
      if (existing !== fallback && validSetting(field, existing)) Object.assign(overrides, { [field]: existing });
    }
    return overrides;
  }
  return {};
}

async function migrateLegacyFolders(
  file: ParsedProjectSettingsFile,
  targets: Iterable<{ readonly folder: string; current(): SquadSettings }>,
): Promise<ParsedProjectSettingsFile> {
  const folderOverrides = { ...file.folderOverrides };
  let changed = false;
  for (const target of targets) {
    const folder = path.resolve(target.folder);
    if (Object.hasOwn(folderOverrides, folder)) continue;
    folderOverrides[folder] = legacyFolderOverrides([target], folder);
    changed = true;
  }
  if (!changed) return file;
  const migrated: ParsedProjectSettingsFile = {
    version: 1,
    projects: file.projects,
    folderOverrides,
    corrupt: false,
  };
  await settingsFile().save({ version: migrated.version, projects: migrated.projects, folderOverrides: migrated.folderOverrides });
  return migrated;
}

/** Return current settings with an independently reported winning source for every field. */
export async function getProjectSettings(
  request: ProjectSettingsRequestMessage,
  deps: ProjectModuleDeps<ProjectSettingsServices>,
): Promise<ProjectSettingsMessage> {
  const tree = await deps.loadTree();
  const nodes = treeNodes(tree);
  const node = request.nodeId === undefined ? undefined : nodes.get(request.nodeId);
  if (request.nodeId !== undefined && node === undefined) throw new LibraryUserError('Không tìm thấy Project hoặc thư mục.');
  const projectId = node === undefined ? undefined : node.kind === 'project' ? node.id : projectIdFor(node.id, nodes);
  const folderPath = node?.kind === 'folder' ? folderPathFor(node) : undefined;
  const file = await migrateLegacyFolders(await settingsFile().load(), deps.services.folderSettingsTargets());
  const global = cleanOverrides(await deps.services.globalSettings());
  const project = projectId === undefined ? {} : cleanOverrides(file.projects[projectId]);
  const folder = folderPath === undefined ? {} : cleanOverrides(file.folderOverrides[folderPath]);
  const values: ProjectSettingsValues = {};
  const sources: ProjectSettingsSources = {};
  for (const field of SETTING_FIELDS) {
    if (Object.hasOwn(folder, field)) {
      Object.assign(values, { [field]: folder[field] });
      Object.assign(sources, { [field]: 'folder' });
    } else if (Object.hasOwn(project, field)) {
      Object.assign(values, { [field]: project[field] });
      Object.assign(sources, { [field]: 'project' });
    } else if (Object.hasOwn(global, field)) {
      Object.assign(values, { [field]: global[field] });
      Object.assign(sources, { [field]: 'global' });
    }
  }
  return {
    type: 'projectSettings',
    requestId: request.requestId,
    ...(request.nodeId === undefined ? {} : { nodeId: request.nodeId }),
    values,
    sources,
  };
}

/** Resolve a node's fully inherited settings for new-session launchers. */
export async function resolveProjectSettings(
  nodeId: string,
  deps: ProjectModuleDeps<ProjectSettingsServices>,
): Promise<ProjectSettingsValues> {
  const result = await getProjectSettings({ type: 'projectSettingsRequest', requestId: '', nodeId }, deps);
  return result.values;
}

/** Persist a validated single-layer override, then refresh every active folder scheduler. */
export async function setProjectSettings(
  request: ProjectSettingsSetMessage,
  deps: ProjectModuleDeps<ProjectSettingsServices>,
): Promise<void> {
  if (!validSetting(request.field, request.value)) throw new LibraryUserError('Giá trị cài đặt không hợp lệ.');
  const tree = await deps.loadTree();
  const nodes = treeNodes(tree);
  const node = nodes.get(request.nodeId);
  if (node === undefined) throw new LibraryUserError('Không tìm thấy Project hoặc thư mục.');
  const file = await migrateLegacyFolders(await settingsFile().load(), deps.services.folderSettingsTargets());
  const projects = { ...file.projects };
  const folderOverrides = { ...file.folderOverrides };
  if (request.scope === 'project') {
    const projectId = node.kind === 'project' ? node.id : projectIdFor(node.id, nodes);
    if (projectId === undefined) throw new LibraryUserError('Không tìm thấy Project.');
    projects[projectId] = { ...cleanOverrides(projects[projectId]), [request.field]: request.value };
  } else {
    const folder = folderPathFor(node);
    folderOverrides[folder] = { ...cleanOverrides(folderOverrides[folder]), [request.field]: request.value };
  }
  await settingsFile().save({ version: 1, projects, folderOverrides });
  await applyEffectiveFolderSettings(deps);
}

/** Remove one explicit override and let the next layer take precedence. */
export async function clearProjectSettings(
  request: ProjectSettingsClearMessage,
  deps: ProjectModuleDeps<ProjectSettingsServices>,
): Promise<void> {
  const tree = await deps.loadTree();
  const nodes = treeNodes(tree);
  const node = nodes.get(request.nodeId);
  if (node === undefined) throw new LibraryUserError('Không tìm thấy Project hoặc thư mục.');
  const file = await migrateLegacyFolders(await settingsFile().load(), deps.services.folderSettingsTargets());
  const projects = { ...file.projects };
  const folderOverrides = { ...file.folderOverrides };
  if (request.scope === 'project') {
    const projectId = node.kind === 'project' ? node.id : projectIdFor(node.id, nodes);
    if (projectId === undefined) throw new LibraryUserError('Không tìm thấy Project.');
    projects[projectId] = withoutField(projects[projectId], request.field);
  } else {
    const folder = folderPathFor(node);
    folderOverrides[folder] = withoutField(folderOverrides[folder], request.field);
  }
  await settingsFile().save({ version: 1, projects, folderOverrides });
  await applyEffectiveFolderSettings(deps);
}

function withoutField(
  value: Partial<ProjectSettingsValues> | undefined,
  field: ProjectSettingField,
): Partial<ProjectSettingsValues> {
  const next = { ...cleanOverrides(value) };
  delete next[field];
  return next;
}

async function applyEffectiveFolderSettings(deps: ProjectModuleDeps<ProjectSettingsServices>): Promise<void> {
  const targets = [...deps.services.folderSettingsTargets()];
  const file = await migrateLegacyFolders(await settingsFile().load(), targets);
  const global = cleanOverrides(await deps.services.globalSettings());
  const tree = await deps.loadTree();
  const nodes = treeNodes(tree);
  const folderByPath = new Map(tree.nodes.filter((node) => node.kind === 'folder' && typeof node.path === 'string')
    .map((node) => [path.resolve(node.path as string), node]));
  for (const target of targets) {
    const folder = path.resolve(target.folder);
    const folderNode = folderByPath.get(folder);
    const projectId = folderNode === undefined ? undefined : projectIdFor(folderNode.id, nodes);
    const resolved = {
      ...global,
      ...(projectId === undefined ? {} : cleanOverrides(file.projects[projectId])),
      ...cleanOverrides(file.folderOverrides[folder]),
    };
    const next: SquadSettings = { ...target.current() };
    for (const field of SQUAD_FIELDS) {
      if (!Object.hasOwn(resolved, field)) continue;
      (next as unknown as Record<string, unknown>)[field] = resolved[field];
    }
    if (isSquadSettings(next)) await target.apply(next);
  }
}


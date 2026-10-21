import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { DurableJsonFile } from '../company/durableJsonFile.js';
import {
  companyFolderNameFor,
  readCompanyFolderNames,
  readRecentCompanyWorkspaces,
} from '../configPersistence.js';
import { LAYOUT_FILE_DIR } from '../constants.js';

export interface ProjectFolderNode {
  readonly id: string;
  readonly type: 'folder';
  readonly path: string;
  readonly name: string;
}

export interface ProjectGroupNode {
  readonly id: string;
  readonly type: 'group';
  name: string;
  readonly children: ProjectNode[];
}

export type ProjectNode = ProjectFolderNode | ProjectGroupNode;

export interface Project {
  readonly id: string;
  name: string;
  color: string;
  order: number;
  children: ProjectNode[];
}

export interface ProjectState {
  readonly version: 1;
  projects: Project[];
}

export interface ProjectStoreOptions {
  readonly filePath?: string;
  readonly canonicalize?: (folderPath: string) => Promise<string>;
  readonly recentFolders?: () => readonly string[];
  readonly folderNames?: () => Readonly<Record<string, string>>;
}

const DEFAULT_COLOR = 'var(--company-project-0)';
const DEFAULT_PROJECT_NAME = 'Mặc định';
const PROJECT_FILE_NAME = 'projects.json';
const DEFAULT_FOLDER_NAME = (folderPath: string): string => path.basename(folderPath) || folderPath;

function parseNode(value: unknown): ProjectNode | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const node = value as { id?: unknown; name?: unknown; type?: unknown; path?: unknown; children?: unknown };
  if (typeof node.id !== 'string' || typeof node.name !== 'string') return null;
  if (node.type === 'folder' && typeof node.path === 'string') {
    return { id: node.id, type: 'folder', path: node.path, name: node.name };
  }
  if (node.type === 'group' && Array.isArray(node.children)) {
    const children = node.children.map(parseNode);
    if (children.some((child) => child === null)) return null;
    return { id: node.id, type: 'group', name: node.name, children: children as ProjectNode[] };
  }
  return null;
}

function parseProject(value: unknown, index: number): Project | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const project = value as {
    id?: unknown; name?: unknown; color?: unknown; order?: unknown; children?: unknown;
  };
  if (
    typeof project.id !== 'string' ||
    typeof project.name !== 'string' ||
    typeof project.color !== 'string' ||
    typeof project.order !== 'number' ||
    !Array.isArray(project.children)
  ) return null;
  const children = project.children.map(parseNode);
  if (children.some((child) => child === null)) return null;
  return {
    id: project.id,
    name: project.name,
    color: project.color,
    order: Number.isFinite(project.order) ? project.order : index,
    children: children as ProjectNode[],
  };
}

function parsedState(raw: unknown): ProjectState & { corrupt: boolean; missing: boolean } {
  if (raw === null) return { version: 1, projects: [], corrupt: false, missing: true };
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { version: 1, projects: [], corrupt: true, missing: false };
  }
  const state = raw as { version?: unknown; projects?: unknown };
  if (state.version !== 1 || !Array.isArray(state.projects)) {
    return { version: 1, projects: [], corrupt: true, missing: false };
  }
  const projects = state.projects.map(parseProject);
  if (projects.some((project) => project === null)) {
    return { version: 1, projects: [], corrupt: true, missing: false };
  }
  return {
    version: 1,
    projects: (projects as Project[]).sort((a, b) => a.order - b.order),
    corrupt: false,
    missing: false,
  };
}


function walk(nodes: readonly ProjectNode[], visit: (node: ProjectNode) => boolean): boolean {
  for (const node of nodes) {
    if (visit(node)) return true;
    if (node.type === 'group' && walk(node.children, visit)) return true;
  }
  return false;
}

function findParentList(projects: Project[], nodeId: string): ProjectNode[] | null {
  for (const project of projects) {
    if (project.children.some((node) => node.id === nodeId)) return project.children;
    let found: ProjectNode[] | null = null;
    walk(project.children, (node) => {
      if (node.type === 'group' && node.children.some((child) => child.id === nodeId)) {
        found = node.children;
        return true;
      }
      return false;
    });
    if (found !== null) return found;
  }
  return null;
}

export class ProjectStore {
  private readonly file: DurableJsonFile<ProjectState & { corrupt: boolean; missing: boolean }>;
  private readonly canonicalize: (folderPath: string) => Promise<string>;
  private readonly recentFolders: () => readonly string[];
  private readonly folderNames: () => Readonly<Record<string, string>>;
  private state: ProjectState = { version: 1, projects: [] };
  private loaded = false;
  private serial: Promise<void> = Promise.resolve();

  constructor(options: ProjectStoreOptions = {}) {
    const filePath = options.filePath ?? path.join(os.homedir(), LAYOUT_FILE_DIR, PROJECT_FILE_NAME);
    this.file = new DurableJsonFile(path.dirname(filePath), path.basename(filePath), parsedState);
    this.canonicalize = options.canonicalize ?? (async (candidate) => {
      const absolute = path.resolve(candidate);
      try { return await fs.realpath(absolute); } catch { return absolute; }
    });
    this.recentFolders = options.recentFolders ?? readRecentCompanyWorkspaces;
    this.folderNames = options.folderNames ?? readCompanyFolderNames;
  }

  async load(): Promise<ProjectState> {
    await this.exclusive(async () => {
      if (this.loaded) return;
      const parsed = await this.file.load();
      this.state = { version: 1, projects: parsed.projects };
      if (parsed.missing) {
        this.state = { version: 1, projects: await this.migrateRecentFolders() };
        await this.persist();
      }
      this.loaded = true;
    });
    return this.snapshot();
  }

  snapshot(): ProjectState {
    return structuredClone(this.state);
  }

  async createProject(name: string, color = DEFAULT_COLOR): Promise<Project> {
    return this.change(async () => {
      const project: Project = {
        id: randomUUID(), name: this.requiredName(name), color, order: this.state.projects.length, children: [],
      };
      this.state.projects.push(project);
      return structuredClone(project);
    });
  }

  async renameProject(projectId: string, name: string): Promise<Project> {
    return this.change(async () => {
      const project = this.requireProject(projectId);
      project.name = this.requiredName(name);
      return structuredClone(project);
    });
  }
  async moveProject(projectId: string, index: number): Promise<void> {
    await this.change(async () => {
      const sourceIndex = this.state.projects.findIndex((project) => project.id === projectId);
      if (sourceIndex < 0) throw new Error('Không tìm thấy Project cần di chuyển.');
      const [project] = this.state.projects.splice(sourceIndex, 1);
      if (project === undefined) throw new Error('Không tìm thấy Project cần di chuyển.');
      const targetIndex = Math.max(0, Math.min(index, this.state.projects.length));
      this.state.projects.splice(targetIndex, 0, project);
    });
  }

  async deleteProject(projectId: string): Promise<void> {
    await this.change(async () => {
      const index = this.state.projects.findIndex((project) => project.id === projectId);
      if (index < 0) throw new Error('Không tìm thấy Project.');
      this.state.projects.splice(index, 1);
      this.state.projects.forEach((project, order) => { project.order = order; });
    });
  }

  async addFolder(projectId: string, folderPath: string, parentGroupId?: string): Promise<ProjectFolderNode> {
    return this.change(async () => {
      const canonicalPath = await this.canonicalize(folderPath);
      const stat = await fs.stat(canonicalPath);
      if (!stat.isDirectory()) throw new Error('Đường dẫn phải là thư mục.');
      if (this.folderPathExists(canonicalPath)) throw new Error('Thư mục này đã có trong cây Project.');
      const node: ProjectFolderNode = {
        id: randomUUID(), type: 'folder', path: canonicalPath,
        name: companyFolderNameFor(this.folderNames(), canonicalPath) ?? DEFAULT_FOLDER_NAME(canonicalPath),
      };
      this.targetChildren(projectId, parentGroupId).push(node);
      return node;
    });
  }

  async removeFolder(nodeId: string): Promise<void> {
    await this.removeNode(nodeId, 'folder');
  }

  async createGroup(projectId: string, name: string, parentGroupId?: string): Promise<ProjectGroupNode> {
    return this.change(async () => {
      const group: ProjectGroupNode = {
        id: randomUUID(), type: 'group', name: this.requiredName(name), children: [],
      };
      this.targetChildren(projectId, parentGroupId).push(group);
      return structuredClone(group);
    });
  }

  async renameGroup(groupId: string, name: string): Promise<ProjectGroupNode> {
    return this.change(async () => {
      const group = this.requireNode(groupId, 'group') as ProjectGroupNode;
      group.name = this.requiredName(name);
      return structuredClone(group);
    });
  }

  /** Sets a folder's display name; its path stays. */
  async renameFolder(folderId: string, name: string): Promise<void> {
    await this.change(async () => {
      const folder = this.requireNode(folderId, 'folder');
      const siblings = findParentList(this.state.projects, folderId);
      const index = siblings?.findIndex((node) => node.id === folderId) ?? -1;
      if (siblings === null || index < 0) throw new Error('Không tìm thấy thư mục.');
      siblings[index] = { ...folder, name: this.requiredName(name) };
    });
  }

  async deleteGroup(groupId: string): Promise<void> {
    await this.removeNode(groupId, 'group');
  }

  async moveNode(nodeId: string, targetProjectId: string, targetGroupId?: string, index?: number): Promise<void> {
    await this.change(async () => {
      const source = findParentList(this.state.projects, nodeId);
      if (source === null) throw new Error('Không tìm thấy nút cần di chuyển.');
      const nodeIndex = source.findIndex((node) => node.id === nodeId);
      const node = source[nodeIndex];
      if (node === undefined) throw new Error('Không tìm thấy nút cần di chuyển.');
      source.splice(nodeIndex, 1);
      if (
        node.type === 'group' &&
        targetGroupId !== undefined &&
        walk([node], (candidate) => candidate.id === targetGroupId)
      ) {
        source.splice(nodeIndex, 0, node);
        throw new Error('Không thể di chuyển nhóm vào chính nó hoặc nhóm con.');
      }
      const target = this.targetChildren(targetProjectId, targetGroupId);
      const targetIndex = index === undefined ? target.length : Math.max(0, Math.min(index, target.length));
      target.splice(targetIndex, 0, node);
    });
  }

  private async removeNode(nodeId: string, expected: ProjectNode['type']): Promise<void> {
    await this.change(async () => {
      const parent = findParentList(this.state.projects, nodeId);
      const index = parent?.findIndex((node) => node.id === nodeId) ?? -1;
      if (parent === null || index < 0 || parent[index]?.type !== expected) throw new Error(`Không tìm thấy ${expected === 'folder' ? 'thư mục' : 'nhóm'}.`);
      const [removed] = parent.splice(index, 1);
      // A group is only an arrangement: deleting it lifts its children into
      // its place instead of dropping the folders they hold.
      if (removed?.type === 'group') parent.splice(index, 0, ...removed.children);
    });
  }

  private async migrateRecentFolders(): Promise<Project[]> {
    const children: ProjectNode[] = [];
    const seen = new Set<string>();
    for (const recent of this.recentFolders()) {
      const canonical = await this.canonicalize(recent);
      const key = process.platform === 'win32' ? canonical.toLocaleLowerCase('en-US') : canonical;
      if (seen.has(key)) continue;
      seen.add(key);
      try {
        if (!(await fs.stat(canonical)).isDirectory()) continue;
      } catch {
        continue;
      }
      children.push({
        id: randomUUID(), type: 'folder', path: canonical,
        name: companyFolderNameFor(this.folderNames(), canonical) ?? DEFAULT_FOLDER_NAME(canonical),
      });
    }
    if (children.length === 0) return [];
    return [{ id: randomUUID(), name: DEFAULT_PROJECT_NAME, color: DEFAULT_COLOR, order: 0, children }];
  }

  private targetChildren(projectId: string, groupId?: string): ProjectNode[] {
    const project = this.requireProject(projectId);
    if (groupId === undefined) return project.children;
    const group = this.requireNode(groupId, 'group') as ProjectGroupNode;
    if (!walk(project.children, (node) => node.id === groupId)) throw new Error('Nhóm đích không thuộc Project đã chọn.');
    return group.children;
  }

  private requireProject(projectId: string): Project {
    const project = this.state.projects.find((candidate) => candidate.id === projectId);
    if (project === undefined) throw new Error('Không tìm thấy Project.');
    return project;
  }

  private requireNode(nodeId: string, type: ProjectNode['type']): ProjectNode {
    let found: ProjectNode | undefined;
    for (const project of this.state.projects) walk(project.children, (node) => {
      if (node.id === nodeId) { found = node; return true; }
      return false;
    });
    if (found === undefined || found.type !== type) throw new Error(`Không tìm thấy ${type === 'group' ? 'nhóm' : 'thư mục'}.`);
    return found;
  }

  private folderPathExists(canonicalPath: string): boolean {
    const needle = process.platform === 'win32' ? canonicalPath.toLocaleLowerCase('en-US') : canonicalPath;
    return this.state.projects.some((project) => walk(project.children, (node) =>
      node.type === 'folder' && (process.platform === 'win32' ? node.path.toLocaleLowerCase('en-US') : node.path) === needle,
    ));
  }

  private requiredName(name: string): string {
    const value = name.trim();
    if (value.length === 0 || value.length > 120) throw new Error('Tên không được để trống và tối đa 120 ký tự.');
    return value;
  }

  private async change<T>(operation: () => Promise<T>): Promise<T> {
    await this.load();
    return this.exclusive(async () => {
      const previous = structuredClone(this.state);
      try {
        const result = await operation();
        this.state.projects.forEach((project, order) => { project.order = order; });
        await this.persist();
        return result;
      } catch (error) {
        this.state = previous;
        throw error;
      }
    });
  }

  private async persist(): Promise<void> {
    await this.file.save(this.state);
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const previous = this.serial;
    this.serial = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await operation(); } finally { release(); }
  }
}

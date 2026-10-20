import type {
  ProjectCommandResultMessage,
  ProjectCommentMessage,
  ProjectDiffRequestMessage,
  ProjectMergePreviewRequestMessage,
  ProjectNodeCreateMessage,
  ProjectNodeDeleteMessage,
  ProjectNodeMoveMessage,
  ProjectNodeUpdateMessage,
  ProjectSessionStartMessage,
  ProjectSettingsClearMessage,
  ProjectSettingsRequestMessage,
  ProjectSettingsSetMessage,
  ServerMessage,
} from '../../../core/src/messages.js';
import { LibraryUserError } from '../library/libraryError.js';
import type { AgentState } from '../types.js';
import { sendProjectComment } from './comments.js';
import { getProjectDiff } from './diff.js';
import { previewProjectMerge } from './mergePreview.js';
import { startProjectSession } from './newSession.js';
import { type ProjectNode, type ProjectState, ProjectStore } from './projectStore.js';
import {
  buildProjectTreeSnapshot,
  type HerdrProjectSession,
  type ProjectTreeOptions,
  type ProjectTreeSnapshot,
} from './projectTree.js';
import type { ProjectModuleDeps, ProjectServices } from './services.js';
import { clearProjectSettings, getProjectSettings, refreshProjectSettings, setProjectSettings } from './settingsLayers.js';

const FALLBACK_REQUEST_ID = '00000000-0000-4000-8000-000000000000';
const REQUEST_TYPES: Record<string, true> = {
  projectTreeRequest: true,
  projectNodeCreate: true,
  projectNodeUpdate: true,
  projectNodeDelete: true,
  projectNodeMove: true,
  projectDiffRequest: true,
  projectComment: true,
  projectSettingsRequest: true,
  projectSettingsSet: true,
  projectSettingsClear: true,
  projectSessionStart: true,
  projectMergePreviewRequest: true,
};
let defaultStore: ProjectStore | undefined;

function projectStoreFor(context: ProjectCommandContext): ProjectStore {
  if (context.store !== undefined) return context.store;
  defaultStore ??= new ProjectStore();
  return defaultStore;
}

export interface ProjectCommandContext {
  readonly privileged: boolean;
  readonly store?: ProjectStore;
  readonly tree?: ProjectTreeOptions;
  readonly agents?: Iterable<AgentState>;
  readonly herdrSessions?: () => readonly HerdrProjectSession[];
  readonly services?: ProjectServices;
}

/** Module deps for one phase-two command; throws a user error when its service is not wired. */
function depsFor<S>(
  store: ProjectStore,
  context: ProjectCommandContext,
  services: S | undefined,
): ProjectModuleDeps<S> {
  if (services === undefined) throw new LibraryUserError('Chức năng chưa được kết nối.');
  return { store, loadTree: () => buildTree(store, context), services };
}

/** Handles project tree, mutations and phase-two commands. Returns false for other messages. */
export function handleProjectMessage(
  msg: Record<string, unknown>,
  send: (message: ServerMessage) => void,
  context: ProjectCommandContext,
): boolean {
  if (typeof msg.type !== 'string' || REQUEST_TYPES[msg.type] !== true) return false;
  const requestId = typeof msg.requestId === 'string' ? msg.requestId : FALLBACK_REQUEST_ID;
  if (!context.privileged) {
    const reason = 'Chỉ kết nối được cấp quyền mới được quản lý Project.';
    if (msg.type === 'projectMergePreviewRequest') {
      send(mergePreviewFailure(msg, requestId, reason));
    } else {
      send(commandResult(requestId, commandFor(msg.type), false, reason));
    }
    return true;
  }
  void runProjectRequest(msg, requestId, send, context);
  return true;
}

async function runProjectRequest(
  msg: Record<string, unknown>,
  requestId: string,
  send: (message: ServerMessage) => void,
  context: ProjectCommandContext,
): Promise<void> {
  const type = typeof msg.type === 'string' ? msg.type : '';
  const store = projectStoreFor(context);
  try {
    switch (msg.type) {
      case 'projectTreeRequest': {
        const snapshot = await buildTree(store, context);
        send({ type: 'projectTreeSnapshot', requestId, nodes: snapshot.nodes });
        return;
      }
      case 'projectNodeCreate': {
        const request = msg as unknown as ProjectNodeCreateMessage;
        let nodeId: string;
        if (request.kind === 'project') {
          nodeId = (await store.createProject(request.name)).id;
        } else {
          const target = targetForParent(await store.load(), request.parentId);
          if (request.kind === 'folder') {
            if (typeof request.path !== 'string' || request.path.trim() === '') throw new LibraryUserError('Đường dẫn thư mục không hợp lệ.');
            nodeId = (await store.addFolder(target.projectId, request.path, target.groupId)).id;
          } else {
            nodeId = (await store.createGroup(target.projectId, request.name, target.groupId)).id;
          }
        }
        send(commandResult(requestId, 'create', true, '', nodeId));
        await sendTreeSnapshot(requestId, send, store, context);
        return;
      }
      case 'projectNodeUpdate': {
        const request = msg as unknown as ProjectNodeUpdateMessage;
        const state = await store.load();
        if (state.projects.some((candidate) => candidate.id === request.nodeId)) {
          await store.renameProject(request.nodeId, request.name);
        } else {
          const node = findNode(state.projects.flatMap((project) => project.children), request.nodeId);
          if (node?.type !== 'group') throw new LibraryUserError('Không tìm thấy nhóm cần đổi tên.');
          await store.renameGroup(request.nodeId, request.name);
        }
        send(commandResult(requestId, 'update', true, '', request.nodeId));
        await sendTreeSnapshot(requestId, send, store, context);
        return;
      }
      case 'projectNodeDelete': {
        const request = msg as unknown as ProjectNodeDeleteMessage;
        const state = await store.load();
        if (state.projects.some((candidate) => candidate.id === request.nodeId)) {
          await store.deleteProject(request.nodeId);
        } else {
          const node = findNode(state.projects.flatMap((project) => project.children), request.nodeId);
          if (node?.type === 'folder') await store.removeFolder(request.nodeId);
          else if (node?.type === 'group') await store.deleteGroup(request.nodeId);
          else throw new LibraryUserError('Không tìm thấy nút cần xóa.');
        }
        send(commandResult(requestId, 'delete', true, '', request.nodeId));
        await sendTreeSnapshot(requestId, send, store, context);
        return;
      }
      case 'projectNodeMove': {
        const request = msg as unknown as ProjectNodeMoveMessage;
        const state = await store.load();
        if (
          request.parentId === undefined &&
          state.projects.some((project) => project.id === request.nodeId)
        ) {
          await store.moveProject(request.nodeId, request.index ?? state.projects.length - 1);
        } else {
          const target = targetForParent(state, request.parentId);
          await store.moveNode(request.nodeId, target.projectId, target.groupId, request.index);
        }
        send(commandResult(requestId, 'move', true, '', request.nodeId));
        // A folder that changed Project inherits different values: reapply them.
        if (context.services?.settings !== undefined) {
          await refreshProjectSettings(depsFor(store, context, context.services.settings));
        }
        await sendTreeSnapshot(requestId, send, store, context);
        return;
      }
      case 'projectDiffRequest': {
        const deps = depsFor(store, context, context.services?.diff);
        const result = await getProjectDiff(msg as unknown as ProjectDiffRequestMessage, deps);
        send({ ...result, requestId });
        return;
      }
      case 'projectComment':
        await sendProjectComment(msg as unknown as ProjectCommentMessage, depsFor(store, context, context.services?.comments));
        send(commandResult(requestId, 'comment', true, ''));
        return;
      case 'projectSettingsRequest': {
        const deps = depsFor(store, context, context.services?.settings);
        const result = await getProjectSettings(msg as unknown as ProjectSettingsRequestMessage, deps);
        send({ ...result, requestId });
        return;
      }
      case 'projectSettingsSet':
        await setProjectSettings(msg as unknown as ProjectSettingsSetMessage, depsFor(store, context, context.services?.settings));
        send(commandResult(requestId, 'settingsSet', true, ''));
        return;
      case 'projectSettingsClear':
        await clearProjectSettings(msg as unknown as ProjectSettingsClearMessage, depsFor(store, context, context.services?.settings));
        send(commandResult(requestId, 'settingsClear', true, ''));
        return;
      case 'projectSessionStart': {
        const deps = depsFor(store, context, context.services?.session);
        const result = await startProjectSession(msg as unknown as ProjectSessionStartMessage, deps);
        send({ ...result, requestId });
        await sendTreeSnapshot(requestId, send, store, context);
        return;
      }
      case 'projectMergePreviewRequest': {
        const deps = depsFor(store, context, context.services?.mergePreview);
        const result = await previewProjectMerge(msg as unknown as ProjectMergePreviewRequestMessage, deps);
        send({ ...result, requestId });
        return;
      }
    }
  } catch (error) {
    const reason = error instanceof LibraryUserError ? error.message : safeReason(type);
    if (msg.type === 'projectMergePreviewRequest') {
      send(mergePreviewFailure(msg, requestId, reason));
    } else if (msg.type === 'projectTreeRequest') {
      send(commandResult(requestId, 'create', false, reason));
    } else if (msg.type === 'projectSessionStart') {
      send({ type: 'projectSessionStartResult', requestId, ok: false, reason });
    } else if (msg.type === 'projectSettingsRequest') {
      send({
        type: 'projectSettings', requestId,
        ...(typeof msg.nodeId === 'string' ? { nodeId: msg.nodeId } : {}), values: {}, sources: {},
      });
    } else if (msg.type === 'projectDiffRequest') {
      send({
        type: 'projectDiff', requestId,
        checkout: typeof msg.checkout === 'string' ? msg.checkout : '',
        scope: isDiffScope(msg.scope) ? msg.scope : 'uncommitted', sha: '', files: [], truncated: false, reason,
      });
    } else {
      send(commandResult(requestId, commandFor(type), false, reason, typeof msg.nodeId === 'string' ? msg.nodeId : undefined));
    }
  }
}

/** A tree build runs git across every checkout; sockets refreshing together share one. */
const TREE_REUSE_MS = 3_000;
const treeBuilds = new WeakMap<ProjectStore, { readonly at: number; readonly build: Promise<ProjectTreeSnapshot> }>();

async function buildTree(store: ProjectStore, context: ProjectCommandContext): Promise<ProjectTreeSnapshot> {
  if (context.tree === undefined) throw new LibraryUserError('Không thể tải cây Project vì dữ liệu phiên chưa được kết nối.');
  const recent = treeBuilds.get(store);
  if (recent !== undefined && Date.now() - recent.at < TREE_REUSE_MS) return recent.build;
  const build = buildProjectTreeSnapshot(store, {
    ...context.tree,
    ...(context.agents === undefined ? {} : { agents: context.agents }),
    ...(context.herdrSessions === undefined ? {} : { herdrSessions: context.herdrSessions }),
  });
  treeBuilds.set(store, { at: Date.now(), build });
  // A failed build must not be served to the next request.
  build.catch(() => {
    if (treeBuilds.get(store)?.build === build) treeBuilds.delete(store);
  });
  return build;
}

/** Sends a fresh snapshot after a change; a reused one would show the tree from before it. */
async function sendTreeSnapshot(
  requestId: string,
  send: (message: ServerMessage) => void,
  store: ProjectStore,
  context: ProjectCommandContext,
): Promise<void> {
  if (context.tree === undefined) return;
  treeBuilds.delete(store);
  const snapshot = await buildTree(store, context);
  send({ type: 'projectTreeSnapshot', requestId, nodes: snapshot.nodes });
}

interface ProjectNodeTarget {
  readonly projectId: string;
  readonly groupId?: string;
}

function targetForParent(state: ProjectState, parentId: string | undefined): ProjectNodeTarget {
  if (parentId === undefined) throw new LibraryUserError('Chọn Project hoặc nhóm đích.');
  const project = state.projects.find((candidate) => candidate.id === parentId);
  if (project !== undefined) return { projectId: project.id };
  for (const candidate of state.projects) {
    const group = findNode(candidate.children, parentId);
    if (group?.type === 'group') return { projectId: candidate.id, groupId: group.id };
  }
  throw new LibraryUserError('Không tìm thấy Project hoặc nhóm đích.');
}
function findNode(nodes: readonly ProjectNode[], nodeId: string): ProjectNode | undefined {
  for (const node of nodes) {
    if (node.id === nodeId) return node;
    if (node.type === 'group') {
      const found = findNode(node.children, nodeId);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

function commandFor(type: string): ProjectCommandResultMessage['command'] {
  switch (type) {
    case 'projectNodeCreate': return 'create';
    case 'projectNodeUpdate': return 'update';
    case 'projectNodeDelete': return 'delete';
    case 'projectNodeMove': return 'move';
    case 'projectComment': return 'comment';
    case 'projectSettingsClear': return 'settingsClear';
    default: return 'settingsSet';
  }
}

function commandResult(
  requestId: string,
  command: ProjectCommandResultMessage['command'],
  ok: boolean,
  reason: string,
  nodeId?: string,
): ProjectCommandResultMessage {
  return {
    type: 'projectCommandResult', requestId, command, ok,
    ...(nodeId === undefined ? {} : { nodeId }), ...(reason === '' ? {} : { reason }),
  };
}

function safeReason(type: string): string {
  switch (type) {
    case 'projectNodeCreate': return 'Không thể tạo nút Project.';
    case 'projectNodeUpdate': return 'Không thể cập nhật nút Project.';
    case 'projectNodeDelete': return 'Không thể xóa nút Project.';
    case 'projectNodeMove': return 'Không thể di chuyển nút Project.';
    case 'projectComment': return 'Không thể gửi bình luận.';
    case 'projectSettingsSet':
    case 'projectSettingsClear': return 'Không thể cập nhật cài đặt Project.';
    default: return 'Không thể thực hiện yêu cầu Project.';
  }
}

function mergePreviewFailure(
  msg: Record<string, unknown>,
  requestId: string,
  reason: string,
): ServerMessage {
  return {
    type: 'projectMergePreviewResult',
    requestId,
    repo: typeof msg.repo === 'string' ? msg.repo : '',
    branchA: typeof msg.branchA === 'string' ? msg.branchA : '',
    branchB: typeof msg.branchB === 'string' ? msg.branchB : '',
    clean: false,
    conflicts: [],
    reason,
  };
}

function isDiffScope(value: unknown): value is 'uncommitted' | 'branch' | 'commit' {
  return value === 'uncommitted' || value === 'branch' || value === 'commit';
}

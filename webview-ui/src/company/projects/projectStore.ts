import { useSyncExternalStore } from 'react';

import type {
  ClientMessage,
  ProjectCommandResultMessage,
  ProjectCommentMessage,
  ProjectDiffMessage,
  ProjectDiffRequestMessage,
  ProjectMergePreviewRequestMessage,
  ProjectMergePreviewResultMessage,
  ProjectNodeCreateMessage,
  ProjectNodeDeleteMessage,
  ProjectNodeMoveMessage,
  ProjectNodeUpdateMessage,
  ProjectSessionStartMessage,
  ProjectSessionStartResultMessage,
  ProjectSettingsClearMessage,
  ProjectSettingsMessage,
  ProjectSettingsRequestMessage,
  ProjectSettingsSetMessage,
  ProjectTreeNode,
  ProjectTreeRequestMessage,
  ProjectTreeSnapshotMessage,
  ServerMessage,
} from '../../../../core/src/messages.js';
import { newRequestId as defaultRequestId } from '../companyMessages.js';

export type ProjectServerMessage =
  | ProjectTreeSnapshotMessage
  | ProjectDiffMessage
  | ProjectSettingsMessage
  | ProjectCommandResultMessage
  | ProjectSessionStartResultMessage
  | ProjectMergePreviewResultMessage;
type ProjectRequest =
  | ProjectTreeRequestMessage
  | ProjectDiffRequestMessage
  | ProjectSettingsRequestMessage
  | ProjectNodeCreateMessage
  | ProjectNodeUpdateMessage
  | ProjectNodeDeleteMessage
  | ProjectNodeMoveMessage
  | ProjectSettingsSetMessage
  | ProjectSettingsClearMessage
  | ProjectSessionStartMessage
  | ProjectCommentMessage
  | ProjectMergePreviewRequestMessage;

export interface ProjectState {
  nodes: readonly ProjectTreeNode[];
  diff: ProjectDiffMessage | null;
  settings: ProjectSettingsMessage | null;
  pending: Readonly<Record<string, ProjectRequest>>;
  results: Readonly<Record<string, ProjectCommandResultMessage | ProjectSessionStartResultMessage | ProjectMergePreviewResultMessage>>;
  errors: Readonly<Record<string, string>>;
}
export interface ProjectStoreOptions { send: (message: ClientMessage) => void; newRequestId?: () => string; }
export interface ProjectStore {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => ProjectState;
  accept: (message: ServerMessage) => void;
  requestTree: () => string;
  requestDiff: (input: Omit<ProjectDiffRequestMessage, 'type' | 'requestId'>) => string;
  requestSettings: (nodeId?: string) => string;
  createNode: (input: Omit<ProjectNodeCreateMessage, 'type' | 'requestId'>) => string;
  updateNode: (input: Omit<ProjectNodeUpdateMessage, 'type' | 'requestId'>) => string;
  deleteNode: (nodeId: string) => string;
  moveNode: (input: Omit<ProjectNodeMoveMessage, 'type' | 'requestId'>) => string;
  setSetting: (input: Omit<ProjectSettingsSetMessage, 'type' | 'requestId'>) => string;
  clearSetting: (input: Omit<ProjectSettingsClearMessage, 'type' | 'requestId'>) => string;
  startSession: (input: Omit<ProjectSessionStartMessage, 'type' | 'requestId'>) => string;
  sendComment: (input: Omit<ProjectCommentMessage, 'type' | 'requestId'>) => string;
  previewMerge: (input: Omit<ProjectMergePreviewRequestMessage, 'type' | 'requestId'>) => string;
}

export function isProjectServerMessage(message: ServerMessage): message is ProjectServerMessage {
  return message.type === 'projectTreeSnapshot' || message.type === 'projectDiff' || message.type === 'projectSettings' || message.type === 'projectCommandResult' || message.type === 'projectSessionStartResult' || message.type === 'projectMergePreviewResult';
}

export function createProjectStore(options: ProjectStoreOptions): ProjectStore {
  const requestId = options.newRequestId ?? defaultRequestId;
  let state: ProjectState = { nodes: [], diff: null, settings: null, pending: {}, results: {}, errors: {} };
  const listeners = new Set<() => void>();
  const latest = new Map<string, string>();
  const commit = (next: ProjectState) => { if (next === state) return; state = next; for (const listener of listeners) listener(); };
  function transmit<T extends ProjectRequest>(request: T, key: string): string {
    const pending = { ...state.pending };
    const prior = latest.get(key);
    if (prior !== undefined) delete pending[prior];
    pending[request.requestId] = request;
    latest.set(key, request.requestId);
    commit({ ...state, pending, errors: { ...state.errors, [key]: '' } });
    try { options.send(request); } catch (error) {
      const nextPending = { ...state.pending }; delete nextPending[request.requestId];
      const errors = { ...state.errors, [key]: error instanceof Error ? error.message : String(error) };
      commit({ ...state, pending: nextPending, errors });
    }
    return request.requestId;
  }
  function accept(message: ServerMessage): void {
    if (!isProjectServerMessage(message)) return;
    // The tree is pushed unasked (sessions start and stop) and may come twice per
    // request (quick, then full): every snapshot is the latest state.
    if (message.type === 'projectTreeSnapshot') {
      const pending = { ...state.pending };
      delete pending[message.requestId];
      if (latest.get('tree') === message.requestId) latest.delete('tree');
      commit({ ...state, nodes: message.nodes, pending });
      return;
    }
    const request = state.pending[message.requestId];
    if (request === undefined) return;
    const key = latestKey(request);
    if (latest.get(key) !== message.requestId) return;
    const pending = { ...state.pending }; delete pending[message.requestId]; latest.delete(key);
    const errors = { ...state.errors };
    if ('reason' in message && message.reason) errors[key] = message.reason; else delete errors[key];
    if (message.type === 'projectDiff') commit({ ...state, diff: message, pending, errors });
    else if (message.type === 'projectSettings') commit({ ...state, settings: message, pending, errors });
    else commit({ ...state, results: { ...state.results, [message.requestId]: message }, pending, errors });
  }
  function latestKey(request: ProjectRequest): string {
    switch (request.type) {
      case 'projectTreeRequest': return 'tree';
      case 'projectDiffRequest': return `diff:${request.checkout}:${request.scope}:${request.sha}`;
      case 'projectSettingsRequest': return `settings:${request.nodeId ?? ''}`;
      case 'projectNodeCreate': return 'command:create';
      case 'projectNodeUpdate': return `command:update:${request.nodeId}`;
      case 'projectNodeDelete': return `command:delete:${request.nodeId}`;
      case 'projectNodeMove': return `command:move:${request.nodeId}`;
      case 'projectSettingsSet': return `command:settingsSet:${request.nodeId}:${request.field}`;
      case 'projectSettingsClear': return `command:settingsClear:${request.nodeId}:${request.field}`;
      case 'projectSessionStart': return 'sessionStart';
      case 'projectComment': return `comment:${request.requestId}`;
      case 'projectMergePreviewRequest': return `merge:${request.repo}:${request.branchA}:${request.branchB}`;
    }
  }
  return {
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    getSnapshot: () => state, accept,
    requestTree: () => transmit({ type: 'projectTreeRequest', requestId: requestId() }, 'tree'),
    requestDiff: (input) => { const req = { ...input, type: 'projectDiffRequest' as const, requestId: requestId() }; return transmit(req, latestKey(req)); },
    requestSettings: (nodeId) => { const req = { type: 'projectSettingsRequest' as const, requestId: requestId(), ...(nodeId === undefined ? {} : { nodeId }) }; return transmit(req, latestKey(req)); },
    createNode: (input) => { const req = { ...input, type: 'projectNodeCreate' as const, requestId: requestId() }; return transmit(req, latestKey(req)); },
    updateNode: (input) => { const req = { ...input, type: 'projectNodeUpdate' as const, requestId: requestId() }; return transmit(req, latestKey(req)); },
    deleteNode: (nodeId) => { const req = { type: 'projectNodeDelete' as const, requestId: requestId(), nodeId }; return transmit(req, latestKey(req)); },
    moveNode: (input) => { const req = { ...input, type: 'projectNodeMove' as const, requestId: requestId() }; return transmit(req, latestKey(req)); },
    setSetting: (input) => { const req = { ...input, type: 'projectSettingsSet' as const, requestId: requestId() }; return transmit(req, latestKey(req)); },
    startSession: (input) => { const req = { ...input, type: 'projectSessionStart' as const, requestId: requestId() }; return transmit(req, latestKey(req)); },
    sendComment: (input) => { const req = { ...input, type: 'projectComment' as const, requestId: requestId() }; return transmit(req, latestKey(req)); },
    previewMerge: (input) => { const req = { ...input, type: 'projectMergePreviewRequest' as const, requestId: requestId() }; return transmit(req, latestKey(req)); },
    clearSetting: (input) => {
      const req = { ...input, type: 'projectSettingsClear' as const, requestId: requestId() };
      return transmit(req, latestKey(req));
    },
  };
}
export function useProjectState(store: ProjectStore): ProjectState { return useSyncExternalStore(store.subscribe, store.getSnapshot); }

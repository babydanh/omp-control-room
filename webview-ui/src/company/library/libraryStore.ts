import { useSyncExternalStore } from 'react';

import type {
  ClientMessage,
  LibraryAccountLogin,
  LibraryAccountsSnapshot,
  LibraryClaudeRoleSet,
  LibraryClaudeRolesSnapshot,
  LibraryCommandResult,
  LibraryMcpCheckRequest,
  LibraryMcpSnapshot,
  LibrarySkillPreview,
  LibrarySkillPreviewRequest,
  LibrarySkillsSnapshot,
  LibrarySnapshotRequest,
  LibraryStorageSearchRequest,
  LibraryStorageSearchResult,
  LibraryWorkItemRestore,
  ServerMessage,
} from '../../../../core/src/messages.js';
import { newRequestId as defaultRequestId } from '../companyMessages.js';

export type LibrarySection = LibrarySnapshotRequest['section'];
export type LibraryStorageKind = LibraryStorageSearchRequest['kind'];

type LibraryRequest =
  | LibrarySnapshotRequest
  | LibraryClaudeRoleSet
  | LibrarySkillPreviewRequest
  | LibraryStorageSearchRequest
  | LibraryWorkItemRestore
  | LibraryAccountLogin
  | LibraryMcpCheckRequest;

export type LibraryServerMessage =
  | LibraryAccountsSnapshot
  | LibraryClaudeRolesSnapshot
  | LibrarySkillsSnapshot
  | LibraryMcpSnapshot
  | LibraryStorageSearchResult
  | LibrarySkillPreview
  | LibraryCommandResult;

export interface LibraryState {
  accounts: LibraryAccountsSnapshot | null;
  claudeRoles: LibraryClaudeRolesSnapshot | null;
  skills: LibrarySkillsSnapshot | null;
  mcp: LibraryMcpSnapshot | null;
  storage: Partial<Record<LibraryStorageKind, LibraryStorageSearchResult>>;
  previews: Readonly<Record<string, LibrarySkillPreview>>;
  commandResults: Readonly<Record<string, LibraryCommandResult>>;
  pending: Readonly<Record<string, LibraryRequest>>;
  errors: Readonly<Record<string, string>>;
}

export type LibrarySend = (message: ClientMessage) => void;

export interface LibraryStoreOptions {
  send: LibrarySend;
  newRequestId?: () => string;
}

export interface LibraryStore {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => LibraryState;
  accept: (message: ServerMessage) => void;
  requestSnapshot: (section: LibrarySection, refresh?: boolean) => string;
  searchStorage: (kind: LibraryStorageKind, options?: Omit<LibraryStorageSearchRequest, 'type' | 'requestId' | 'kind'>) => string;
  previewSkill: (id: string, sourceId?: string) => string;
  setClaudeRole: (name: string, updates: Omit<LibraryClaudeRoleSet, 'type' | 'requestId' | 'name'>) => string;
  restoreWorkItem: (workItemId: string) => string;
  loginAccount: (tool: LibraryAccountLogin['tool'], provider?: string) => string;
  checkMcp: (name: string) => string;
}

export function isLibraryServerMessage(message: ServerMessage): message is LibraryServerMessage {
  return (
    message.type === 'libraryAccountsSnapshot' ||
    message.type === 'libraryClaudeRolesSnapshot' ||
    message.type === 'librarySkillsSnapshot' ||
    message.type === 'libraryMcpSnapshot' ||
    message.type === 'libraryStorageSearchResult' ||
    message.type === 'librarySkillPreview' ||
    message.type === 'libraryCommandResult'
  );
}

function initialState(): LibraryState {
  return {
    accounts: null,
    claudeRoles: null,
    skills: null,
    mcp: null,
    storage: {},
    previews: {},
    commandResults: {},
    pending: {},
    errors: {},
  };
}

function requestSection(request: LibraryRequest): string {
  switch (request.type) {
    case 'librarySnapshotRequest':
      return request.section === 'storage' ? 'storage:workItems' : request.section;
    case 'libraryStorageSearchRequest': return `storage:${request.kind}`;
    case 'librarySkillPreviewRequest': return `skill:${request.id}`;
    case 'libraryWorkItemRestore': return 'command:restoreWorkItem';
    case 'libraryAccountLogin': return 'command:login';
    case 'libraryMcpCheckRequest': return 'command:checkMcp';
    case 'libraryClaudeRoleSet': return 'command:setClaudeRole';
  }
}

function requestKey(request: LibraryRequest): string {
  switch (request.type) {
    case 'librarySnapshotRequest':
      return request.section === 'storage' ? 'storage:workItems' : `snapshot:${request.section}`;
    case 'libraryStorageSearchRequest': return `storage:${request.kind}`;
    case 'librarySkillPreviewRequest': return `skill:${request.id}:${request.sourceId ?? ''}`;
    case 'libraryWorkItemRestore': return `restore:${request.workItemId}`;
    case 'libraryAccountLogin': return `login:${request.tool}`;
    case 'libraryMcpCheckRequest': return `mcp:${request.name}`;
    case 'libraryClaudeRoleSet': return `claudeRole:${request.name}`;
  }
}

function responseMatches(request: LibraryRequest, message: LibraryServerMessage): boolean {
  switch (message.type) {
    case 'libraryAccountsSnapshot':
      return request.type === 'librarySnapshotRequest' && request.section === 'accounts';
    case 'libraryClaudeRolesSnapshot':
      return request.type === 'librarySnapshotRequest' && request.section === 'claudeRoles';
    case 'librarySkillsSnapshot':
      return request.type === 'librarySnapshotRequest' && request.section === 'skills';
    case 'libraryMcpSnapshot':
      return request.type === 'librarySnapshotRequest' && request.section === 'mcp';
    case 'libraryStorageSearchResult':
      return (
        (request.type === 'libraryStorageSearchRequest' && request.kind === message.kind) ||
        (request.type === 'librarySnapshotRequest' && request.section === 'storage' && message.kind === 'workItems')
      );
    case 'librarySkillPreview':
      return request.type === 'librarySkillPreviewRequest' &&
        request.id === message.id &&
        request.sourceId === message.sourceId;
    case 'libraryCommandResult':
      return (
        (request.type === 'libraryWorkItemRestore' && message.command === 'restoreWorkItem') ||
        (request.type === 'libraryAccountLogin' && message.command === 'login') ||
        (request.type === 'libraryMcpCheckRequest' && message.command === 'checkMcp') ||
        (request.type === 'libraryClaudeRoleSet' && message.command === 'setClaudeRole')
      );
  }
}

export function createLibraryStore(options: LibraryStoreOptions): LibraryStore {
  const newRequestId = options.newRequestId ?? defaultRequestId;
  const send = options.send;
  let state = initialState();
  const listeners = new Set<() => void>();
  const latestRequestIds = new Map<string, string>();

  function commit(next: LibraryState): void {
    if (next === state) return;
    state = next;
    for (const listener of listeners) listener();
  }

  function transmit(request: LibraryRequest): string {
    const key = requestKey(request);
    const pending = { ...state.pending };
    const previousRequestId = latestRequestIds.get(key);
    if (previousRequestId !== undefined) delete pending[previousRequestId];
    pending[request.requestId] = request;
    latestRequestIds.set(key, request.requestId);
    const errors = { ...state.errors };
    delete errors[requestSection(request)];
    commit({ ...state, pending, errors });
    try {
      send(request);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const nextPending = { ...state.pending };
      delete nextPending[request.requestId];
      if (latestRequestIds.get(key) === request.requestId) latestRequestIds.delete(key);
      commit({
        ...state,
        pending: nextPending,
        errors: { ...state.errors, [requestSection(request)]: detail },
      });
    }
    return request.requestId;
  }

  function accept(message: ServerMessage): void {
    if (!isLibraryServerMessage(message)) return;
    const request = state.pending[message.requestId];
    if (request === undefined || !responseMatches(request, message)) return;
    const key = requestKey(request);
    if (latestRequestIds.get(key) !== message.requestId) return;
    const pending = { ...state.pending };
    delete pending[message.requestId];
    latestRequestIds.delete(key);
    const section = requestSection(request);
    const errors = { ...state.errors };
    const reason = 'reason' in message ? message.reason : undefined;
    if (reason !== undefined) errors[section] = reason;
    else delete errors[section];

    switch (message.type) {
      case 'libraryAccountsSnapshot': commit({ ...state, accounts: message, pending, errors }); return;
      case 'libraryClaudeRolesSnapshot': commit({ ...state, claudeRoles: message, pending, errors }); return;
      case 'librarySkillsSnapshot': commit({ ...state, skills: message, pending, errors }); return;
      case 'libraryMcpSnapshot': commit({ ...state, mcp: message, pending, errors }); return;
      case 'libraryStorageSearchResult':
        commit({ ...state, storage: { ...state.storage, [message.kind]: message }, pending, errors });
        return;
      case 'librarySkillPreview':
        commit({
          ...state,
          previews: { ...state.previews, [`${message.id}:${message.sourceId ?? ''}`]: message },
          pending,
          errors,
        });
        return;
      case 'libraryCommandResult':
        commit({ ...state, commandResults: { ...state.commandResults, [message.requestId]: message }, pending, errors });
        if (message.command === 'setClaudeRole' && message.ok) {
          transmit({ type: 'librarySnapshotRequest', requestId: newRequestId(), section: 'claudeRoles' });
        }
        return;
    }
  }

  return {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => state,
    accept,
    requestSnapshot: (section, refresh = false) =>
      transmit({ type: 'librarySnapshotRequest', requestId: newRequestId(), section, refresh }),
    searchStorage: (kind, requestOptions = {}) =>
      transmit({ type: 'libraryStorageSearchRequest', requestId: newRequestId(), kind, ...requestOptions }),
    previewSkill: (id, sourceId) =>
      transmit({ type: 'librarySkillPreviewRequest', requestId: newRequestId(), id, sourceId }),
    setClaudeRole: (name, updates) =>
      transmit({ type: 'libraryClaudeRoleSet', requestId: newRequestId(), name, ...updates }),
    restoreWorkItem: (workItemId) =>
      transmit({ type: 'libraryWorkItemRestore', requestId: newRequestId(), workItemId }),
    loginAccount: (tool, provider) =>
      transmit({ type: 'libraryAccountLogin', requestId: newRequestId(), tool, provider }),
    checkMcp: (name) => transmit({ type: 'libraryMcpCheckRequest', requestId: newRequestId(), name }),
  };
}

export function useLibraryState(store: LibraryStore): LibraryState {
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}

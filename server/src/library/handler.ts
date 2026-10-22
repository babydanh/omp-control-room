import * as os from 'node:os';

import type {
  LibraryAccountLogin,
  LibraryClaudeRoleSet,
  LibraryStorageSearchRequest,
  ServerMessage,
} from '../../../core/src/messages.js';
import {
  LIBRARY_FALLBACK_REQUEST_ID,
  LIBRARY_OPERATION_FAILED_REASON,
  LIBRARY_REQUEST_TYPES,
} from '../constants.js';
import * as accounts from './accounts.js';
import * as claudeRoles from './claudeRoles.js';
import { LibraryUserError } from './libraryError.js';
import * as mcp from './mcp.js';
import * as skills from './skills.js';
import * as storage from './storage.js';

export interface LibraryCommandContext {
  readonly privileged: boolean;
}

/** Returns false when the message belongs to another command handler. */
export function handleLibraryMessage(
  msg: Record<string, unknown>,
  send: (message: ServerMessage) => void,
  context: LibraryCommandContext,
): boolean {
  if (typeof msg.type !== 'string' || LIBRARY_REQUEST_TYPES[msg.type] !== true) return false;
  if (!context.privileged) return false;

  const requestId = typeof msg.requestId === 'string' ? msg.requestId : LIBRARY_FALLBACK_REQUEST_ID;
  void runLibraryRequest(msg, requestId, send);
  return true;
}

async function runLibraryRequest(
  msg: Record<string, unknown>,
  requestId: string,
  send: (message: ServerMessage) => void,
): Promise<void> {
  try {
    switch (msg.type) {
      case 'librarySnapshotRequest': {
        if (msg.section === 'accounts') {
          send({ type: 'libraryAccountsSnapshot', requestId, accounts: await accounts.readAccounts(msg.refresh === true) });
        } else if (msg.section === 'skills') {
          const list = await skills.readSkills(msg.refresh === true);
          const reason = skills.skillsSourceReason();
          send({ type: 'librarySkillsSnapshot', requestId, skills: list, ...(reason ? { reason } : {}) });
        } else if (msg.section === 'claudeRoles') {
          send({
            type: 'libraryClaudeRolesSnapshot',
            requestId,
            roles: await claudeRoles.scanClaudeRoles(os.homedir()),
          });
        } else if (msg.section === 'mcp') {
          const servers = await mcp.readMcpServers(msg.refresh === true);
          const reason = mcp.mcpSourceReason();
          send({ type: 'libraryMcpSnapshot', requestId, servers, ...(reason ? { reason } : {}) });
        } else if (msg.section === 'storage') {
          const results = await storage.searchStorage({
            type: 'libraryStorageSearchRequest',
            requestId,
            kind: 'workItems',
            query: '',
            refresh: msg.refresh === true,
          });
          send({ type: 'libraryStorageSearchResult', requestId, kind: 'workItems', results });
        }
        return;
      }
      case 'librarySkillPreviewRequest': {
        const id = stringField(msg, 'id');
        const sourceId = typeof msg.sourceId === 'string' ? msg.sourceId : undefined;
        const preview = await skills.previewSkill(id, sourceId);
        send({ type: 'librarySkillPreview', requestId, id, ...(sourceId ? { sourceId } : {}), ...preview });
        return;
      }
      case 'libraryStorageSearchRequest': {
        const request = msg as unknown as LibraryStorageSearchRequest;
        const results = await storage.searchStorage(request);
        send({
          type: 'libraryStorageSearchResult',
          requestId,
          kind: request.kind,
          results,
        });
        return;
      }
      case 'libraryWorkItemRestore': {
        const workItemId = stringField(msg, 'workItemId');
        await storage.restoreWorkItem(workItemId);
        send({ type: 'libraryCommandResult', requestId, command: 'restoreWorkItem', ok: true, target: workItemId });
        return;
      }
      case 'libraryAccountLogin': {
        const tool = stringField(msg, 'tool') as LibraryAccountLogin['tool'];
        await accounts.openLogin(tool, typeof msg.provider === 'string' ? msg.provider : undefined);
        send({ type: 'libraryCommandResult', requestId, command: 'login', ok: true, target: tool });
        return;
      }
      case 'libraryMcpCheckRequest': {
        const name = stringField(msg, 'name');
        await mcp.checkMcpConnection(name);
        send({ type: 'libraryCommandResult', requestId, command: 'checkMcp', ok: true, target: name });
        return;
      }
      case 'libraryClaudeRoleSet': {
        const request = msg as unknown as LibraryClaudeRoleSet;
        await claudeRoles.setClaudeRole(os.homedir(), request);
        send({ type: 'libraryCommandResult', requestId, command: 'setClaudeRole', ok: true, target: request.name });
        send({
          type: 'libraryClaudeRolesSnapshot',
          requestId,
          roles: await claudeRoles.scanClaudeRoles(os.homedir()),
        });
        return;
      }
      case 'librarySkillModeSet': {
        const names = Array.isArray(msg.names) ? msg.names.filter((name): name is string => typeof name === 'string') : [];
        if (msg.mode !== 'name-only' || names.length === 0) {
          throw new LibraryUserError('Yêu cầu đổi chế độ skill không hợp lệ.');
        }
        const changed = await skills.setClaudeSkillMode(os.homedir(), names, 'name-only');
        send({ type: 'libraryCommandResult', requestId, command: 'setSkillMode', ok: true, target: changed.join(', ') });
        return;
      }
    }
  } catch (error) {
    const reason = error instanceof LibraryUserError ? error.message : LIBRARY_OPERATION_FAILED_REASON;
    send(errorMessage(msg, requestId, reason));
  }
}

function errorMessage(msg: Record<string, unknown>, requestId: string, reason: string): ServerMessage {
  switch (msg.type) {
    case 'librarySnapshotRequest':
      if (msg.section === 'accounts') return { type: 'libraryAccountsSnapshot', requestId, accounts: [], reason };
      if (msg.section === 'skills') return { type: 'librarySkillsSnapshot', requestId, skills: [], reason };
      if (msg.section === 'mcp') return { type: 'libraryMcpSnapshot', requestId, servers: [], reason };
      if (msg.section === 'claudeRoles') return { type: 'libraryClaudeRolesSnapshot', requestId, roles: [], reason };
      return { type: 'libraryStorageSearchResult', requestId, kind: 'workItems', results: [], reason };
    case 'librarySkillPreviewRequest':
      return {
        type: 'librarySkillPreview',
        requestId,
        id: typeof msg.id === 'string' ? msg.id : '',
        ...(typeof msg.sourceId === 'string' ? { sourceId: msg.sourceId } : {}),
        content: '',
        truncated: false,
        reason,
      };
    case 'libraryStorageSearchRequest':
      return {
        type: 'libraryStorageSearchResult',
        requestId,
        kind: isStorageKind(msg.kind) ? msg.kind : 'workItems',
        results: [],
        reason,
      };
    case 'libraryWorkItemRestore':
      return { type: 'libraryCommandResult', requestId, command: 'restoreWorkItem', ok: false, reason };
    case 'libraryAccountLogin':
      return { type: 'libraryCommandResult', requestId, command: 'login', ok: false, reason };
    case 'libraryClaudeRoleSet':
      return { type: 'libraryCommandResult', requestId, command: 'setClaudeRole', ok: false, reason };
    case 'librarySkillModeSet':
      return { type: 'libraryCommandResult', requestId, command: 'setSkillMode', ok: false, reason };
    default:
      return { type: 'libraryCommandResult', requestId, command: 'checkMcp', ok: false, reason };
  }
}

function stringField(message: Record<string, unknown>, key: string): string {
  return typeof message[key] === 'string' ? message[key] as string : '';
}

function isStorageKind(value: unknown): value is LibraryStorageSearchRequest['kind'] {
  return value === 'workItems' || value === 'sessions' || value === 'openViking' || value === 'proofs';
}

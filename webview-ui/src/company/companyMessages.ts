/**
 * The company message vocabulary, in one place.
 *
 * Two jobs:
 *
 *  1. `isCompanyServerMessage` is the single routing test the app's ONE
 *     transport subscription (useCompanyTransport) uses to hand a server
 *     message to the company client. Anything else the server sends has no
 *     reader on the board, and no second `transport.onMessage` is registered.
 *  2. Builders produce the `ClientMessage` values, so a command is built in
 *     the same shape on both surfaces and a typo in a message `type` is a
 *     compile error rather than a silently ignored command.
 *
 * Nothing here sends. Sending is the client's job, and it is the only place
 * that catches the transport's refusal to queue an action across a disconnect.
 */

import type {
  CompanyModelCatalogEntry,
  QuestionAnswerInput,
  RoleProfile,
  SubmitPromptInput,
} from '../../../core/src/company.js';
import type {
  ClientMessage,
  HerdrKey,
  WorkItemAssignee,
  WorkItemVerdict,
} from '../../../core/src/messages.js';
import {
  COMPANY_ARTIFACT_PAGE_BYTES,
  COMPANY_FILE_PAGE_BYTES,
  COMPANY_TERMINAL_DEFAULT_COLS,
  COMPANY_TERMINAL_DEFAULT_ROWS,
} from './constants.js';
import type { CompanyViewMode } from './folderView.js';
import type { UsageHistoryDays } from './usage/usageState.js';

const COMPANY_SERVER_MESSAGE_TYPES: Readonly<Record<string, true>> = {
  companySnapshot: true,
  companyStateChanged: true,
  companyCommandResult: true,
  companyTextDelta: true,
  companyModelCatalog: true,
  companyArtifactPage: true,
  companyFileList: true,
  companyFileRead: true,
  companyAttachmentUploaded: true,
  companySessionLog: true,
  companySessionInfo: true,
  herdrInfo: true,
  companyOmpSessions: true,
  companyWorkspaces: true,
  companyWorkItems: true,
  companyFolderBrowse: true,
  herdrAgents: true,
  herdrScreen: true,
  browserReaperStatus: true,
  terminalAttached: true,
  terminalSnapshot: true,
  terminalData: true,
  terminalClosed: true,
  usageLimits: true,
  usageHistory: true,
  usageStats: true,
};

/** Whether a received message belongs to the company client. */
export function isCompanyServerMessage(message: { type?: unknown }): boolean {
  return typeof message.type === 'string' && message.type in COMPANY_SERVER_MESSAGE_TYPES;
}

/**
 * A random RFC 4122 v4 id. `crypto.randomUUID` exists only in secure contexts
 * (HTTPS or localhost), so a board opened at a LAN address over plain HTTP
 * would crash on it; `crypto.getRandomValues` is available everywhere.
 */
export function newRequestId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * The optional folder a folder-scoped request names. Absent means the server answers
 * for the folder it already has active.
 */
function folderField(workspacePath: string | undefined): { workspacePath?: string } {
  return workspacePath === undefined ? {} : { workspacePath };
}

/** `force` is sent only when set; without it the server answers from its cache while that is fresh. */
function forceField(force: boolean): { force?: true } {
  return force ? { force: true } : {};
}

export function companySnapshotRequest(
  requestId: string,
  includeDiagnostics = false,
  workspacePath?: string,
): ClientMessage {
  return {
    type: 'companySnapshotRequest',
    requestId,
    includeDiagnostics,
    ...folderField(workspacePath),
  };
}

export function promptSubmit(input: SubmitPromptInput, workspacePath?: string): ClientMessage {
  return { type: 'companyPromptSubmit', prompt: input, ...folderField(workspacePath) };
}

export function contractDecision(
  requestId: string,
  contractId: string,
  revision: number,
  decision: 'approve' | 'reject',
  note?: string,
): ClientMessage {
  return {
    type: 'companyContractDecision',
    requestId,
    contractId,
    revision,
    decision,
    ...(note === undefined ? {} : { note }),
  };
}

export function questionAnswer(answer: QuestionAnswerInput): ClientMessage {
  return { type: 'companyQuestionAnswer', answer };
}

/** Every lifecycle action a session accepts; the server refuses the ones it cannot take. */
export type SessionControlAction =
  'pause' | 'resume' | 'kill' | 'restart' | 'archive' | 'interrupt' | 'delete';

export function sessionControl(
  requestId: string,
  sessionId: string,
  runEpoch: number,
  action: SessionControlAction,
): ClientMessage {
  return { type: 'companySessionControl', requestId, sessionId, runEpoch, action };
}

/** Open a new omp chat session in the folder. No prompt is sent; the verdict carries the id. */
export function chatNew(requestId: string, workspacePath?: string): ClientMessage {
  return { type: 'companyChatNew', requestId, ...folderField(workspacePath) };
}

/** Withdraw a prompt no Contract holds yet; the server stops and deletes what planned it. */
export function promptCancel(requestId: string, promptId: string): ClientMessage {
  return { type: 'companyPromptCancel', requestId, promptId };
}

/** Read-only: the omp sessions saved for one folder, the active one when none is named. */
export function ompSessionsRequest(requestId: string, workspacePath?: string): ClientMessage {
  return { type: 'companyOmpSessionsRequest', requestId, ...folderField(workspacePath) };
}

export function sessionResume(
  requestId: string,
  file: string,
  workspacePath?: string,
): ClientMessage {
  return { type: 'companySessionResume', requestId, file, ...folderField(workspacePath) };
}

export function workspaceOpen(requestId: string, path: string): ClientMessage {
  return { type: 'companyWorkspaceOpen', requestId, path };
}

/** List the folders under `path`, or the start view when none is named. */
export function folderBrowseRequest(requestId: string, path?: string): ClientMessage {
  return {
    type: 'companyFolderBrowseRequest',
    requestId,
    ...(path === undefined ? {} : { path }),
  };
}

/** Create a folder called `name` inside `parentPath`. The verdict is a companyCommandResult. */
export function folderCreate(requestId: string, parentPath: string, name: string): ClientMessage {
  return { type: 'companyFolderCreate', requestId, parentPath, name };
}

/** Give the folder at `path` a display name; an empty name removes it. */
export function folderName(requestId: string, path: string, name: string): ClientMessage {
  return { type: 'companyFolderName', requestId, path, name };
}

/** Take the folder at `path` off the folder list. The verdict is a companyCommandResult. */
export function folderForget(requestId: string, path: string): ClientMessage {
  return { type: 'companyFolderForget', requestId, path };
}

/** Which folders the server streams to this board: every open one, or only the active one. */
export function companyViewMode(requestId: string, mode: CompanyViewMode): ClientMessage {
  return { type: 'companyViewMode', requestId, mode };
}

export function settingsUpdate(
  requestId: string,
  roleProfiles: Record<string, RoleProfile>,
  workspacePath?: string,
): ClientMessage {
  return { type: 'companySettingsUpdate', requestId, roleProfiles, ...folderField(workspacePath) };
}

export function modelCatalogRequest(requestId: string, workspacePath?: string): ClientMessage {
  return { type: 'companyModelCatalogRequest', requestId, ...folderField(workspacePath) };
}

/** Read-only and privileged: the account limits the usage page shows. */
export function usageLimitsRequest(requestId: string, force = false): ClientMessage {
  return { type: 'usageLimitsRequest', requestId, ...forceField(force) };
}

/** Read-only and privileged: the limit history and per-client burn over the last `days` days. */
export function usageHistoryRequest(
  requestId: string,
  days: UsageHistoryDays,
  force = false,
): ClientMessage {
  return { type: 'usageHistoryRequest', requestId, days, ...forceField(force) };
}

/** Read-only and privileged: the token, cost and performance totals. */
export function usageStatsRequest(requestId: string, force = false): ClientMessage {
  return { type: 'usageStatsRequest', requestId, ...forceField(force) };
}

export function artifactRequest(
  requestId: string,
  artifactId: string,
  offset = 0,
  limit = COMPANY_ARTIFACT_PAGE_BYTES,
  workspacePath?: string,
): ClientMessage {
  return {
    type: 'companyArtifactRequest',
    requestId,
    artifactId,
    offset,
    limit,
    ...folderField(workspacePath),
  };
}

export function fileListRequest(
  requestId: string,
  path: string,
  workspacePath?: string,
): ClientMessage {
  return { type: 'companyFileListRequest', requestId, path, ...folderField(workspacePath) };
}

export function fileReadRequest(
  requestId: string,
  path: string,
  offset = 0,
  limit = COMPANY_FILE_PAGE_BYTES,
  workspacePath?: string,
): ClientMessage {
  return {
    type: 'companyFileReadRequest',
    requestId,
    path,
    offset,
    limit,
    ...folderField(workspacePath),
  };
}

export function terminalAttach(
  requestId: string,
  sessionId: string,
  runEpoch: number,
  cols = COMPANY_TERMINAL_DEFAULT_COLS,
  rows = COMPANY_TERMINAL_DEFAULT_ROWS,
): ClientMessage {
  return { type: 'terminalAttach', requestId, sessionId, runEpoch, cols, rows };
}

export function terminalInput(
  sessionId: string,
  runEpoch: number,
  data: string,
  leaseId: string,
): ClientMessage {
  return { type: 'terminalInput', sessionId, runEpoch, data, leaseId };
}

export function terminalResize(
  sessionId: string,
  runEpoch: number,
  cols: number,
  rows: number,
  leaseId: string,
): ClientMessage {
  return { type: 'terminalResize', sessionId, runEpoch, cols, rows, leaseId };
}

export function terminalDetach(
  sessionId: string,
  runEpoch: number,
  leaseId: string,
): ClientMessage {
  return { type: 'terminalDetach', sessionId, runEpoch, leaseId };
}

export function sessionLogRequest(requestId: string, sessionId: string): ClientMessage {
  return { type: 'companySessionLogRequest', requestId, sessionId };
}

export function sessionRename(requestId: string, sessionId: string, name: string): ClientMessage {
  return { type: 'companySessionRename', requestId, sessionId, name };
}

/** File a new work item and hand it to `assignee`. The verdict names the item in `workItemId`. */
export function workItemCreate(
  requestId: string,
  workspacePath: string,
  text: string,
  assignee: WorkItemAssignee,
): ClientMessage {
  return { type: 'companyWorkItemCreate', requestId, workspacePath, text, assignee };
}

/** Hand an existing work item to another agent. The verdict is a companyCommandResult. */
export function workItemAssign(
  requestId: string,
  workspacePath: string,
  id: string,
  assignee: WorkItemAssignee,
): ClientMessage {
  return { type: 'companyWorkItemAssign', requestId, workspacePath, id, assignee };
}

/** Send more text to the agent holding a work item. The verdict is a companyCommandResult. */
export function workItemFollowUp(
  requestId: string,
  workspacePath: string,
  id: string,
  text: string,
): ClientMessage {
  return { type: 'companyWorkItemFollowUp', requestId, workspacePath, id, text };
}

/** Close a work item as done or failed. The verdict is a companyCommandResult. */
export function workItemMark(
  requestId: string,
  workspacePath: string,
  id: string,
  verdict: WorkItemVerdict,
): ClientMessage {
  return { type: 'companyWorkItemMark', requestId, workspacePath, id, verdict };
}

/** Withdraw a work item that is still queued. The verdict is a companyCommandResult. */
export function workItemCancel(
  requestId: string,
  workspacePath: string,
  id: string,
): ClientMessage {
  return { type: 'companyWorkItemCancel', requestId, workspacePath, id };
}

/** Set the description of an agent's role in a folder. The verdict is a companyCommandResult. */
export function agentRoleSet(
  requestId: string,
  workspacePath: string,
  agent: WorkItemAssignee,
  description: string,
): ClientMessage {
  return { type: 'companyAgentRoleSet', requestId, workspacePath, agent, description };
}

export function sessionInfoRequest(requestId: string, sessionId: string): ClientMessage {
  return { type: 'companySessionInfoRequest', requestId, sessionId };
}

export function herdrRead(requestId: string, paneId: string, lines: number): ClientMessage {
  return { type: 'herdrRead', requestId, paneId, lines };
}

export function herdrPrompt(requestId: string, paneId: string, text: string): ClientMessage {
  return { type: 'herdrPrompt', requestId, paneId, text };
}

export function herdrKeys(requestId: string, paneId: string, keys: HerdrKey[]): ClientMessage {
  return { type: 'herdrKeys', requestId, paneId, keys };
}

export function herdrFocus(requestId: string, paneId: string): ClientMessage {
  return { type: 'herdrFocus', requestId, paneId };
}

/** Starts or renews the push watch on a pane's screen; `watching: false` ends it. */
export function herdrWatch(requestId: string, paneId: string, watching: boolean): ClientMessage {
  return { type: 'herdrWatch', requestId, paneId, watching };
}

/** Wakes a hibernated session. The prompt goes only when the user typed something; a blank one is left out. */
export function herdrWake(requestId: string, paneId: string, prompt?: string): ClientMessage {
  const text = prompt?.trim() ?? '';
  return text === ''
    ? { type: 'herdrWake', requestId, paneId }
    : { type: 'herdrWake', requestId, paneId, prompt: text };
}

export function herdrRename(requestId: string, paneId: string, name: string): ClientMessage {
  return { type: 'herdrRename', requestId, paneId, name };
}

export function herdrInfoRequest(requestId: string, paneId: string): ClientMessage {
  return { type: 'herdrInfoRequest', requestId, paneId };
}

/** Stop every omp headless browser with no open page now, ignoring the grace period. Privileged on the server. */
export function browserReaperReapNow(): ClientMessage {
  return { type: 'browserReaperReapNow' };
}

/** The catalog entry a `companyModelCatalog` reply resolves to. */
export type CatalogEntry = CompanyModelCatalogEntry;

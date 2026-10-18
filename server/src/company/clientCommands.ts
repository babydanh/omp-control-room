/**
 * clientCommands: the single dispatcher for every Company and terminal command.
 *
 * Both surfaces route through here so authorization, limits and validation
 * cannot drift between the standalone server and the VS Code extension.
 *
 * Order of checks is deliberate and identical for every command:
 *   1. privilege -- an unprivileged socket is refused before any workspace,
 *      filesystem or process work happens, so an observer client cannot even
 *      probe which ids exist.
 *   2. surface availability -- a command with no coordinator answers
 *      `company_unavailable` instead of hanging on a pending promise.
 *   3. shape and limits -- request ids, byte budgets and path containment,
 *      checked before delegating.
 *   4. execution -- the coordinator or store performs the effect; a rejection
 *      from either surfaces as its own error code rather than a generic
 *      failure, because the client shows the difference to the user.
 *
 * A successful mutation does NOT carry the new revision: the client learns it
 * from the next `companyStateChanged`, so a command never needs a second full
 * projection of the company just to stamp a result.
 *
 * Nothing here queues. Terminal input is written once or dropped with an
 * explicit code: replaying keystrokes after a reconnect would re-submit text
 * the user already sent.
 */

import { createHash } from 'node:crypto';

import type {
  AgentInfo,
  CompanyModelCatalogEntry,
  PromptAttachment,
  QuestionAnswerInput,
  RoleProfile,
  SubmitPromptInput,
} from '../../../core/src/company.js';
import type {
  CompanyWorkspaceEntry,
  HerdrAgentsMessage,
  ServerMessage,
} from '../../../core/src/messages.js';
import {
  HERDR_DEFAULT_READ_LINES,
  HerdrError,
  type HerdrLink,
  isHerdrKey,
} from '../herdr/herdrLink.js';
import type {
  CompanyCoordinator,
  CompanySessionAction,
  ContractDecision,
} from './companyCoordinator.js';
import { COMPANY_SESSION_NAME_MAX_LENGTH } from './companyCoordinator.js';
import type { CompanyStore } from './companyStore.js';
import {
  COMPANY_ARTIFACT_PAGE_BYTES,
  COMPANY_ATTACHMENT_MAX_BYTES,
  COMPANY_DEFAULT_TERMINAL_COLS,
  COMPANY_DEFAULT_TERMINAL_ROWS,
  COMPANY_FILE_DEFAULT_PAGE_BYTES,
  COMPANY_MAX_PROMPT_BYTES,
  COMPANY_TERMINAL_INPUT_MAX_BYTES,
} from './constants.js';
import {
  isSessionLogId,
  readSessionLog,
  SESSION_LOG_DEFAULT_LIMIT,
  SESSION_LOG_MAX_LIMIT,
  sessionLogDirectory,
} from './sessionLog.js';
import { listWorkspaceFiles, readWorkspaceFile } from './workspaceFiles.js';

/** Controller lease returned by an attach; the last attach for a session wins. */
export interface CompanyTerminalHandle {
  leaseId: string;
  cols: number;
  rows: number;
}

/**
 * PTY control surface. Implemented by the terminal session owner; `null` means
 * the native capability is not installed, which the UI reports as unavailable
 * rather than substituting piped text.
 */
export interface CompanyTerminalGateway {
  attach(
    sessionId: string,
    runEpoch: number,
    cols?: number,
    rows?: number,
    onLeaseGranted?: (leaseId: string) => void,
  ): Promise<CompanyTerminalHandle>;
  write(sessionId: string, runEpoch: number, data: string, leaseId: string): Promise<void>;
  resize(
    sessionId: string,
    runEpoch: number,
    cols: number,
    rows: number,
    leaseId: string,
  ): Promise<void>;
  detach(sessionId: string, runEpoch: number, leaseId: string): Promise<void>;
}

export interface CompanyCommandServices {
  coordinator: CompanyCoordinator;
  store: CompanyStore;
  /** Canonical workspace root every file request is resolved against. */
  workspaceRoot: string;
  /** `null` until the native PTY capability is installed. */
  terminal: CompanyTerminalGateway | null;
  /** Model catalog for the UI; resolves availability, never credentials. */
  modelCatalog(): Promise<CompanyModelCatalogEntry[]>;
  /** One managed session's description; a live run is asked, otherwise its record answers. */
  sessionInfo(sessionId: string): Promise<AgentInfo>;
}

/**
 * Folder list and folder switching for this server. It sits beside the services
 * rather than inside them: it must answer while no folder is active, which is
 * exactly when the user most needs to open one.
 */
export interface CompanyWorkspaceControl {
  /** Folders for the board: the open ones first, then the recently used ones. */
  entries(): CompanyWorkspaceEntry[];
  /** Open the folder if it is not open, then make it the active one. Refusals carry a user-facing message. */
  open(workspacePath: string): Promise<void>;
}

export interface CompanyCommandContext {
  /** `null` when this process has no company workspace open. */
  services: CompanyCommandServices | null;
  /** Folder list and switching; absent when this surface has no folder control. */
  workspaces?: CompanyWorkspaceControl | null;
  /** Whether this connection may run company commands at all. */
  privileged?: boolean;
  /** False in an untrusted VS Code workspace; authorized read-only views remain usable. */
  executionAllowed: boolean;
  /** Server-level herdr link; absent or `null` when this process runs without one. */
  herdr?: HerdrLink | null;
  /** Updates the per-socket egress lease as soon as attach rotates ownership. */
  onTerminalAttached?: (sessionId: string, leaseId: string) => void;
  /**
   * Called after a successful detach. Matching by lease prevents a delayed
   * detach reply from revoking a newer attachment for the same session.
   */
  onTerminalDetached?: (sessionId: string, leaseId: string) => void;
}

type Send = (message: ServerMessage) => void;

const CONTRACT_DECISIONS: ReadonlySet<string> = new Set(['approve', 'reject']);
const SESSION_ACTIONS: ReadonlySet<string> = new Set([
  'pause',
  'resume',
  'kill',
  'restart',
  'archive',
  'interrupt',
  'delete',
]);
const PROMPT_DELIVERIES: ReadonlySet<string> = new Set(['prompt', 'steer', 'follow_up']);

const HERDR_COMMAND_TYPES: ReadonlySet<string> = new Set([
  'herdrRead',
  'herdrPrompt',
  'herdrKeys',
  'herdrFocus',
  'herdrRename',
  'herdrInfoRequest',
  'herdrWake',
]);
const HERDR_NOT_LINKED_MESSAGE = 'Máy chủ này chưa kết nối herdr.';
const HERDR_NOT_LINKED_ROSTER: HerdrAgentsMessage = {
  type: 'herdrAgents',
  available: false,
  reason: HERDR_NOT_LINKED_MESSAGE,
  agents: [],
  sleeping: [],
};
const INVALID_HERDR_REQUEST_MESSAGE = 'Yêu cầu herdr không hợp lệ.';
const HERDR_FAILED_MESSAGE = 'Không thực hiện được lệnh herdr.';

// The wire enums live in core/asyncapi.yaml; these predicates narrow a
// validated string back to the generated union the coordinator accepts.
function isContractDecision(value: string): value is ContractDecision {
  return CONTRACT_DECISIONS.has(value);
}

function isSessionAction(value: string): value is CompanySessionAction {
  return SESSION_ACTIONS.has(value);
}

function isPromptDelivery(value: string): value is SubmitPromptInput['delivery'] {
  return PROMPT_DELIVERIES.has(value);
}

/** Message types this dispatcher owns. Everything else is not a company command. */
const COMPANY_COMMAND_TYPES: ReadonlySet<string> = new Set([
  'companySnapshotRequest',
  ...HERDR_COMMAND_TYPES,
  'companyPromptSubmit',
  'companyContractDecision',
  'companyQuestionAnswer',
  'companySessionControl',
  'companySessionRename',
  'companySessionInfoRequest',
  'companyPromptCancel',
  'companyOmpSessionsRequest',
  'companySessionResume',
  'companySettingsUpdate',
  'companyModelCatalogRequest',
  'companyArtifactRequest',
  'companyFileListRequest',
  'companyFileReadRequest',
  'companySessionLogRequest',
  'companyAttachmentUpload',
  'companyWorkspaceOpen',
  'terminalAttach',
  'terminalInput',
  'terminalResize',
  'terminalDetach',
]);

const READ_ONLY_COMMAND_TYPES: ReadonlySet<string> = new Set([
  'companySnapshotRequest',
  'herdrRead',
  'herdrInfoRequest',
  'companyModelCatalogRequest',
  'companyArtifactRequest',
  'companyFileListRequest',
  'companyFileReadRequest',
  'companySessionLogRequest',
  'companySessionInfoRequest',
  'companyOmpSessionsRequest',
]);

export function isCompanyCommand(msg: Record<string, unknown>): boolean {
  return typeof msg.type === 'string' && COMPANY_COMMAND_TYPES.has(msg.type);
}

function requestIdOf(msg: Record<string, unknown>): string | null {
  if (typeof msg.requestId === 'string') return msg.requestId;
  const nested = msg.prompt ?? msg.answer;
  if (nested && typeof nested === 'object' && 'requestId' in nested) {
    const inner = (nested as { requestId?: unknown }).requestId;
    if (typeof inner === 'string') return inner;
  }
  return null;
}

function stringField(msg: Record<string, unknown>, key: string): string | null {
  const value = msg[key];
  return typeof value === 'string' ? value : null;
}

function numberField(msg: Record<string, unknown>, key: string): number | null {
  const value = msg[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function objectField(msg: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const value = msg[key];
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function fail(send: Send, requestId: string | null, code: string, message?: string): void {
  send({
    type: 'companyCommandResult',
    requestId: requestId ?? FALLBACK_REQUEST_ID,
    ok: false,
    errorCode: code,
    ...(message === undefined ? {} : { message }),
  });
}

function ok(send: Send, requestId: string | null, revision?: number, sessionId?: string): void {
  send({
    type: 'companyCommandResult',
    requestId: requestId ?? FALLBACK_REQUEST_ID,
    ok: true,
    ...(revision === undefined ? {} : { revision }),
    ...(sessionId === undefined ? {} : { sessionId }),
  });
}

/**
 * Placeholder correlation id for the few commands that legitimately carry none
 * (terminal input/resize/detach). It is a real UUID so the wire schema holds,
 * and the UI ignores correlation for streamed input.
 */
const FALLBACK_REQUEST_ID = '00000000-0000-4000-8000-000000000000';

/** Error code carried by a thrown coordinator/store rejection, when present. */
function codeOf(err: unknown): string {
  if (err && typeof err === 'object' && 'code' in err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return 'company_command_failed';
}

function messageOf(err: unknown): string | undefined {
  return err instanceof Error ? err.message : undefined;
}

/**
 * Dispatch one Company command. Returns true when the message was a company
 * command (handled or refused), false when it belongs to another dispatcher.
 */
export function handleCompanyCommand(
  msg: Record<string, unknown>,
  send: Send,
  ctx: CompanyCommandContext,
): boolean {
  if (!isCompanyCommand(msg)) return false;

  const requestId = requestIdOf(msg);

  if (ctx.privileged !== true) {
    fail(send, requestId, 'forbidden', 'Kết nối này không được phép chạy lệnh công ty.');
    return true;
  }
  if (ctx.executionAllowed !== true && !READ_ONLY_COMMAND_TYPES.has(String(msg.type))) {
    fail(
      send,
      requestId,
      'workspace_untrusted',
      'Hãy tin cậy workspace này trước khi chạy lệnh công ty.',
    );
    return true;
  }
  if (msg.type === 'companySnapshotRequest') {
    send(ctx.herdr?.snapshot() ?? HERDR_NOT_LINKED_ROSTER);
  }
  if (msg.type === 'companySnapshotRequest' && ctx.workspaces) {
    send({ type: 'companyWorkspaces', workspaces: ctx.workspaces.entries() });
  }
  if (HERDR_COMMAND_TYPES.has(String(msg.type))) {
    void herdrCommand(msg, requestId, ctx.herdr ?? null, send);
    return true;
  }
  if (msg.type === 'companyWorkspaceOpen') {
    void openWorkspace(requestId, stringField(msg, 'path'), ctx.workspaces ?? null, send);
    return true;
  }
  const services = ctx.services;
  if (!services) {
    fail(send, requestId, 'company_unavailable', 'Chưa mở workspace công ty nào.');
    return true;
  }

  void run(msg, requestId, services, send, ctx);
  return true;
}

async function run(
  msg: Record<string, unknown>,
  requestId: string | null,
  services: CompanyCommandServices,
  send: Send,
  ctx: CompanyCommandContext,
): Promise<void> {
  try {
    switch (msg.type) {
      case 'companySnapshotRequest':
        await snapshot(msg, requestId, services, send);
        return;
      case 'companyPromptSubmit':
        await submitPrompt(msg, services, send);
        return;
      case 'companyContractDecision':
        await decideContract(msg, requestId, services, send);
        return;
      case 'companyQuestionAnswer':
        await answerQuestion(msg, services, send);
        return;
      case 'companySessionControl':
        await controlSession(msg, requestId, services, send);
        return;
      case 'companySessionRename':
        await renameSession(msg, requestId, services, send);
        return;
      case 'companySessionInfoRequest':
        await sessionInfo(msg, requestId, services, send);
        return;
      case 'companyPromptCancel':
        await cancelPrompt(msg, requestId, services, send);
        return;
      case 'companyOmpSessionsRequest':
        await listOmpSessions(requestId, services, send);
        return;
      case 'companySessionResume':
        await resumeOmpSession(msg, requestId, services, send);
        return;
      case 'companySettingsUpdate':
        await updateSettings(msg, requestId, services, send);
        return;
      case 'companyModelCatalogRequest':
        await modelCatalog(requestId, services, send);
        return;
      case 'companyArtifactRequest':
        await artifactPage(msg, requestId, services, send);
        return;
      case 'companyFileListRequest':
        await fileList(msg, requestId, services, send);
        return;
      case 'companyFileReadRequest':
        await fileRead(msg, requestId, services, send);
        return;
      case 'companySessionLogRequest':
        await sessionLogPage(msg, requestId, services, send);
        return;
      case 'companyAttachmentUpload':
        await attachmentUpload(msg, requestId, services, send);
        return;
      case 'terminalAttach':
        await terminalAttach(msg, requestId, services, send, ctx);
        return;
      case 'terminalInput':
        await terminalInput(msg, requestId, services, send);
        return;
      case 'terminalResize':
        await terminalResize(msg, requestId, services, send);
        return;
      case 'terminalDetach':
        await terminalDetach(msg, requestId, services, send, ctx);
        return;
      default:
        fail(send, requestId, 'company_unsupported_command', `Không hỗ trợ: ${String(msg.type)}`);
    }
  } catch (err) {
    fail(send, requestId, codeOf(err), messageOf(err));
  }
}

/** Herdr runs on the server-level link, so these commands need no company workspace. */
async function herdrCommand(
  msg: Record<string, unknown>,
  requestId: string | null,
  herdr: HerdrLink | null,
  send: Send,
): Promise<void> {
  if (requestId === null) {
    fail(send, null, 'invalid_request', INVALID_HERDR_REQUEST_MESSAGE);
    return;
  }
  if (herdr === null) {
    fail(send, requestId, 'herdr_unavailable', HERDR_NOT_LINKED_MESSAGE);
    return;
  }
  const paneId = stringField(msg, 'paneId');
  if (paneId === null) {
    fail(send, requestId, 'invalid_request', INVALID_HERDR_REQUEST_MESSAGE);
    return;
  }
  try {
    switch (msg.type) {
      case 'herdrRead': {
        const lines = msg.lines === undefined ? HERDR_DEFAULT_READ_LINES : numberField(msg, 'lines');
        if (lines === null) {
          fail(send, requestId, 'invalid_request', INVALID_HERDR_REQUEST_MESSAGE);
          return;
        }
        send({ ...(await herdr.read(paneId, lines)), requestId });
        return;
      }
      case 'herdrPrompt': {
        const text = stringField(msg, 'text');
        if (text === null) {
          fail(send, requestId, 'invalid_request', INVALID_HERDR_REQUEST_MESSAGE);
          return;
        }
        await herdr.prompt(paneId, text);
        ok(send, requestId);
        return;
      }
      case 'herdrKeys': {
        const keys = Array.isArray(msg.keys) && msg.keys.every(isHerdrKey) ? msg.keys : null;
        if (keys === null) {
          fail(send, requestId, 'invalid_request', INVALID_HERDR_REQUEST_MESSAGE);
          return;
        }
        await herdr.keys(paneId, keys);
        ok(send, requestId);
        return;
      }
      case 'herdrFocus':
        await herdr.focus(paneId);
        ok(send, requestId);
        return;
      case 'herdrWake': {
        const prompt = msg.prompt === undefined ? undefined : stringField(msg, 'prompt');
        if (prompt === null) {
          fail(send, requestId, 'invalid_request', INVALID_HERDR_REQUEST_MESSAGE);
          return;
        }
        await herdr.wake(paneId, prompt);
        ok(send, requestId);
        return;
      }
      case 'herdrRename': {
        const name = stringField(msg, 'name');
        if (name === null) {
          fail(send, requestId, 'invalid_request', INVALID_HERDR_REQUEST_MESSAGE);
          return;
        }
        await herdr.rename(paneId, name);
        ok(send, requestId);
        return;
      }
      case 'herdrInfoRequest':
        send({ type: 'herdrInfo', requestId, paneId, info: await herdr.info(paneId) });
        return;
      default:
        fail(send, requestId, 'company_unsupported_command', `Không hỗ trợ: ${String(msg.type)}`);
    }
  } catch (err) {
    if (err instanceof HerdrError) fail(send, requestId, err.code, err.message);
    else fail(send, requestId, 'herdr_failed', HERDR_FAILED_MESSAGE);
  }
}

/**
 * Open or switch to a Company folder. The folder list answers the refusal, so a
 * missing path or a file reaches the user with its own Vietnamese message.
 */
async function openWorkspace(
  requestId: string | null,
  workspacePath: string | null,
  workspaces: CompanyWorkspaceControl | null,
  send: Send,
): Promise<void> {
  if (workspaces === null) {
    fail(send, requestId, 'company_unavailable', 'Máy chủ này không quản lý nhiều thư mục.');
    return;
  }
  if (workspacePath === null) {
    fail(send, requestId, 'invalid_request', 'Cần đường dẫn thư mục để mở.');
    return;
  }
  try {
    await workspaces.open(workspacePath);
    ok(send, requestId);
  } catch (err) {
    fail(send, requestId, codeOf(err), messageOf(err));
  }
}

async function snapshot(
  msg: Record<string, unknown>,
  requestId: string | null,
  services: CompanyCommandServices,
  send: Send,
): Promise<void> {
  const includeDiagnostics = msg.includeDiagnostics === true;
  const projection = services.coordinator.snapshot();
  const diagnostics = includeDiagnostics ? services.coordinator.diagnostics() : undefined;
  send({
    type: 'companySnapshot',
    requestId: requestId ?? FALLBACK_REQUEST_ID,
    snapshot: diagnostics ? { ...projection, diagnostics } : projection,
  });
}

async function submitPrompt(
  msg: Record<string, unknown>,
  services: CompanyCommandServices,
  send: Send,
): Promise<void> {
  const prompt = objectField(msg, 'prompt');
  const text = prompt ? stringField(prompt, 'text') : null;
  const delivery = prompt ? stringField(prompt, 'delivery') : null;
  if (!prompt || text === null || delivery === null || !isPromptDelivery(delivery)) {
    fail(send, requestIdOf(msg), 'invalid_prompt', 'Cần có nội dung prompt và cách gửi.');
    return;
  }
  const mode = stringField(prompt, 'mode');
  if (mode !== null && mode !== 'chat' && mode !== 'company') {
    fail(send, requestIdOf(msg), 'invalid_prompt', 'Chế độ prompt phải là chat hoặc company.');
    return;
  }
  const requestId = stringField(prompt, 'requestId') ?? requestIdOf(msg);
  // Checked on the raw bytes, before decoding, so a truncated prompt is never
  // submitted as a valid shorter one.
  if (Buffer.byteLength(text, 'utf-8') > COMPANY_MAX_PROMPT_BYTES) {
    fail(send, requestId, 'prompt_too_large', `Prompt vượt quá ${COMPANY_MAX_PROMPT_BYTES} byte.`);
    return;
  }
  const stored = await services.coordinator.submitPrompt(prompt as unknown as SubmitPromptInput);
  ok(send, requestId, undefined, stored.targetSessionId);
}

async function decideContract(
  msg: Record<string, unknown>,
  requestId: string | null,
  services: CompanyCommandServices,
  send: Send,
): Promise<void> {
  const contractId = stringField(msg, 'contractId');
  const revision = numberField(msg, 'revision');
  const decision = stringField(msg, 'decision');
  if (!contractId || revision === null || !decision || !isContractDecision(decision)) {
    fail(
      send,
      requestId,
      'invalid_contract_decision',
      'Cần có id hợp đồng, revision và quyết định.',
    );
    return;
  }
  const note = stringField(msg, 'note') ?? undefined;
  await services.coordinator.decideContract(contractId, revision, decision, note);
  ok(send, requestId);
}

async function answerQuestion(
  msg: Record<string, unknown>,
  services: CompanyCommandServices,
  send: Send,
): Promise<void> {
  const answer = objectField(msg, 'answer');
  if (!answer) {
    fail(send, requestIdOf(msg), 'invalid_answer', 'Cần có payload trả lời.');
    return;
  }
  await services.coordinator.answerQuestion(answer as unknown as QuestionAnswerInput);
  ok(send, stringField(answer, 'requestId') ?? requestIdOf(msg));
}

async function renameSession(
  msg: Record<string, unknown>,
  requestId: string | null,
  services: CompanyCommandServices,
  send: Send,
): Promise<void> {
  const sessionId = stringField(msg, 'sessionId');
  const name = (stringField(msg, 'name') ?? '').trim();
  if (
    sessionId === null ||
    !isSessionLogId(sessionId) ||
    name.length === 0 ||
    name.length > COMPANY_SESSION_NAME_MAX_LENGTH
  ) {
    fail(
      send,
      requestId,
      'invalid_session_rename',
      `Cần có sessionId hợp lệ và tên từ 1 đến ${COMPANY_SESSION_NAME_MAX_LENGTH} ký tự.`,
    );
    return;
  }
  await services.coordinator.renameSession(sessionId, name);
  ok(send, requestId);
}

async function sessionInfo(
  msg: Record<string, unknown>,
  requestId: string | null,
  services: CompanyCommandServices,
  send: Send,
): Promise<void> {
  const sessionId = stringField(msg, 'sessionId');
  if (sessionId === null || !isSessionLogId(sessionId)) {
    fail(send, requestId, 'invalid_session_info_request', 'Cần có sessionId hợp lệ.');
    return;
  }
  const info = await services.sessionInfo(sessionId);
  send({
    type: 'companySessionInfo',
    requestId: requestId ?? FALLBACK_REQUEST_ID,
    sessionId,
    info,
  });
}

async function controlSession(
  msg: Record<string, unknown>,
  requestId: string | null,
  services: CompanyCommandServices,
  send: Send,
): Promise<void> {
  const sessionId = stringField(msg, 'sessionId');
  const runEpoch = numberField(msg, 'runEpoch');
  const action = stringField(msg, 'action');
  if (!sessionId || runEpoch === null || !action || !isSessionAction(action)) {
    fail(send, requestId, 'invalid_session_control', 'Cần có id phiên, run epoch và hành động.');
    return;
  }
  await services.coordinator.controlSession(sessionId, action as CompanySessionAction, runEpoch);
  ok(send, requestId);
}

async function cancelPrompt(
  msg: Record<string, unknown>,
  requestId: string | null,
  services: CompanyCommandServices,
  send: Send,
): Promise<void> {
  const promptId = stringField(msg, 'promptId');
  if (promptId === null || promptId.length === 0) {
    fail(send, requestId, 'invalid_prompt_cancel', 'Cần có id prompt.');
    return;
  }
  await services.coordinator.cancelPrompt(promptId);
  ok(send, requestId);
}

async function listOmpSessions(
  requestId: string | null,
  services: CompanyCommandServices,
  send: Send,
): Promise<void> {
  const listing = await services.coordinator.listOmpSessions();
  send({
    type: 'companyOmpSessions',
    requestId: requestId ?? FALLBACK_REQUEST_ID,
    folder: listing.folder,
    sessions: listing.sessions,
  });
}

async function resumeOmpSession(
  msg: Record<string, unknown>,
  requestId: string | null,
  services: CompanyCommandServices,
  send: Send,
): Promise<void> {
  const file = stringField(msg, 'file');
  if (file === null || file.length === 0) {
    fail(send, requestId, 'invalid_session_resume', 'Cần có đường dẫn file phiên OMP.');
    return;
  }
  const sessionId = await services.coordinator.resumeOmpSession(file);
  ok(send, requestId, undefined, sessionId);
}

async function updateSettings(
  msg: Record<string, unknown>,
  requestId: string | null,
  services: CompanyCommandServices,
  send: Send,
): Promise<void> {
  const roleProfiles = objectField(msg, 'roleProfiles');
  if (!roleProfiles) {
    fail(send, requestId, 'invalid_settings', 'Cần có roleProfiles.');
    return;
  }
  await services.coordinator.updateSettings(roleProfiles as Record<string, RoleProfile>);
  ok(send, requestId);
}

async function modelCatalog(
  requestId: string | null,
  services: CompanyCommandServices,
  send: Send,
): Promise<void> {
  const entries = await services.modelCatalog();
  send({
    type: 'companyModelCatalog',
    requestId: requestId ?? FALLBACK_REQUEST_ID,
    entries,
  });
}

async function artifactPage(
  msg: Record<string, unknown>,
  requestId: string | null,
  services: CompanyCommandServices,
  send: Send,
): Promise<void> {
  const artifactId = stringField(msg, 'artifactId');
  const offset = numberField(msg, 'offset') ?? 0;
  const limit = Math.min(
    numberField(msg, 'limit') ?? COMPANY_ARTIFACT_PAGE_BYTES,
    COMPANY_ARTIFACT_PAGE_BYTES,
  );
  if (!artifactId) {
    fail(send, requestId, 'invalid_artifact_id', 'Cần có artifactId.');
    return;
  }
  const page = await services.store.readArtifact(artifactId, offset, limit);
  send({ type: 'companyArtifactPage', requestId: requestId ?? FALLBACK_REQUEST_ID, page });
}

async function fileList(
  msg: Record<string, unknown>,
  requestId: string | null,
  services: CompanyCommandServices,
  send: Send,
): Promise<void> {
  const requested = stringField(msg, 'path');
  if (requested === null) {
    fail(send, requestId, 'invalid_path', 'Cần có đường dẫn tương đối so với workspace.');
    return;
  }
  const entries = await listWorkspaceFiles(services.workspaceRoot, requested);
  send({
    type: 'companyFileList',
    requestId: requestId ?? FALLBACK_REQUEST_ID,
    path: requested,
    entries,
  });
}

async function fileRead(
  msg: Record<string, unknown>,
  requestId: string | null,
  services: CompanyCommandServices,
  send: Send,
): Promise<void> {
  const requested = stringField(msg, 'path');
  if (requested === null) {
    fail(send, requestId, 'invalid_path', 'Cần có đường dẫn tương đối so với workspace.');
    return;
  }
  const offset = numberField(msg, 'offset') ?? 0;
  const limit = numberField(msg, 'limit') ?? COMPANY_FILE_DEFAULT_PAGE_BYTES;
  const content = await readWorkspaceFile(services.workspaceRoot, requested, offset, limit);
  send({ type: 'companyFileRead', requestId: requestId ?? FALLBACK_REQUEST_ID, content });
}

async function sessionLogPage(
  msg: Record<string, unknown>,
  requestId: string | null,
  services: CompanyCommandServices,
  send: Send,
): Promise<void> {
  const sessionId = stringField(msg, 'sessionId');
  const limit = msg.limit === undefined ? SESSION_LOG_DEFAULT_LIMIT : numberField(msg, 'limit');
  if (
    sessionId === null ||
    !isSessionLogId(sessionId) ||
    limit === null ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > SESSION_LOG_MAX_LIMIT
  ) {
    fail(
      send,
      requestId,
      'invalid_session_log_request',
      'Cần có sessionId hợp lệ và limit từ 1 đến 500.',
    );
    return;
  }
  const entries = await readSessionLog(
    sessionLogDirectory(services.store.namespaceDir),
    sessionId,
    limit,
  );
  send({
    type: 'companySessionLog',
    requestId: requestId ?? FALLBACK_REQUEST_ID,
    sessionId,
    replay: true,
    entries,
  });
}

async function attachmentUpload(
  msg: Record<string, unknown>,
  requestId: string | null,
  services: CompanyCommandServices,
  send: Send,
): Promise<void> {
  const fileName = stringField(msg, 'fileName');
  const mediaType = stringField(msg, 'mediaType');
  const dataBase64 = stringField(msg, 'dataBase64');
  if (!fileName || !mediaType || dataBase64 === null) {
    fail(send, requestId, 'invalid_attachment', 'Cần có fileName, mediaType và dataBase64.');
    return;
  }
  const bytes = Buffer.from(dataBase64, 'base64');
  // Buffer.from silently drops invalid base64, so a payload that does not
  // round-trip is rejected rather than stored truncated.
  if (
    bytes.length === 0 ||
    bytes.toString('base64').replace(/=+$/, '') !== dataBase64.replace(/=+$/, '')
  ) {
    fail(send, requestId, 'invalid_attachment', 'Payload tệp đính kèm không phải base64 hợp lệ.');
    return;
  }
  if (bytes.length > COMPANY_ATTACHMENT_MAX_BYTES) {
    fail(send, requestId, 'attachment_too_large', 'Tệp đính kèm vượt quá hạn mức kích thước.');
    return;
  }
  const artifactId = await services.store.writeArtifact(bytes, mediaType);
  const attachment: PromptAttachment = {
    artifactId,
    fileName,
    mediaType,
    byteLength: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
  send({
    type: 'companyAttachmentUploaded',
    requestId: requestId ?? FALLBACK_REQUEST_ID,
    attachment,
  });
}

function requireTerminal(
  requestId: string | null,
  services: CompanyCommandServices,
  send: Send,
): CompanyTerminalGateway | null {
  if (services.terminal) return services.terminal;
  fail(send, requestId, 'terminal_unavailable', 'Chưa cài đặt khả năng terminal gốc.');
  return null;
}

async function terminalAttach(
  msg: Record<string, unknown>,
  requestId: string | null,
  services: CompanyCommandServices,
  send: Send,
  ctx: CompanyCommandContext,
): Promise<void> {
  const sessionId = stringField(msg, 'sessionId');
  const runEpoch = numberField(msg, 'runEpoch');
  if (!sessionId || runEpoch === null) {
    fail(send, requestId, 'invalid_terminal_attach', 'Cần có sessionId và runEpoch.');
    return;
  }
  const terminal = requireTerminal(requestId, services, send);
  if (!terminal) return;
  const cols = numberField(msg, 'cols') ?? COMPANY_DEFAULT_TERMINAL_COLS;
  const rows = numberField(msg, 'rows') ?? COMPANY_DEFAULT_TERMINAL_ROWS;
  let notifiedLeaseId: string | null = null;
  const handle = await terminal.attach(sessionId, runEpoch, cols, rows, (leaseId) => {
    notifiedLeaseId = leaseId;
    ctx.onTerminalAttached?.(sessionId, leaseId);
  });
  if (notifiedLeaseId !== handle.leaseId) {
    ctx.onTerminalAttached?.(sessionId, handle.leaseId);
  }
  send({
    type: 'terminalAttached',
    requestId: requestId ?? FALLBACK_REQUEST_ID,
    sessionId,
    runEpoch,
    leaseId: handle.leaseId,
    cols: handle.cols,
    rows: handle.rows,
  });
}

async function terminalInput(
  msg: Record<string, unknown>,
  requestId: string | null,
  services: CompanyCommandServices,
  send: Send,
): Promise<void> {
  const sessionId = stringField(msg, 'sessionId');
  const runEpoch = numberField(msg, 'runEpoch');
  const data = stringField(msg, 'data');
  const leaseId = stringField(msg, 'leaseId');
  if (!sessionId || runEpoch === null || data === null || !leaseId) {
    fail(
      send,
      requestId,
      'invalid_terminal_input',
      'Cần có sessionId, runEpoch, data và leaseId.',
    );
    return;
  }
  if (Buffer.byteLength(data, 'utf-8') > COMPANY_TERMINAL_INPUT_MAX_BYTES) {
    fail(
      send,
      requestId,
      'terminal_input_too_large',
      `Chunk input vượt quá ${COMPANY_TERMINAL_INPUT_MAX_BYTES} byte.`,
    );
    return;
  }
  const terminal = requireTerminal(requestId, services, send);
  if (!terminal) return;
  await terminal.write(sessionId, runEpoch, data, leaseId);
  ok(send, requestId);
}

async function terminalResize(
  msg: Record<string, unknown>,
  requestId: string | null,
  services: CompanyCommandServices,
  send: Send,
): Promise<void> {
  const sessionId = stringField(msg, 'sessionId');
  const runEpoch = numberField(msg, 'runEpoch');
  const cols = numberField(msg, 'cols');
  const rows = numberField(msg, 'rows');
  const leaseId = stringField(msg, 'leaseId');
  if (!sessionId || runEpoch === null || cols === null || rows === null || !leaseId) {
    fail(
      send,
      requestId,
      'invalid_terminal_resize',
      'Cần có sessionId, runEpoch, cols, rows và leaseId.',
    );
    return;
  }
  const terminal = requireTerminal(requestId, services, send);
  if (!terminal) return;
  await terminal.resize(sessionId, runEpoch, cols, rows, leaseId);
  ok(send, requestId);
}

async function terminalDetach(
  msg: Record<string, unknown>,
  requestId: string | null,
  services: CompanyCommandServices,
  send: Send,
  ctx: CompanyCommandContext,
): Promise<void> {
  const sessionId = stringField(msg, 'sessionId');
  const runEpoch = numberField(msg, 'runEpoch');
  const leaseId = stringField(msg, 'leaseId');
  if (!sessionId || runEpoch === null || !leaseId) {
    fail(
      send,
      requestId,
      'invalid_terminal_detach',
      'Cần có sessionId, runEpoch và leaseId.',
    );
    return;
  }
  const terminal = requireTerminal(requestId, services, send);
  if (!terminal) return;
  await terminal.detach(sessionId, runEpoch, leaseId);
  ctx.onTerminalDetached?.(sessionId, leaseId);
  ok(send, requestId);
}

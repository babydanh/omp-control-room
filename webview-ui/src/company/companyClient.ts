/**
 * companyClient: the one place company messages are sent and received.
 *
 * The app keeps exactly ONE `transport.onMessage` subscription (in
 * useCompanyTransport); it hands company messages here instead of this class
 * subscribing for itself. That rule is why `accept` is a public method rather
 * than something the constructor wires up.
 *
 * What this class owns:
 *  - the reduced view state (companyState.ts owns the rules),
 *  - the effects a reduction asks for (a gap asks for a snapshot; an artifact
 *    whose page reported `eof: false` asks for the next one),
 *  - batching: text deltas coalesce for COMPANY_TEXT_BATCH_MS so a fast model
 *    cannot re-render the UI per token,
 *  - sending, and reporting what happened. `transport.send` THROWS for an
 *    action it refuses to queue across a disconnect; that is caught here and
 *    returned, which is what lets the composer keep the user's text.
 */

import type { QuestionAnswerInput, RoleProfile } from '../../../core/src/company.js';
import { TRANSPORT_DISCONNECTED_ERROR } from '../../../core/src/messageDelivery.js';
import type {
  ClientMessage,
  HerdrKey,
  ServerMessage,
  SquadRowInput,
  SquadSettings,
  WorkItemAssignee,
  WorkItemVerdict,
} from '../../../core/src/messages.js';
import type { MessageTransport } from '../transport/types.js';
import { decodeBase64ToBytes } from './base64.js';
import { type CommandResultView, failureNotice } from './commandResults.js';
import * as commands from './companyMessages.js';
import {
  applyCompanyMessage,
  applyFocusFolder,
  applyViewMode,
  type CompanyEffect,
  type CompanySelection,
  type CompanyViewState,
  emptyCompanyState,
} from './companyState.js';
import {
  COMPANY_TERMINAL_INPUT_CHUNK_BYTES,
  COMPANY_TEXT_BATCH_MS,
  HERDR_SCREEN_LINES,
} from './constants.js';
import { type FolderPrefsStorage, loadFolderPrefs, saveFolderPrefs } from './folderPrefs.js';
import {
  type CompanyViewMode,
  focusFolder,
  FOLDER_LIST_LOADING_MESSAGE,
  folderListLoading,
} from './folderView.js';
import {
  EMPTY_PROMPT_DRAFT,
  planSubmit,
  promptBlockReason,
  type PromptRoute,
  promptSubmitInput,
} from './promptSubmission.js';
import { selectionWith } from './selection.js';
import { type UsageHistoryDays, usageSlotSent, type UsageState } from './usage/usageState.js';

export interface SendOutcome {
  ok: boolean;
  errorCode?: string;
  message?: string;
}

/**
 * A herdr command: the request it went out under, and whether the send itself
 * went out. The server's verdict arrives later as a companyCommandResult.
 */
export type CompanyCommandHandle = SendOutcome & { requestId: string };

const SENT: SendOutcome = { ok: true };
/** Shown when a dropped socket means a command's verdict is no longer coming. */
const LOST_VERDICT_MESSAGE =
  'Mất kết nối trước khi có kết quả; chưa rõ lệnh đã được xử lý hay chưa.';

/** The refusal code for a folder-scoped command sent before the server's folder list arrived. */
const WORKSPACES_LOADING_CODE = 'workspaces_loading';

/** Who keeps a session's terminal lease: the drawer's console or a hover preview. */
export type TerminalHolder = 'drawer' | 'preview';

export class CompanyClient {
  private readonly transport: MessageTransport;
  private readonly storage: FolderPrefsStorage | null;
  private state: CompanyViewState;
  private readonly listeners = new Set<() => void>();
  private reattachTerminalAfterSnapshot = false;
  /** Text deltas waiting for the next flush. */
  private bufferedDeltas: ServerMessage[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private lastFlushAt = 0;
  /** Offset and folder requested per artifact, so paging never runs ahead of itself. */
  private readonly artifactOffsets = new Map<
    string,
    { offset: number; workspacePath: string | undefined }
  >();
  /** Verdict waiters, keyed by the requestId of the command they wait for. */
  private readonly commandWaiters = new Map<string, (result: CommandResultView) => void>();
  /** Holders per session; the lease is released when the last one lets go. */
  private readonly terminalHolds = new Map<string, Set<TerminalHolder>>();

  constructor(transport: MessageTransport, storage: FolderPrefsStorage | null = null) {
    this.transport = transport;
    this.storage = storage;
    const prefs = loadFolderPrefs(storage);
    this.state = emptyCompanyState({ viewMode: prefs.viewMode, focusPath: prefs.lastFolder });
  }

  /** Stable identity for `useSyncExternalStore`. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getState = (): CompanyViewState => this.state;

  /**
   * Entry point for the app's single transport subscription. Foreign messages
   * are ignored rather than thrown on.
   */
  accept(message: ServerMessage): void {
    if (message.type === 'companyTextDelta') {
      this.bufferedDeltas.push(message);
      const sinceFlush = Date.now() - this.lastFlushAt;
      if (sinceFlush >= COMPANY_TEXT_BATCH_MS) {
        this.flushDeltas();
        return;
      }
      if (this.flushTimer === null) {
        this.flushTimer = setTimeout(() => this.flushDeltas(), COMPANY_TEXT_BATCH_MS - sinceFlush);
      }
      return;
    }
    this.reduce(message);
  }

  private flushDeltas(): void {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.lastFlushAt = Date.now();
    const buffered = this.bufferedDeltas;
    if (buffered.length === 0) return;
    this.bufferedDeltas = [];
    for (const message of buffered) this.reduce(message);
  }

  private reduce(message: ServerMessage): void {
    const result = applyCompanyMessage(this.state, message);
    const next = result.state;
    const shouldReattach = message.type === 'companySnapshot' && this.reattachTerminalAfterSnapshot;
    if (shouldReattach) this.reattachTerminalAfterSnapshot = false;
    this.state = next;
    this.emit();
    for (const effect of result.effects) this.runEffect(effect);
    if (shouldReattach) {
      // Held sessions and the selected one all need a fresh lease after a resync.
      const sessionIds = new Set(this.terminalHolds.keys());
      if (this.state.selection.sessionId !== null) sessionIds.add(this.state.selection.sessionId);
      for (const sessionId of sessionIds) this.attachTerminal(sessionId);
    }
    this.continueArtifacts();
    if (message.type === 'companyCommandResult') this.settleCommandWaiter(message.requestId);
  }

  private runEffect(effect: CompanyEffect): void {
    switch (effect.type) {
      case 'requestSnapshot':
        this.requestSnapshot(false, effect.workspacePath);
        return;
      case 'requestModelCatalog':
        this.requestModelCatalog();
        return;
      case 'reAttachTerminal':
        this.attachTerminal(effect.sessionId);
        return;
    }
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  /** Resolve whoever waits on a command's verdict, once that verdict is held. */
  private settleCommandWaiter(requestId: string): void {
    const waiter = this.commandWaiters.get(requestId);
    const verdict = this.state.commandResults[requestId];
    if (waiter === undefined || verdict === undefined) return;
    this.commandWaiters.delete(requestId);
    waiter(verdict);
  }

  /**
   * Send a command, converting the transport's refusal into an outcome the UI
   * can show. Nothing is queued here on purpose: an action is either sent now
   * or not at all.
   */
  private send(message: ClientMessage): SendOutcome {
    try {
      this.transport.send(message);
      return SENT;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const disconnected = detail === TRANSPORT_DISCONNECTED_ERROR;
      return {
        ok: false,
        errorCode: disconnected ? detail : 'company_send_failed',
        message: disconnected
          ? 'Không có kết nối. Không có gì được gửi đi; nội dung của bạn vẫn được giữ nguyên.'
          : detail,
      };
    }
  }

  // ── Reads ────────────────────────────────────────────────────────────────

  /**
   * Called when the transport (re)connects: a reconnect starts from a fresh
   * snapshot, because changes that happened while the socket was down were
   * never delivered.
   */
  connect(): void {
    // A verdict for a command sent before the drop will never arrive; its waiter is told now.
    for (const [requestId, waiter] of this.commandWaiters) {
      waiter({
        requestId,
        ok: false,
        errorCode: TRANSPORT_DISCONNECTED_ERROR,
        message: LOST_VERDICT_MESSAGE,
      });
    }
    this.commandWaiters.clear();
    const terminals = { ...this.state.terminals };
    let invalidated = false;
    for (const [sessionId, terminal] of Object.entries(terminals)) {
      if (!terminal.attached && terminal.leaseId === null) continue;
      terminals[sessionId] = { ...terminal, attached: false, leaseId: null };
      invalidated = true;
    }
    if (invalidated) {
      this.state = { ...this.state, terminals };
      this.emit();
    }
    this.reattachTerminalAfterSnapshot = true;
    // The server starts each connection in folder mode, so this board's view is sent first.
    this.send(commands.companyViewMode(commands.newRequestId(), this.state.viewMode));
    const outcome = this.send(commands.companySnapshotRequest(commands.newRequestId()));
    if (!outcome.ok) this.reattachTerminalAfterSnapshot = false;
  }

  // ── Folder view ──────────────────────────────────────────────────────────

  /**
   * Switch between every open folder and one. The server is told the mode first, so the
   * snapshot it answers with covers the new view. The choice is remembered for this webview.
   */
  setViewMode(mode: CompanyViewMode): void {
    if (this.state.viewMode === mode) return;
    this.state = applyViewMode(this.state, mode);
    saveFolderPrefs(this.storage, { viewMode: mode, lastFolder: this.state.focusPath });
    this.emit();
    this.send(commands.companyViewMode(commands.newRequestId(), mode));
    this.requestSnapshot();
  }

  /** Remember the folder new work goes to; in `all` mode the composer and the file browser read it. */
  setFocusFolder(path: string): void {
    if (this.state.focusPath === path) return;
    this.state = applyFocusFolder(this.state, path);
    saveFolderPrefs(this.storage, { viewMode: this.state.viewMode, lastFolder: path });
    this.emit();
  }

  /** The folder new work and folder-scoped reads go to; undefined when the server has sent no folder list. */
  private targetFolder(): string | undefined {
    return focusFolder(this.state) ?? undefined;
  }

  requestSnapshot(withDiagnostics = false, workspacePath?: string): void {
    this.send(
      commands.companySnapshotRequest(commands.newRequestId(), withDiagnostics, workspacePath),
    );
  }

  /** Stop every omp headless browser with no open page now, ignoring the grace period. */
  reapIdleBrowsers(): SendOutcome {
    return this.send(commands.browserReaperReapNow());
  }

  /** The board only asks for diagnostics while it is actually on screen. */
  requestDiagnostics(): void {
    this.requestSnapshot(true);
  }

  requestModelCatalog(): void {
    this.send(commands.modelCatalogRequest(commands.newRequestId(), this.targetFolder()));
  }

  requestArtifact(artifactId: string): void {
    this.artifactOffsets.delete(artifactId);
    this.fetchArtifactPage(artifactId, 0, this.targetFolder());
  }

  private fetchArtifactPage(
    artifactId: string,
    offset: number,
    workspacePath: string | undefined,
  ): void {
    this.artifactOffsets.set(artifactId, { offset, workspacePath });
    this.send(
      commands.artifactRequest(
        commands.newRequestId(),
        artifactId,
        offset,
        undefined,
        workspacePath,
      ),
    );
  }

  /** Pull the next page of an artifact whose last page reported `eof: false`. */
  private continueArtifacts(): void {
    for (const [artifactId, { offset: requestedOffset, workspacePath }] of this.artifactOffsets) {
      const view = this.state.artifacts[artifactId];
      if (!view) continue;
      if (view.eof) {
        this.artifactOffsets.delete(artifactId);
        continue;
      }
      const last = view.pages[view.pages.length - 1];
      if (!last) continue;
      const nextOffset = last.offset + decodeBase64ToBytes(last.dataBase64).length;
      if (nextOffset <= requestedOffset) continue;
      this.fetchArtifactPage(artifactId, nextOffset, workspacePath);
    }
  }

  listFiles(path: string): void {
    this.send(commands.fileListRequest(commands.newRequestId(), path, this.targetFolder()));
  }

  readFile(path: string, offset = 0): void {
    this.send(
      commands.fileReadRequest(
        commands.newRequestId(),
        path,
        offset,
        undefined,
        this.targetFolder(),
      ),
    );
  }

  /**
   * Ask for a session's log. The answer is a companySessionLog with
   * `replay: true`; the reducer merges it by seq with anything that arrived
   * before it.
   */
  requestSessionLog(sessionId: string): SendOutcome {
    return this.send(commands.sessionLogRequest(commands.newRequestId(), sessionId));
  }

  /**
   * Ask for a session's agent info. The answer is a companySessionInfo; a refusal is a
   * companyCommandResult under the handle's requestId.
   */
  requestSessionInfo(sessionId: string): CompanyCommandHandle {
    return this.command((requestId) => commands.sessionInfoRequest(requestId, sessionId));
  }

  // ── Writes ───────────────────────────────────────────────────────────────

  /**
   * Send the draft along a route. The draft keeps its text until the server's verdict
   * says otherwise; a route the send itself refuses is reported here.
   */
  submitPrompt(route: PromptRoute): SendOutcome {
    const blocker = promptBlockReason(this.state.prompt);
    if (blocker !== null) return { ok: false, errorCode: 'prompt_invalid', message: blocker };
    const requestId = commands.newRequestId();
    const plan = planSubmit(this.state.prompt, requestId, route);
    // A prompt with no target session opens or picks one, so it names the folder it goes to.
    const opensSession = route.targetSessionId === null;
    const folder = opensSession ? this.targetFolder() : undefined;
    // Until the folder list arrives there is no folder to name, so the prompt is refused unsent.
    const outcome: SendOutcome =
      opensSession && folderListLoading(this.state)
        ? { ok: false, errorCode: WORKSPACES_LOADING_CODE, message: FOLDER_LIST_LOADING_MESSAGE }
        : this.send(commands.promptSubmit(plan.input, folder));
    // The draft keeps its text either way: the server clears it on an `ok` result,
    // and a refusal leaves the user looking at what they wrote.
    this.state = {
      ...this.state,
      prompt: outcome.ok
        ? plan.state
        : {
            ...this.state.prompt,
            pendingSubmit: null,
            error: {
              requestId,
              errorCode: outcome.errorCode ?? 'company_send_failed',
              message: outcome.message,
            },
          },
    };
    this.emit();
    return outcome;
  }

  /**
   * Send one prompt to one session from the hover preview. The composer's draft is left
   * alone: the verdict lands under the handle's requestId, where the preview reads it.
   */
  sendSessionPrompt(route: PromptRoute, text: string): CompanyCommandHandle {
    const requestId = commands.newRequestId();
    const blocker = promptBlockReason({ ...EMPTY_PROMPT_DRAFT, text });
    if (blocker !== null) {
      return { requestId, ok: false, errorCode: 'prompt_invalid', message: blocker };
    }
    return {
      requestId,
      ...this.send(commands.promptSubmit(promptSubmitInput(requestId, text, route))),
    };
  }

  decideContract(
    contractId: string,
    revision: number,
    decision: 'approve' | 'reject',
    note?: string,
  ): SendOutcome {
    return this.send(
      commands.contractDecision(commands.newRequestId(), contractId, revision, decision, note),
    );
  }

  answerQuestion(input: QuestionAnswerInput): SendOutcome {
    return this.send(commands.questionAnswer(input));
  }

  /**
   * Stop, kill, archive or delete a session. The server's verdict is a companyCommandResult
   * under the handle's requestId; a refusal (for example, a delete while work is held)
   * carries its own message.
   */
  controlSession(sessionId: string, action: commands.SessionControlAction): CompanyCommandHandle {
    const runEpoch = this.state.sessions[sessionId]?.runEpoch;
    if (runEpoch === undefined) {
      return {
        requestId: commands.newRequestId(),
        ok: false,
        errorCode: 'session_not_found',
        message: 'Phiên đó không còn tồn tại.',
      };
    }
    return this.command((requestId) =>
      commands.sessionControl(requestId, sessionId, runEpoch, action),
    );
  }

  /**
   * Open a new omp chat session in the folder, with no prompt. The verdict is a
   * companyCommandResult under the handle's requestId; its `sessionId` names the new session.
   * Refused while the folder list is still loading, since the session would name no folder.
   */
  newChatSession(): CompanyCommandHandle {
    if (folderListLoading(this.state)) return this.folderListLoadingHandle();
    return this.command((requestId) => commands.chatNew(requestId, this.targetFolder()));
  }

  /**
   * Rename a session. The verdict is a companyCommandResult under the handle's requestId;
   * a refused send is reported on the handle itself.
   */
  renameSession(sessionId: string, name: string): CompanyCommandHandle {
    return this.command((requestId) => commands.sessionRename(requestId, sessionId, name));
  }

  /**
   * File a new work item for an agent in a folder. The verdict is a companyCommandResult under
   * the handle's requestId and names the new item in `workItemId`.
   */
  createWorkItem(
    workspacePath: string,
    text: string,
    assignee: WorkItemAssignee,
    options: commands.WorkItemCreateOptions = {},
  ): CompanyCommandHandle {
    return this.command((requestId) =>
      commands.workItemCreate(requestId, workspacePath, text, assignee, options),
    );
  }

  /**
   * Hand an existing work item to another agent, with its fields. The verdict is a
   * companyCommandResult.
   */
  assignWorkItem(
    workspacePath: string,
    id: string,
    assignee: WorkItemAssignee,
    fields: commands.WorkItemFields = {},
  ): CompanyCommandHandle {
    return this.command((requestId) =>
      commands.workItemAssign(requestId, workspacePath, id, assignee, fields),
    );
  }

  /** Send more text to the agent holding a work item. The verdict is a companyCommandResult. */
  followUpWorkItem(workspacePath: string, id: string, text: string): CompanyCommandHandle {
    return this.command((requestId) =>
      commands.workItemFollowUp(requestId, workspacePath, id, text),
    );
  }

  /** Close a work item as done or failed. The verdict is a companyCommandResult. */
  markWorkItem(
    workspacePath: string,
    id: string,
    verdict: WorkItemVerdict,
  ): CompanyCommandHandle {
    return this.command((requestId) =>
      commands.workItemMark(requestId, workspacePath, id, verdict),
    );
  }

  /** Withdraw a work item that is still queued. The verdict is a companyCommandResult. */
  cancelWorkItem(workspacePath: string, id: string): CompanyCommandHandle {
    return this.command((requestId) => commands.workItemCancel(requestId, workspacePath, id));
  }

  /** Judge a review item again. The verdict is a companyCommandResult. */
  judgeWorkItem(workspacePath: string, id: string): CompanyCommandHandle {
    return this.command((requestId) => commands.workItemJudge(requestId, workspacePath, id));
  }

  /** Remove the worktree of a done item. The verdict is a companyCommandResult. */
  cleanWorkItemWorktree(workspacePath: string, id: string): CompanyCommandHandle {
    return this.command((requestId) =>
      commands.workItemCleanWorktree(requestId, workspacePath, id),
    );
  }

  /**
   * Replace the items a queued work item waits for; an empty list clears them. The verdict is a
   * companyCommandResult.
   */
  setWorkItemDependencies(
    workspacePath: string,
    id: string,
    dependsOn: string[],
  ): CompanyCommandHandle {
    return this.command((requestId) =>
      commands.workItemDependencies(requestId, workspacePath, id, dependsOn),
    );
  }

  /** Set the description of an agent's role in a folder. The verdict is a companyCommandResult. */
  setAgentRole(
    workspacePath: string,
    agent: WorkItemAssignee,
    description: string,
  ): CompanyCommandHandle {
    return this.command((requestId) =>
      commands.agentRoleSet(requestId, workspacePath, agent, description),
    );
  }

  /**
   * Ask a folder's team to plan a request. The verdict is a companyCommandResult under the
   * handle's requestId and names the run it started in `squadRunId`.
   */
  startSquad(workspacePath: string, text: string): CompanyCommandHandle {
    return this.command((requestId) => commands.squadRequest(requestId, workspacePath, text));
  }

  /**
   * Ask a folder's team to plan the next step after a review item. The verdict is a
   * companyCommandResult under the handle's requestId and names the run in `squadRunId`.
   */
  requestSquadFromWorkItem(workspacePath: string, workItemId: string): CompanyCommandHandle {
    return this.command((requestId) =>
      commands.squadRequestFromWorkItem(requestId, workspacePath, workItemId),
    );
  }

  /** Approve a proposal with the rows the drawer sends. The verdict is a companyCommandResult. */
  approveSquad(
    workspacePath: string,
    runId: string,
    proposalId: string,
    rows: SquadRowInput[],
  ): CompanyCommandHandle {
    return this.command((requestId) =>
      commands.squadApprove(requestId, workspacePath, runId, proposalId, rows),
    );
  }

  /** Dismiss a proposal, closing its run. The verdict is a companyCommandResult. */
  dismissSquad(workspacePath: string, runId: string, proposalId: string): CompanyCommandHandle {
    return this.command((requestId) =>
      commands.squadDismiss(requestId, workspacePath, runId, proposalId),
    );
  }

  /** Retry a failed run. The verdict is a companyCommandResult. */
  retrySquad(workspacePath: string, runId: string): CompanyCommandHandle {
    return this.command((requestId) => commands.squadRetry(requestId, workspacePath, runId));
  }

  cancelSquad(workspacePath: string, runId: string): CompanyCommandHandle {
    return this.command((requestId) => commands.squadCancel(requestId, workspacePath, runId));
  }

  removeSquad(workspacePath: string, runId: string): CompanyCommandHandle {
    return this.command((requestId) => commands.squadRemove(requestId, workspacePath, runId));
  }

  replySquad(workspacePath: string, runId: string, text: string): CompanyCommandHandle {
    return this.command((requestId) =>
      commands.squadReply(requestId, workspacePath, runId, text),
    );
  }

  closeSquad(workspacePath: string, runId: string): CompanyCommandHandle {
    return this.command((requestId) =>
      commands.squadClose(requestId, workspacePath, runId),
    );
  }

  /** Save one folder's squad settings. The verdict is a companyCommandResult. */
  setSquadSettings(workspacePath: string, settings: SquadSettings): CompanyCommandHandle {
    return this.command((requestId) =>
      commands.squadSettingsSet(requestId, workspacePath, settings),
    );
  }

  /** Ask the server whether Claude Code is installed and signed in. The answer comes as a work-items snapshot. */
  checkClaudeCode(workspacePath: string): SendOutcome {
    return this.send(commands.squadClaudeCheck(commands.newRequestId(), workspacePath));
  }

  updateRoleProfiles(roleProfiles: Record<string, RoleProfile>): SendOutcome {
    return this.send(
      commands.settingsUpdate(commands.newRequestId(), roleProfiles, this.targetFolder()),
    );
  }

  /**
   * Withdraw a prompt no Contract holds yet. The verdict is a companyCommandResult under
   * the handle's requestId.
   */
  cancelPrompt(promptId: string): CompanyCommandHandle {
    return this.command((requestId) => commands.promptCancel(requestId, promptId));
  }

  /**
   * Ask for the omp sessions saved for the folder the board points at. The answer is a
   * companyOmpSessions; a refused send is reported on the handle itself.
   */
  requestOmpSessions(): CompanyCommandHandle {
    return this.command((requestId) => commands.ompSessionsRequest(requestId, this.targetFolder()));
  }

  /** Resume a saved omp session on the board. The verdict names the session it opened. */
  resumeSession(file: string): CompanyCommandHandle {
    if (folderListLoading(this.state)) return this.folderListLoadingHandle();
    const folder = this.state.ompSessions?.folder ?? this.targetFolder();
    return this.command((requestId) => commands.sessionResume(requestId, file, folder));
  }

  /**
   * List the folders under `path`, or the start view when none is named. The listing arrives
   * as a companyFolderBrowse held for the board's latest browse; a refusal is a
   * companyCommandResult under the handle's requestId. Refused while the folder list loads.
   */
  browseFolders(path?: string): CompanyCommandHandle {
    if (folderListLoading(this.state)) return this.folderListLoadingHandle();
    const requestId = commands.newRequestId();
    this.state = { ...this.state, folderBrowseRequest: requestId };
    this.emit();
    return { requestId, ...this.send(commands.folderBrowseRequest(requestId, path)) };
  }

  /**
   * Create a folder inside `parentPath`. The verdict is a companyCommandResult under the
   * handle's requestId. Refused while the folder list is loading.
   */
  createFolder(parentPath: string, name: string): CompanyCommandHandle {
    if (folderListLoading(this.state)) return this.folderListLoadingHandle();
    return this.command((requestId) => commands.folderCreate(requestId, parentPath, name));
  }

  /**
   * Give the folder at `path` a display name; an empty name removes it. The verdict is a
   * companyCommandResult under the handle's requestId.
   */
  renameFolder(path: string, name: string): CompanyCommandHandle {
    return this.command((requestId) => commands.folderName(requestId, path, name));
  }

  /**
   * Take the folder at `path` off the folder list; an open one is stopped first, unless it still
   * has work. The verdict is a companyCommandResult under the handle's requestId.
   */
  forgetFolder(path: string): CompanyCommandHandle {
    return this.command((requestId) => commands.folderForget(requestId, path));
  }

  /**
   * Point the board at another folder. The verdict is a companyCommandResult under the
   * handle's requestId; a success is followed by a snapshot and a companyWorkspaces.
   */
  openWorkspace(path: string): CompanyCommandHandle {
    return this.sendWorkspaceOpen(path, null);
  }

  /**
   * Point the board at another folder and select one of its sessions once the switch is
   * accepted and the folder's snapshot holds that session. A refused switch selects nothing
   * and leaves a notice saying why.
   */
  openWorkspaceSession(path: string, sessionId: string): CompanyCommandHandle {
    return this.sendWorkspaceOpen(path, sessionId);
  }

  /** Send one folder switch; a session chosen with it waits for the switch's verdict. */
  private sendWorkspaceOpen(path: string, sessionId: string | null): CompanyCommandHandle {
    // Pointing the board at one folder is what folder mode is for; that folder is remembered.
    this.setFocusFolder(path);
    this.setViewMode('folder');
    const requestId = commands.newRequestId();
    const pending = sessionId === null ? null : { requestId, path, sessionId, confirmed: false };
    this.state = {
      ...this.state,
      pendingWorkspaceOpen: requestId,
      pendingWorkspaceSelection: pending,
      workspaceSelectionNotice: null,
    };
    const outcome = this.send(commands.workspaceOpen(requestId, path));
    if (!outcome.ok) {
      this.state = {
        ...this.state,
        pendingWorkspaceOpen: null,
        pendingWorkspaceSelection: null,
        workspaceSelectionNotice:
          pending === null ? null : failureNotice(outcome, 'Không gửi được yêu cầu mở thư mục.'),
      };
    }
    this.emit();
    return { requestId, ...outcome };
  }

  /**
   * Resolves with a command's verdict: at once when it is already held, or with the
   * refusal when the send itself failed. A verdict lost to a dropped socket resolves as a
   * transport failure (see connect).
   */
  waitForCommand(handle: CompanyCommandHandle): Promise<CommandResultView> {
    const held = this.state.commandResults[handle.requestId];
    if (held !== undefined) return Promise.resolve(held);
    if (!handle.ok) {
      return Promise.resolve({
        requestId: handle.requestId,
        ok: false,
        errorCode: handle.errorCode,
        message: handle.message,
      });
    }
    return new Promise<CommandResultView>((resolve) => {
      this.commandWaiters.set(handle.requestId, resolve);
    });
  }

  // ── Usage ────────────────────────────────────────────────────────────────

  /**
   * Ask for the account limits. The answer is a usageLimits under the handle's requestId; a
   * refusal is a companyCommandResult under the same id. The slot shows loading at once.
   */
  requestUsageLimits(force = false): CompanyCommandHandle {
    const handle = this.command((requestId) => commands.usageLimitsRequest(requestId, force));
    const slots = this.state.usageSlots;
    this.setUsageSlots({ ...slots, limits: usageSlotSent(slots.limits, handle) });
    return handle;
  }

  /** Ask for the limit history and per-client burn over `days` days. The answer is a usageHistory. */
  requestUsageHistory(days: UsageHistoryDays, force = false): CompanyCommandHandle {
    const handle = this.command((requestId) =>
      commands.usageHistoryRequest(requestId, days, force),
    );
    const slots = this.state.usageSlots;
    this.setUsageSlots({
      ...slots,
      history: { ...slots.history, [days]: usageSlotSent(slots.history[days], handle) },
    });
    return handle;
  }

  /** Ask for the token, cost and performance totals. The answer is a usageStats. */
  requestUsageStats(force = false): CompanyCommandHandle {
    const handle = this.command((requestId) => commands.usageStatsRequest(requestId, force));
    const slots = this.state.usageSlots;
    this.setUsageSlots({ ...slots, stats: usageSlotSent(slots.stats, handle) });
    return handle;
  }

  private setUsageSlots(usageSlots: UsageState): void {
    this.state = { ...this.state, usageSlots };
    this.emit();
  }

  // ── Herdr ────────────────────────────────────────────────────────────────

  /**
   * Every command that expects an answer mints its own requestId, so the answer
   * can be matched back to it. A read answers with its own reply message; the
   * other commands answer with a companyCommandResult under the requestId.
   */
  private command(build: (requestId: string) => ClientMessage): CompanyCommandHandle {
    const requestId = commands.newRequestId();
    return { requestId, ...this.send(build(requestId)) };
  }

  /**
   * The refusal for a folder-scoped command sent before the server's folder list arrived. It
   * names no folder, so nothing is sent.
   */
  private folderListLoadingHandle(): CompanyCommandHandle {
    return {
      requestId: commands.newRequestId(),
      ok: false,
      errorCode: WORKSPACES_LOADING_CODE,
      message: FOLDER_LIST_LOADING_MESSAGE,
    };
  }

  herdrRead(paneId: string, lines = HERDR_SCREEN_LINES): CompanyCommandHandle {
    return this.command((requestId) => commands.herdrRead(requestId, paneId, lines));
  }

  herdrPrompt(paneId: string, text: string): CompanyCommandHandle {
    return this.command((requestId) => commands.herdrPrompt(requestId, paneId, text));
  }

  herdrKeys(paneId: string, keys: HerdrKey[]): CompanyCommandHandle {
    return this.command((requestId) => commands.herdrKeys(requestId, paneId, keys));
  }

  herdrFocus(paneId: string): CompanyCommandHandle {
    return this.command((requestId) => commands.herdrFocus(requestId, paneId));
  }

  /** Starts, renews, or ends the server's push watch on a pane's screen. */
  herdrWatch(paneId: string, watching: boolean): CompanyCommandHandle {
    return this.command((requestId) => commands.herdrWatch(requestId, paneId, watching));
  }

  herdrRename(paneId: string, name: string): CompanyCommandHandle {
    return this.command((requestId) => commands.herdrRename(requestId, paneId, name));
  }

  /** Close a herdr pane; herdr's subsequent roster refresh removes it from the board. */
  herdrClose(paneId: string): CompanyCommandHandle {
    return this.command((requestId) => commands.herdrClose(requestId, paneId));
  }

  /**
   * Wake a hibernated session. The answer is the standard command result under the
   * handle's requestId: ok, or a refusal the server words for the user.
   */
  herdrWake(paneId: string, prompt?: string): CompanyCommandHandle {
    return this.command((requestId) => commands.herdrWake(requestId, paneId, prompt));
  }

  /**
   * Ask for an agent's info. The answer is a herdrInfo; a refusal is a
   * companyCommandResult under the handle's requestId.
   */
  requestHerdrInfo(paneId: string): CompanyCommandHandle {
    return this.command((requestId) => commands.herdrInfoRequest(requestId, paneId));
  }

  private terminalLease(sessionId: string, runEpoch: number): string | null {
    const terminal = this.state.terminals[sessionId];
    if (!terminal?.attached || terminal.runEpoch !== runEpoch) return null;
    return terminal.leaseId;
  }

  /**
   * Keep a session's terminal attached while anyone holds it. The first holder
   * attaches; the last one to release detaches. Holders share one lease.
   */
  holdTerminal(sessionId: string, holder: TerminalHolder): () => void {
    const holders = this.terminalHolds.get(sessionId) ?? new Set<TerminalHolder>();
    const wasFree = holders.size === 0;
    holders.add(holder);
    this.terminalHolds.set(sessionId, holders);
    if (wasFree) this.attachTerminal(sessionId);
    return () => this.releaseTerminal(sessionId, holder);
  }

  private releaseTerminal(sessionId: string, holder: TerminalHolder): void {
    const holders = this.terminalHolds.get(sessionId);
    if (!holders || !holders.delete(holder) || holders.size > 0) return;
    this.terminalHolds.delete(sessionId);
    this.detachTerminal(sessionId);
  }

  // ── Terminal ─────────────────────────────────────────────────────────────

  attachTerminal(sessionId: string): SendOutcome {
    const session = this.state.sessions[sessionId];
    if (!session) {
      return { ok: false, errorCode: 'session_not_found', message: 'Phiên đó không còn tồn tại.' };
    }
    return this.send(commands.terminalAttach(commands.newRequestId(), sessionId, session.runEpoch));
  }

  detachTerminal(sessionId: string): SendOutcome {
    const session = this.state.sessions[sessionId];
    if (!session) return { ok: false, errorCode: 'session_not_found' };
    const leaseId = this.terminalLease(sessionId, session.runEpoch);
    if (!leaseId) return { ok: false, errorCode: 'terminal_not_attached' };
    return this.send(commands.terminalDetach(sessionId, session.runEpoch, leaseId));
  }

  /** Keystrokes go out in chunks the server accepts, once, never queued. */
  writeTerminal(sessionId: string, runEpoch: number, data: string): SendOutcome {
    const leaseId = this.terminalLease(sessionId, runEpoch);
    if (!leaseId) return { ok: false, errorCode: 'terminal_not_attached' };
    for (const chunk of chunkInput(data)) {
      const outcome = this.send(commands.terminalInput(sessionId, runEpoch, chunk, leaseId));
      if (!outcome.ok) return outcome;
    }
    return SENT;
  }

  resizeTerminal(sessionId: string, runEpoch: number, cols: number, rows: number): SendOutcome {
    const leaseId = this.terminalLease(sessionId, runEpoch);
    if (!leaseId) return { ok: false, errorCode: 'terminal_not_attached' };
    const outcome = this.send(commands.terminalResize(sessionId, runEpoch, cols, rows, leaseId));
    if (outcome.ok) this.setTerminalSize(sessionId, cols, rows);
    return outcome;
  }

  private setTerminalSize(sessionId: string, cols: number, rows: number): void {
    const terminal = this.state.terminals[sessionId];
    if (!terminal) return;
    this.state = {
      ...this.state,
      terminals: { ...this.state.terminals, [sessionId]: { ...terminal, cols, rows } },
    };
    this.emit();
  }

  // ── Local view state ─────────────────────────────────────────────────────

  select(selection: Partial<CompanySelection>): void {
    this.state = {
      ...this.state,
      selection: selectionWith(this.state.selection, selection),
      // Choosing a session or a herdr agent abandons one that was still on its way.
      openingSessionId:
        selection.sessionId === undefined && selection.herdrPaneId === undefined
          ? this.state.openingSessionId
          : null,
    };
    this.emit();
  }

  setDraftText(text: string): void {
    this.state = { ...this.state, prompt: { ...this.state.prompt, text } };
    this.emit();
  }

  dispose(): void {
    this.flushDeltas();
    this.listeners.clear();
  }
}

/** Split terminal input into chunks the server will accept in one message. */
function chunkInput(data: string): string[] {
  const encoder = new TextEncoder();
  const chunks: string[] = [];
  let offset = 0;
  while (offset < data.length) {
    let end = offset;
    while (
      end < data.length &&
      encoder.encode(data.slice(offset, end + 1)).length <= COMPANY_TERMINAL_INPUT_CHUNK_BYTES
    ) {
      end += 1;
    }
    // A single code point wider than the limit still has to go somewhere.
    if (end === offset) end = offset + 1;
    chunks.push(data.slice(offset, end));
    offset = end;
  }
  return chunks;
}

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
import type { ClientMessage, HerdrKey, ServerMessage } from '../../../core/src/messages.js';
import type { MessageTransport } from '../transport/types.js';
import { decodeBase64ToBytes } from './base64.js';
import * as commands from './companyMessages.js';
import {
  applyCompanyMessage,
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
import { planSubmit, promptBlockReason } from './promptSubmission.js';

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

export class CompanyClient {
  private readonly transport: MessageTransport;
  private state: CompanyViewState = emptyCompanyState();
  private readonly listeners = new Set<() => void>();
  private reattachTerminalAfterSnapshot = false;
  /** Text deltas waiting for the next flush. */
  private bufferedDeltas: ServerMessage[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private lastFlushAt = 0;
  /** Offset requested per artifact, so paging never runs ahead of itself. */
  private readonly artifactOffsets = new Map<string, number>();

  constructor(transport: MessageTransport) {
    this.transport = transport;
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
    let next = result.state;
    // A selection pointing at something the server no longer has would open a
    // drawer for a task that does not exist.
    if (next.selection.taskId !== null && next.tasks[next.selection.taskId] === undefined) {
      next = { ...next, selection: { ...next.selection, taskId: null } };
    }
    if (
      next.selection.sessionId !== null &&
      next.sessions[next.selection.sessionId] === undefined
    ) {
      next = { ...next, selection: { ...next.selection, sessionId: null } };
    }
    const shouldReattach = message.type === 'companySnapshot' && this.reattachTerminalAfterSnapshot;
    if (shouldReattach) this.reattachTerminalAfterSnapshot = false;
    this.state = next;
    this.emit();
    for (const effect of result.effects) this.runEffect(effect);
    if (shouldReattach && this.state.selection.sessionId !== null) {
      this.attachTerminal(this.state.selection.sessionId);
    }
    this.continueArtifacts();
  }

  private runEffect(effect: CompanyEffect): void {
    switch (effect.type) {
      case 'requestSnapshot':
        this.requestSnapshot();
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
    const outcome = this.send(commands.companySnapshotRequest(commands.newRequestId()));
    if (!outcome.ok) this.reattachTerminalAfterSnapshot = false;
  }

  requestSnapshot(withDiagnostics = false): void {
    this.send(commands.companySnapshotRequest(commands.newRequestId(), withDiagnostics));
  }

  /** The board only asks for diagnostics while it is actually on screen. */
  requestDiagnostics(): void {
    this.requestSnapshot(true);
  }

  requestModelCatalog(): void {
    this.send(commands.modelCatalogRequest(commands.newRequestId()));
  }

  requestArtifact(artifactId: string): void {
    this.artifactOffsets.delete(artifactId);
    this.fetchArtifactPage(artifactId, 0);
  }

  private fetchArtifactPage(artifactId: string, offset: number): void {
    this.artifactOffsets.set(artifactId, offset);
    this.send(commands.artifactRequest(commands.newRequestId(), artifactId, offset));
  }

  /** Pull the next page of an artifact whose last page reported `eof: false`. */
  private continueArtifacts(): void {
    for (const [artifactId, requestedOffset] of this.artifactOffsets) {
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
      this.fetchArtifactPage(artifactId, nextOffset);
    }
  }

  listFiles(path: string): void {
    this.send(commands.fileListRequest(commands.newRequestId(), path));
  }

  readFile(path: string, offset = 0): void {
    this.send(commands.fileReadRequest(commands.newRequestId(), path, offset));
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

  submitPrompt(): SendOutcome {
    const blocker = promptBlockReason(this.state.prompt);
    if (blocker !== null) return { ok: false, errorCode: 'prompt_invalid', message: blocker };
    const requestId = commands.newRequestId();
    const plan = planSubmit(this.state.prompt, requestId, this.state.selection.sessionId);
    const outcome = this.send(commands.promptSubmit(plan.input));
    // The draft keeps its text either way: the server clears it on an `ok`
    // result, and a refusal leaves the user looking at what they wrote.
    this.state = {
      ...this.state,
      prompt: outcome.ok
        ? plan.state
        : {
            ...plan.state,
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

  controlSession(
    sessionId: string,
    action: 'pause' | 'resume' | 'kill' | 'restart' | 'archive',
  ): SendOutcome {
    const runEpoch = this.state.sessions[sessionId]?.runEpoch;
    if (runEpoch === undefined) {
      return { ok: false, errorCode: 'session_not_found', message: 'Phiên đó không còn tồn tại.' };
    }
    return this.send(commands.sessionControl(commands.newRequestId(), sessionId, runEpoch, action));
  }

  /**
   * Rename a session. The verdict is a companyCommandResult under the handle's requestId;
   * a refused send is reported on the handle itself.
   */
  renameSession(sessionId: string, name: string): CompanyCommandHandle {
    return this.command((requestId) => commands.sessionRename(requestId, sessionId, name));
  }

  updateRoleProfiles(roleProfiles: Record<string, RoleProfile>): SendOutcome {
    return this.send(commands.settingsUpdate(commands.newRequestId(), roleProfiles));
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

  herdrRename(paneId: string, name: string): CompanyCommandHandle {
    return this.command((requestId) => commands.herdrRename(requestId, paneId, name));
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
    return this.send(commands.terminalResize(sessionId, runEpoch, cols, rows, leaseId));
  }
  // ── Local view state ─────────────────────────────────────────────────────

  select(selection: Partial<CompanySelection>): void {
    this.state = { ...this.state, selection: { ...this.state.selection, ...selection } };
    this.emit();
  }

  setModel(modelId: string | null): void {
    this.state = { ...this.state, selectedModel: modelId };
    this.emit();
  }

  setDraftText(text: string): void {
    this.state = { ...this.state, prompt: { ...this.state.prompt, text } };
    this.emit();
  }

  setDraftDelivery(delivery: 'prompt' | 'steer' | 'follow_up'): void {
    this.state = { ...this.state, prompt: { ...this.state.prompt, delivery } };
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

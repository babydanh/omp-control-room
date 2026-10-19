/**
 * WorkItemService: one folder's manual work items.
 *
 * A work item is a piece of work the user hands to one agent: a herdr pane, an omp session on the
 * board, or a new omp chat opened for it. The service stores items per folder, sends each to its
 * agent when that agent is free, queues it behind the agent's current work otherwise, and moves its
 * status as herdr and the session report back. Every change is published as a full
 * `companyWorkItems` message and saved to disk.
 *
 * The status rules live in `workItemModel.ts`. This module applies them and performs the side
 * effects through the injected ports, so tests run with fakes and no clock or socket.
 *
 * Phase 2 (squad leader) creates items through {@link WorkItemService.createWorkItems}.
 */

import type {
  AgentRole,
  CompanyWorkItemsMessage,
  HerdrAgent,
  WorkItemAssignee,
  WorkItemVerdict,
} from '../../../../core/src/messages.js';
import { CompanyError } from '../companyError.js';
import {
  type AgentObservation,
  assigneeKey,
  canCancel,
  canFollowUp,
  canMark,
  canReassign,
  clip,
  isFinished,
  isUuid,
  isWorkItemAssignee,
  makeEvent,
  normalizeAssignee,
  observeHerdrStatus,
  observeSessionStatus,
  occupiesAgent,
  type ParsedWorkItems,
  refuseText,
  ROLE_DESCRIPTION_MAX_CHARS,
  type StoredWorkItem,
  toWorkItem,
  WORK_ITEM_FINISHED_KEEP,
  WORK_ITEM_GRACE_MS,
  WORK_ITEM_HISTORY_MAX,
  WORK_ITEM_REASON,
  WORK_ITEM_REASON_MAX_CHARS,
  WORK_ITEM_RESULT_LINES,
  WORK_ITEM_RESULT_MAX_CHARS,
  type WorkItemDraft,
  type WorkItemsFile,
} from './workItemModel.js';

/** How many recent request ids are remembered, so a resent command answers the same way. */
const REQUEST_MEMORY_MAX = 256;

/** One herdr pane, as far as work items care. */
export interface WorkItemPaneView {
  readonly paneId: string;
  readonly status: HerdrAgent['status'];
}

/** herdr, as work items see it. `available` false means herdr cannot answer, so nothing is decided. */
export interface WorkItemRoster {
  panes(): { available: boolean; panes: readonly WorkItemPaneView[] };
  /** Types `text` into the pane as a prompt. Rejects when herdr refuses it. */
  prompt(paneId: string, text: string): Promise<void>;
  /** The pane's recent screen text, for a result. Rejects when herdr cannot read it. */
  screenText(paneId: string): Promise<string>;
}

/** One omp session, as far as work items care. */
export interface WorkItemSessionView {
  readonly id: string;
  readonly status: string;
  readonly role: string;
}

/** The folder's omp sessions. */
export interface WorkItemSessions {
  list(): readonly WorkItemSessionView[];
  /** Sends a prompt to a session. `mode` follows the session role, as the composer does. */
  submit(
    sessionId: string,
    text: string,
    mode: 'chat' | 'company',
    requestId: string,
  ): Promise<void>;
  /** Opens a new omp chat in the folder and returns its session id. */
  openChat(): Promise<string>;
}

/** Where the folder's file lives. */
export interface WorkItemPersistence {
  load(): Promise<ParsedWorkItems>;
  save(file: WorkItemsFile): Promise<void>;
}

/** Everything the service reaches outside itself. */
export interface WorkItemPorts {
  readonly roster: WorkItemRoster;
  readonly sessions: WorkItemSessions;
  readonly persistence: WorkItemPersistence;
  publish(message: CompanyWorkItemsMessage): void;
  now(): number;
  newId(): string;
  /** Runs `run` after `ms`. Returns a function that cancels it. */
  schedule(run: () => void, ms: number): () => void;
}

/** A command the board sent. The request id makes a resent command harmless. */
export interface WorkItemCommand {
  readonly requestId: string;
}

/** Vietnamese refusals the board shows. */
const MESSAGE = {
  notFound: 'Không tìm thấy việc đó.',
  busy: 'Agent đang làm việc này. Chờ agent xong rồi mới thao tác.',
  status: 'Việc đang ở trạng thái này nên không thực hiện được.',
  herdrUnavailable: 'herdr chưa kết nối nên chưa giao được cho pane này.',
  paneUnknown: 'Pane herdr đó không còn trong danh sách.',
  sessionUnknown: 'Phiên omp đó không còn trên bảng.',
  assigneeInvalid: 'Người nhận việc không hợp lệ.',
  roleInvalid: 'Mô tả vai trò quá dài.',
  emptyText: 'Nội dung việc không được để trống.',
  promptTooLarge: 'Nội dung việc vượt quá giới hạn.',
  done: 'Việc đã xong.',
} as const;

/** Keeps a short text of an error for a reason line. */
function describe(error: unknown): string {
  return error instanceof Error ? clip(error.message, 200) : 'lỗi không rõ';
}

/** The last non-empty screen lines, as a result. Undefined when the screen is empty. */
function summarizeScreen(text: string): string | undefined {
  const lines = text
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== '');
  if (lines.length === 0) return undefined;
  return clip(lines.slice(-WORK_ITEM_RESULT_LINES).join('\n'), WORK_ITEM_RESULT_MAX_CHARS);
}

/** Live items are the ones still owed work: waiting for an agent, or holding one. */
function isLive(item: StoredWorkItem): boolean {
  return item.status === 'queued' || occupiesAgent(item.status);
}

/** Work items for one folder, with their queue, status, and role notes. */
export class WorkItemService {
  private readonly workspacePath: string;
  private readonly ports: WorkItemPorts;
  private readonly items = new Map<string, StoredWorkItem>();
  private roles: AgentRole[] = [];
  private revision = 0;
  private nextSequence = 0;
  /** Items the agent was seen working on, so its return to free means it finished. */
  private readonly observedBusy = new Set<string>();
  /** Answers to recent commands by request id; the work item id for a create, '' otherwise. */
  private readonly answers = new Map<string, string>();
  private readonly cancelTimers = new Set<() => void>();
  private loop: Promise<void> | null = null;
  private again = false;
  private writeChain: Promise<void> = Promise.resolve();
  private saveError: unknown = null;
  /** Whether the newest write failed. Nothing is sent to an agent until its state is on disk. */
  private lastWriteFailed = false;
  private disposed = false;

  constructor(workspacePath: string, ports: WorkItemPorts) {
    this.workspacePath = workspacePath;
    this.ports = ports;
  }

  /** Reads the folder's file. Call once, before any command. */
  async load(): Promise<void> {
    const parsed = await this.ports.persistence.load();
    this.revision = parsed.file.revision;
    this.nextSequence = parsed.file.nextSequence;
    this.roles = parsed.file.roles;
    for (const item of parsed.file.items) this.items.set(item.id, item);
    // A running item from before this start gets its grace check again.
    if ([...this.items.values()].some((item) => item.status === 'running'))
      this.scheduleGraceCheck();
  }

  /** The folder's full state, as the board receives it. */
  snapshot(): CompanyWorkItemsMessage {
    const items = [...this.items.values()]
      .sort((a, b) => a.sequence - b.sequence)
      .map((item) => toWorkItem(item));
    return {
      type: 'companyWorkItems',
      workspacePath: this.workspacePath,
      revision: this.revision,
      items,
      roles: this.roles.map((role) => ({ ...role, agent: { ...role.agent } })),
    };
  }

  /**
   * Creates one item for an assignee and sends it, or queues it while the assignee is busy. The
   * same request id twice creates nothing new and answers with the first item's id.
   */
  async create(command: WorkItemCommand & WorkItemDraft): Promise<string> {
    const replayed = this.replay(command.requestId);
    if (replayed !== undefined) return replayed;
    this.validateDraft(command);
    const item = this.addItem(command);
    this.remember(command.requestId, item.id);
    await this.commitOrDiscard([item.id], command.requestId);
    await this.reconcileAfterSave();
    return item.id;
  }

  /**
   * Phase 2 entry point: creates several items for one squad run. Idempotent by `squadRunId`: a
   * run that already has items answers with those ids and creates nothing more.
   */
  async createWorkItems(
    drafts: readonly WorkItemDraft[],
    options: { squadRunId: string },
  ): Promise<string[]> {
    if (!isUuid(options.squadRunId)) {
      throw new CompanyError('invalid_request', 'Mã lượt squad phải là UUID.');
    }
    const existing = [...this.items.values()]
      .filter((item) => item.squadRunId === options.squadRunId)
      .sort((a, b) => a.sequence - b.sequence)
      .map((item) => item.id);
    if (existing.length > 0) return existing;
    for (const draft of drafts) this.validateDraft(draft);
    const ids = drafts.map((draft) => this.addItem(draft, options.squadRunId).id);
    await this.commitOrDiscard(ids, null);
    await this.reconcileAfterSave();
    return ids;
  }

  /** Gives an item to another assignee, sends it, or queues it there. Refused while it is running. */
  async assign(
    command: WorkItemCommand & { id: string; assignee: WorkItemAssignee },
  ): Promise<void> {
    if (this.replay(command.requestId) !== undefined) return;
    const item = this.requireItem(command.id);
    this.refuseUnlessReassignable(item);
    if (!isWorkItemAssignee(command.assignee)) {
      throw new CompanyError('assignee_invalid', MESSAGE.assigneeInvalid);
    }
    this.assertReachable(command.assignee);
    const before = structuredClone(item);
    item.assignee = normalizeAssignee(command.assignee);
    this.requeue(item, item.text, 'assigned', 'Giao lại cho agent khác.');
    this.remember(command.requestId, '');
    await this.commitOrRestore(before, command.requestId);
    await this.reconcileAfterSave();
  }

  /** Sends one more prompt to an item's assignee. Only for items in review or failed. */
  async followUp(command: WorkItemCommand & { id: string; text: string }): Promise<void> {
    if (this.replay(command.requestId) !== undefined) return;
    const item = this.requireItem(command.id);
    this.refuseUnlessFollowable(item);
    const refusal = refuseText(command.text);
    if (refusal !== null) throw this.textError(refusal);
    const text = command.text.trim();
    this.assertReachable(item.assignee);
    const before = structuredClone(item);
    this.requeue(item, text, 'followed_up', clip(text, WORK_ITEM_REASON_MAX_CHARS));
    this.remember(command.requestId, '');
    await this.commitOrRestore(before, command.requestId);
    await this.reconcileAfterSave();
  }

  /**
   * Runs a pass once a command's change is on disk. The command already succeeded: a save that
   * fails during this pass leaves the item queued with WORK_ITEM_REASON.saveFailed (nothing is
   * sent), and the item shows that, so the failure is not reported as the command's.
   */
  private async reconcileAfterSave(): Promise<void> {
    await this.reconcileNow();
    await this.writeChain;
    this.saveError = null;
  }

  /** The user's verdict: done or failed. Sends nothing to any agent. */
  async mark(command: WorkItemCommand & { id: string; verdict: WorkItemVerdict }): Promise<void> {
    if (this.replay(command.requestId) !== undefined) return;
    const item = this.requireItem(command.id);
    if (!canMark(item.status, command.verdict)) {
      throw new CompanyError(
        'work_item_status',
        item.status === 'done' ? MESSAGE.done : MESSAGE.status,
      );
    }
    const at = this.iso();
    this.observedBusy.delete(item.id);
    item.status = command.verdict;
    item.updatedAt = at;
    if (command.verdict === 'done') {
      delete item.reason;
      this.pushEvent(item, makeEvent(at, 'status', 'Bạn đánh dấu xong.'));
    } else {
      item.reason = WORK_ITEM_REASON.markedFailed;
      this.pushEvent(item, makeEvent(at, 'status', WORK_ITEM_REASON.markedFailed));
    }
    this.remember(command.requestId, '');
    this.commit();
    await this.flush();
  }

  /** Removes a queued item that was never sent. */
  async cancel(command: WorkItemCommand & { id: string }): Promise<void> {
    if (this.replay(command.requestId) !== undefined) return;
    const item = this.requireItem(command.id);
    if (!canCancel(item.status)) this.refuseStatus(item);
    this.items.delete(item.id);
    this.remember(command.requestId, '');
    this.commit();
    await this.flush();
  }

  /** Saves the role note for a herdr pane or an omp session. An empty description clears it. */
  async setRole(
    command: WorkItemCommand & { agent: WorkItemAssignee; description: string },
  ): Promise<void> {
    if (this.replay(command.requestId) !== undefined) return;
    if (!isWorkItemAssignee(command.agent) || command.agent.kind === 'new-session') {
      throw new CompanyError('assignee_invalid', MESSAGE.assigneeInvalid);
    }
    if (Array.from(command.description).length > ROLE_DESCRIPTION_MAX_CHARS) {
      throw new CompanyError('role_invalid', MESSAGE.roleInvalid);
    }
    const agent = normalizeAssignee(command.agent);
    const key = assigneeKey(agent);
    const description = command.description.trim();
    this.roles = this.roles.filter((role) => assigneeKey(role.agent) !== key);
    if (description !== '') {
      this.roles.push({ agent, description, updatedAt: this.iso() });
    }
    this.remember(command.requestId, '');
    this.commit();
    await this.flush();
  }

  /**
   * Runs the status pass now. Calls made while a pass runs join that pass, which runs again once
   * more if anything changed. Resolves when the pass that covers the call is done.
   */
  reconcileNow(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.loop !== null) {
      this.again = true;
      return this.loop;
    }
    const run = (async (): Promise<void> => {
      do {
        this.again = false;
        try {
          await this.pass();
        } catch {
          // A failed pass changes nothing it did not commit. The next pass retries.
        }
      } while (this.again && !this.disposed);
    })();
    this.loop = run.finally(() => {
      this.loop = null;
    });
    return this.loop;
  }

  /** Fire-and-forget form of {@link reconcileNow}, for triggers that have no caller to wait for. */
  scheduleReconcile(): void {
    void this.reconcileNow();
  }

  /** Cancels timers and stops further passes. Callers that already started a pass finish it. */
  dispose(): void {
    this.disposed = true;
    for (const cancel of this.cancelTimers) cancel();
    this.cancelTimers.clear();
  }

  private replay(requestId: string): string | undefined {
    return this.answers.get(requestId);
  }

  private remember(requestId: string, workItemId: string): void {
    if (this.answers.size >= REQUEST_MEMORY_MAX) {
      const oldest = this.answers.keys().next().value;
      if (oldest !== undefined) this.answers.delete(oldest);
    }
    this.answers.set(requestId, workItemId);
  }

  /**
   * Saves newly created items before anything is sent. When the save fails they are dropped
   * again (and the request forgotten), so a refused command never reaches an agent later.
   */
  private async commitOrDiscard(ids: readonly string[], requestId: string | null): Promise<void> {
    this.commit();
    try {
      await this.flush();
    } catch (error) {
      for (const id of ids) this.items.delete(id);
      if (requestId !== null) this.answers.delete(requestId);
      this.commit();
      throw error;
    }
  }

  /**
   * Saves a requeued item before anything is sent. When the save fails the item goes back to
   * how it was (and the request is forgotten), so a refused command never reaches an agent later.
   */
  private async commitOrRestore(before: StoredWorkItem, requestId: string): Promise<void> {
    this.commit();
    try {
      await this.flush();
    } catch (error) {
      this.items.set(before.id, before);
      this.answers.delete(requestId);
      this.commit();
      throw error;
    }
  }

  /** Waits for pending writes; true when the newest one reached the disk. Keeps the error for flush. */
  private async writesLanded(): Promise<boolean> {
    await this.writeChain;
    return !this.lastWriteFailed;
  }

  private requireItem(id: string): StoredWorkItem {
    const item = this.items.get(id);
    if (item === undefined) throw new CompanyError('work_item_not_found', MESSAGE.notFound);
    return item;
  }

  private textError(refusal: 'empty_text' | 'prompt_too_large'): CompanyError {
    return refusal === 'empty_text'
      ? new CompanyError('empty_text', MESSAGE.emptyText)
      : new CompanyError('prompt_too_large', MESSAGE.promptTooLarge);
  }

  private validateDraft(draft: WorkItemDraft): void {
    const refusal = refuseText(draft.text);
    if (refusal !== null) throw this.textError(refusal);
    if (!isWorkItemAssignee(draft.assignee)) {
      throw new CompanyError('assignee_invalid', MESSAGE.assigneeInvalid);
    }
    this.assertReachable(draft.assignee);
  }

  /** Refuses an assignee the board cannot reach right now. New sessions are always reachable. */
  private assertReachable(assignee: WorkItemAssignee): void {
    if (assignee.kind === 'new-session') return;
    if (assignee.kind === 'herdr') {
      const roster = this.ports.roster.panes();
      if (!roster.available) throw new CompanyError('herdr_unavailable', MESSAGE.herdrUnavailable);
      if (!roster.panes.some((pane) => pane.paneId === assignee.paneId)) {
        throw new CompanyError('assignee_unknown', MESSAGE.paneUnknown);
      }
      return;
    }
    const session = this.ports.sessions.list().find((entry) => entry.id === assignee.sessionId);
    if (session === undefined || observeSessionStatus(session.status) === 'gone') {
      throw new CompanyError('assignee_unknown', MESSAGE.sessionUnknown);
    }
  }

  private refuseStatus(item: StoredWorkItem): never {
    if (occupiesAgent(item.status)) throw new CompanyError('work_item_busy', MESSAGE.busy);
    throw new CompanyError('work_item_status', MESSAGE.status);
  }

  private refuseUnlessReassignable(item: StoredWorkItem): void {
    if (!canReassign(item.status)) this.refuseStatus(item);
  }

  private refuseUnlessFollowable(item: StoredWorkItem): void {
    if (!canFollowUp(item.status)) this.refuseStatus(item);
  }

  private iso(): string {
    return new Date(this.ports.now()).toISOString();
  }

  private pushEvent(item: StoredWorkItem, event: StoredWorkItem['history'][number]): void {
    item.history = [...item.history, event].slice(-WORK_ITEM_HISTORY_MAX);
  }

  /** Adds a new queued item. Nothing is sent here; the pass decides when. */
  private addItem(draft: WorkItemDraft, squadRunId?: string): StoredWorkItem {
    const at = this.iso();
    const text = draft.text.trim();
    const item: StoredWorkItem = {
      id: this.ports.newId(),
      text,
      assignee: normalizeAssignee(draft.assignee),
      status: 'queued',
      sequence: this.nextSequence,
      reason: WORK_ITEM_REASON.queued,
      createdAt: at,
      updatedAt: at,
      history: [makeEvent(at, 'created'), makeEvent(at, 'queued')],
      pendingPrompt: text,
      ...(squadRunId === undefined ? {} : { squadRunId }),
    };
    this.nextSequence += 1;
    this.items.set(item.id, item);
    return item;
  }

  /** Puts an item back in its assignee's queue, owing `prompt` to the agent. */
  private requeue(
    item: StoredWorkItem,
    prompt: string,
    kind: 'assigned' | 'followed_up',
    message: string,
  ): void {
    const at = this.iso();
    this.observedBusy.delete(item.id);
    item.status = 'queued';
    item.sequence = this.nextSequence;
    this.nextSequence += 1;
    item.pendingPrompt = prompt;
    item.reason = WORK_ITEM_REASON.queued;
    item.updatedAt = at;
    delete item.result;
    delete item.dispatchedAt;
    this.pushEvent(item, makeEvent(at, kind, message));
    this.pushEvent(item, makeEvent(at, 'queued'));
  }

  /** Persists and publishes the current state. Persistence runs in order, one write at a time. */
  private commit(): void {
    this.revision += 1;
    this.prune();
    const file = structuredClone(this.toFile());
    this.ports.publish(this.snapshot());
    this.writeChain = this.writeChain
      .then(() => this.ports.persistence.save(file))
      .then(() => {
        this.lastWriteFailed = false;
      })
      .catch((error: unknown) => {
        this.saveError = error;
        this.lastWriteFailed = true;
      });
  }

  /** Waits for pending writes and reports the last failed one, so a command can say so. */
  private async flush(): Promise<void> {
    await this.writeChain;
    const error = this.saveError;
    this.saveError = null;
    if (error !== null) {
      throw new CompanyError('company_command_failed', 'Không lưu được việc. Thử lại sau.', {
        cause: error,
      });
    }
  }

  private toFile(): WorkItemsFile {
    return {
      version: 1,
      revision: this.revision,
      nextSequence: this.nextSequence,
      items: [...this.items.values()],
      roles: this.roles,
    };
  }

  /** Keeps the newest finished items; live items are never pruned. */
  private prune(): void {
    const finished = [...this.items.values()]
      .filter((item) => isFinished(item.status))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    for (const item of finished.slice(WORK_ITEM_FINISHED_KEEP)) this.items.delete(item.id);
  }

  /** One status pass over every agent that has live items. */
  private async pass(): Promise<void> {
    const roster = this.ports.roster.panes();
    const sessions = this.ports.sessions.list();
    const observe = (assignee: WorkItemAssignee): AgentObservation => {
      if (assignee.kind === 'new-session') return 'free';
      if (assignee.kind === 'herdr') {
        if (!roster.available) return 'unknown';
        const pane = roster.panes.find((entry) => entry.paneId === assignee.paneId);
        return pane === undefined ? 'gone' : observeHerdrStatus(pane.status);
      }
      const session = sessions.find((entry) => entry.id === assignee.sessionId);
      return session === undefined ? 'gone' : observeSessionStatus(session.status);
    };
    // Read the keys before dispatching new-session items below: a chat opened there is not in
    // this pass's session list, so it is judged on the next pass.
    const keys = this.liveAgentKeys();
    // A new-session item has no agent to wait for: its chat opens as soon as it is queued.
    for (const item of this.sortedItems()) {
      if (item.status === 'queued' && item.assignee.kind === 'new-session') {
        await this.dispatch(item);
      }
    }
    for (const key of keys) {
      const items = this.liveItemsFor(key);
      const first = items[0];
      if (first === undefined) continue;
      const observation = observe(first.assignee);
      if (observation === 'unknown') continue;
      if (observation === 'gone') {
        const reason =
          first.assignee.kind === 'herdr'
            ? WORK_ITEM_REASON.herdrGone
            : WORK_ITEM_REASON.sessionGone;
        for (const item of items) this.fail(item, reason);
        continue;
      }
      const active = items.find((item) => occupiesAgent(item.status));
      if (active !== undefined) {
        await this.advance(active, observation);
        continue;
      }
      const next = items.find((item) => item.status === 'queued');
      if (observation === 'free' && next !== undefined) await this.dispatch(next);
    }
  }

  /** Keys of the agents that have live items, in order of their oldest live item. */
  private liveAgentKeys(): string[] {
    const keys = new Map<string, number>();
    for (const item of this.sortedItems()) {
      if (!isLive(item) || item.assignee.kind === 'new-session') continue;
      const key = assigneeKey(item.assignee);
      if (!keys.has(key)) keys.set(key, item.sequence);
    }
    return [...keys.keys()];
  }

  private liveItemsFor(key: string): StoredWorkItem[] {
    return this.sortedItems().filter((item) => isLive(item) && assigneeKey(item.assignee) === key);
  }

  private sortedItems(): StoredWorkItem[] {
    return [...this.items.values()].sort((a, b) => a.sequence - b.sequence);
  }

  /** Moves a running or waiting item along, given what its agent is doing now. */
  private async advance(item: StoredWorkItem, observation: AgentObservation): Promise<void> {
    if (observation === 'busy') {
      if (item.status === 'needs_input')
        this.setStatus(item, 'running', undefined, 'Agent làm tiếp.');
      this.observedBusy.add(item.id);
      return;
    }
    if (observation === 'blocked') {
      if (item.status === 'running') {
        const reason =
          item.assignee.kind === 'herdr'
            ? WORK_ITEM_REASON.needsInputHerdr
            : WORK_ITEM_REASON.needsInputSession;
        this.setStatus(item, 'needs_input', reason, reason);
      }
      return;
    }
    if (observation !== 'free') return;
    const dispatchedMs = item.dispatchedAt === undefined ? 0 : Date.parse(item.dispatchedAt);
    const elapsed = this.ports.now() - dispatchedMs;
    if (this.observedBusy.has(item.id) || elapsed >= WORK_ITEM_GRACE_MS) await this.complete(item);
  }

  private setStatus(
    item: StoredWorkItem,
    status: StoredWorkItem['status'],
    reason: string | undefined,
    message: string,
  ): void {
    const at = this.iso();
    item.status = status;
    item.updatedAt = at;
    if (reason === undefined) delete item.reason;
    else item.reason = reason;
    this.pushEvent(item, makeEvent(at, 'status', message));
    this.commit();
  }

  /** The agent stopped after working. The item goes to review, with the screen as its result. */
  private async complete(item: StoredWorkItem): Promise<void> {
    const before = item.status;
    const result =
      item.assignee.kind === 'herdr' && item.assignee.paneId !== undefined
        ? await this.readResult(item.assignee.paneId)
        : undefined;
    // The user may have acted while the screen was read; only a still-running item moves.
    if (item.status !== before || !occupiesAgent(item.status)) return;
    const at = this.iso();
    this.observedBusy.delete(item.id);
    item.status = 'review';
    item.updatedAt = at;
    item.reason = WORK_ITEM_REASON.review;
    if (result === undefined) delete item.result;
    else item.result = result;
    this.pushEvent(item, makeEvent(at, 'status', 'Agent đã dừng.'));
    this.again = true;
    this.commit();
  }

  private async readResult(paneId: string): Promise<string | undefined> {
    try {
      return summarizeScreen(await this.ports.roster.screenText(paneId));
    } catch {
      return undefined;
    }
  }

  private fail(item: StoredWorkItem, reason: string, message: string = reason): void {
    const at = this.iso();
    this.observedBusy.delete(item.id);
    item.status = 'failed';
    item.updatedAt = at;
    item.reason = clip(reason, WORK_ITEM_REASON_MAX_CHARS);
    this.pushEvent(item, makeEvent(at, 'status', message));
    this.again = true;
    this.commit();
  }

  /** Sends a queued item to its free agent. A new-session item first opens its chat. */
  private async dispatch(item: StoredWorkItem): Promise<void> {
    if (item.assignee.kind === 'new-session') {
      let sessionId: string;
      try {
        sessionId = await this.ports.sessions.openChat();
      } catch (error) {
        this.fail(item, WORK_ITEM_REASON.openFailed, describe(error));
        return;
      }
      item.assignee = { kind: 'session', sessionId };
      this.pushEvent(item, makeEvent(this.iso(), 'assigned', 'Mở phiên omp mới cho việc này.'));
    }
    const at = this.iso();
    const before = {
      dispatchedAt: item.dispatchedAt,
      updatedAt: item.updatedAt,
      reason: item.reason,
    };
    item.status = 'running';
    item.dispatchedAt = at;
    item.updatedAt = at;
    delete item.reason;
    delete item.result;
    this.pushEvent(item, makeEvent(at, 'dispatched'));
    this.commit();
    // The running state must be on disk before the agent gets the prompt: otherwise a restart
    // would find the item still queued and send it a second time.
    if (!(await this.writesLanded())) {
      if (item.status === 'running' && item.dispatchedAt === at) {
        item.status = 'queued';
        item.dispatchedAt = before.dispatchedAt;
        item.updatedAt = before.updatedAt;
        item.reason = WORK_ITEM_REASON.saveFailed;
        this.commit();
      }
      return;
    }
    try {
      await this.send(item.assignee, item.pendingPrompt);
    } catch (error) {
      if (item.status === 'running' && item.dispatchedAt === at) {
        const detail = describe(error);
        this.fail(item, WORK_ITEM_REASON.sendFailed(detail), detail);
      }
      return;
    }
    item.pendingPrompt = '';
    this.commit();
    this.scheduleGraceCheck();
  }

  private async send(assignee: WorkItemAssignee, text: string): Promise<void> {
    if (assignee.kind === 'herdr') {
      await this.ports.roster.prompt(assignee.paneId ?? '', text);
      return;
    }
    if (assignee.kind === 'session') {
      const sessionId = assignee.sessionId ?? '';
      const role = this.ports.sessions.list().find((entry) => entry.id === sessionId)?.role;
      await this.ports.sessions.submit(
        sessionId,
        text,
        role === 'chat' ? 'chat' : 'company',
        this.ports.newId(),
      );
      return;
    }
    throw new Error('new-session has no agent to send to yet');
  }

  /** Re-checks the pass once the grace window after a dispatch has passed. */
  private scheduleGraceCheck(): void {
    const cancel = this.ports.schedule(() => {
      this.cancelTimers.delete(cancel);
      this.scheduleReconcile();
    }, WORK_ITEM_GRACE_MS);
    this.cancelTimers.add(cancel);
  }
}

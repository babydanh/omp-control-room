/**
 * SquadService: one folder's squad leader.
 *
 * A request starts a squad run. The leader, one omp print-mode turn at a time, reads the request,
 * the team, and the run so far, and proposes assignments. The user approves, edits, or dismisses
 * each proposal; nothing reaches an agent before approval. Approved items report back through the
 * work item service, and a finished item triggers the next leader turn, up to a fixed number of
 * turns per run.
 *
 * The pure rules live in `squadModel.ts`. This module applies them and performs the side effects
 * through injected ports, so tests run with fakes and no real omp.
 */

import type {
  CompanySquadMessage,
  CompanyWorkItemsMessage,
  SquadProposal,
  WorkItem,
} from '../../../../core/src/messages.js';
import { CompanyError } from '../companyError.js';
import type { WorkItemDraft } from '../workItems/workItemModel.js';
import { clip, refuseText } from '../workItems/workItemModel.js';
import {
  appendEvent,
  assigneeRef,
  buildLeaderPrompt,
  isOpenItemStatus,
  type LeaderItemView,
  type LeaderReply,
  type ParsedSquadFile,
  parseLeaderReply,
  parseSquadRows,
  requestFromItem,
  reviewKey,
  rowsOf,
  SQUAD_CONTEXT_ITEMS_MAX,
  SQUAD_CONTEXT_RESULT_MAX_CHARS,
  SQUAD_CONTEXT_TEXT_MAX_CHARS,
  SQUAD_MAX_TURNS,
  SQUAD_RUNS_KEEP,
  type SquadApproval,
  squadEvent,
  type SquadFile,
  type SquadMember,
  squadProgress,
  type SquadReview,
  type StoredSquadRun,
  toWireRun,
} from './squadModel.js';
import { type LeaderRunner, SquadLeaderError } from './squadRunner.js';

/** Answers to recent commands kept, so a resent command is answered without repeating its work. */
const REQUEST_MEMORY_MAX = 256;

/** Run statuses that count as finished: they can be pruned and hold no turn. */
const FINISHED_STATUSES: readonly string[] = ['done', 'dismissed', 'stopped'];

/** The work item calls a squad makes. The work item service satisfies this. */
export interface SquadWorkItems {
  snapshot(): CompanyWorkItemsMessage;
  createWorkItems(
    drafts: readonly WorkItemDraft[],
    options: { squadRunId: string },
  ): Promise<string[]>;
  onChange(listener: () => void): () => void;
  onReview(listener: (item: WorkItem) => void): () => void;
  /** The work item with this id, if the service has it. */
  get(id: string): WorkItem | undefined;
  /** The open item (queued, running, waiting for input, or in review) with this #n, if any. */
  findOpen(sequence: number): WorkItem | undefined;
}

/** Where the squad file lives. */
export interface SquadPersistence {
  load(): Promise<ParsedSquadFile>;
  save(file: SquadFile): Promise<void>;
}

/** Everything the service reaches outside itself. */
export interface SquadPorts {
  readonly workItems: SquadWorkItems;
  /** The team as the leader sees it when a turn starts. */
  members(): readonly SquadMember[];
  readonly leader: LeaderRunner;
  readonly persistence: SquadPersistence;
  publish(message: CompanySquadMessage): void;
  now(): number;
  newId(): string;
}

export interface SquadServiceOptions {
  readonly workspacePath: string;
  /** The folder's name, shown to the leader. */
  readonly folderName: string;
}

/** A command the board sent. The request id makes a resent command harmless. */
export interface SquadCommand {
  readonly requestId: string;
}

/** A request the board sent: typed text, or a finished work item to ask the leader about. */
export interface SquadRequestCommand extends SquadCommand {
  readonly text?: string;
  readonly fromWorkItemId?: string;
}

/** Vietnamese refusals and notices the board shows. */
const MESSAGE = {
  noMembers: 'Chưa có thành viên nào trong thư mục này để đội trưởng giao việc.',
  notFound: 'Không tìm thấy đội đó.',
  proposalNotFound: 'Không tìm thấy đề xuất đó.',
  notRetryable: 'Đội này không ở trạng thái cần thử lại.',
  proposalDismissed: 'Đề xuất này đã bỏ.',
  proposalApproved: 'Đề xuất này đã duyệt, không bỏ được.',
  saveFailed: 'Không lưu được đội. Thử lại sau.',
  turnCap: `Đội đã dùng hết ${SQUAD_MAX_TURNS} lượt đề xuất. Hãy giao việc tiếp bằng tay hoặc tạo yêu cầu mới.`,
  interrupted: 'Đội trưởng bị gián đoạn khi board tắt. Thử lại để hỏi lại.',
  retried: 'Thử lại.',
  doneDefault: 'Đội đã xong.',
  unknownError: 'lỗi không rõ',
  requestShape:
    'Yêu cầu đội cần đúng một trong hai: nội dung, hoặc việc đã xong để hỏi đội trưởng bước tiếp.',
  itemNotFound: 'Không tìm thấy việc đó.',
  itemNotReviewable:
    'Chỉ hỏi đội trưởng bước tiếp từ việc đã xong (đang chờ duyệt) và không thuộc đội nào.',
} as const;

/** One folder's squad runs, their proposals, and the leader turns that produce them. */
export class SquadService {
  private readonly workspacePath: string;
  private readonly folderName: string;
  private readonly ports: SquadPorts;
  private readonly runs = new Map<string, StoredSquadRun>();
  private revision = 0;
  private writeChain: Promise<void> = Promise.resolve();
  private saveError: unknown = null;
  /** Answers to recent commands by request id: the run id for a request, '' otherwise. */
  private readonly answers = new Map<string, string>();
  /** Approvals in progress, by proposal id, so a double click approves once. */
  private readonly approvals = new Map<string, Promise<void>>();
  /** The last leader turn queued per run. Turns of one run run one after another. */
  private readonly turnQueue = new Map<string, Promise<void>>();
  /** Leader processes in flight, so dispose can stop them. */
  private readonly controllers = new Set<AbortController>();
  private readonly unsubscribes: (() => void)[] = [];
  private disposed = false;

  constructor(options: SquadServiceOptions, ports: SquadPorts) {
    this.workspacePath = options.workspacePath;
    this.folderName = options.folderName;
    this.ports = ports;
    this.unsubscribes.push(
      ports.workItems.onChange(() => this.onItemsChanged()),
      ports.workItems.onReview((item) => this.onItemReview(item)),
    );
  }

  /** Reads the folder's file. Call once, before any command. */
  async load(): Promise<void> {
    const parsed = await this.ports.persistence.load();
    this.revision = parsed.file.revision;
    for (const run of parsed.file.runs) this.runs.set(run.id, run);
    // A turn that was in flight when the board stopped never finished: say so, so it can be retried.
    let interrupted = false;
    for (const run of this.runs.values()) {
      if (
        run.status === 'planning' ||
        (run.status === 'working' && run.pendingReviews.length > 0)
      ) {
        this.setFailed(run, MESSAGE.interrupted, this.iso());
        interrupted = true;
      }
    }
    if (interrupted) this.commit();
  }

  /** The folder's squad state, as the board receives it. */
  snapshot(): CompanySquadMessage {
    const items = this.ports.workItems.snapshot().items;
    return {
      type: 'companySquad',
      workspacePath: this.workspacePath,
      revision: this.revision,
      runs: [...this.runs.values()].map((run) => toWireRun(run, squadProgress(run, items))),
    };
  }

  /**
   * Starts a squad run for a request: typed text, or a finished work item the leader should decide
   * on. The first leader turn starts once the run is saved.
   */
  async request(command: SquadRequestCommand): Promise<string> {
    const replayed = this.answers.get(command.requestId);
    if (replayed !== undefined) return replayed;
    const request = this.requestText(command);
    if (this.ports.members().length === 0)
      throw new CompanyError('squad_no_members', MESSAGE.noMembers);
    const at = this.iso();
    const run: StoredSquadRun = {
      id: this.ports.newId(),
      request,
      status: 'planning',
      turns: 0,
      proposals: [],
      pendingReviews: [],
      history: [squadEvent(at, 'request')],
      createdAt: at,
      updatedAt: at,
    };
    this.runs.set(run.id, run);
    this.remember(command.requestId, run.id);
    this.commit();
    try {
      await this.flush();
    } catch (error) {
      this.runs.delete(run.id);
      this.answers.delete(command.requestId);
      this.commit();
      await this.settleRollback();
      throw error;
    }
    this.scheduleTurn(run.id);
    return run.id;
  }

  /** The request's text: typed text or a finished work item, never both and never neither. */
  private requestText(command: SquadRequestCommand): string {
    if (command.text !== undefined && command.fromWorkItemId === undefined)
      return this.typedRequest(command.text);
    if (command.fromWorkItemId !== undefined && command.text === undefined)
      return this.itemRequest(command.fromWorkItemId);
    throw new CompanyError('invalid_request', MESSAGE.requestShape);
  }

  /** Refuses empty or oversized typed text, and returns it trimmed. */
  private typedRequest(text: string): string {
    const refusal = refuseText(text);
    if (refusal === 'empty_text')
      throw new CompanyError('empty_text', 'Nội dung yêu cầu không được để trống.');
    if (refusal === 'prompt_too_large')
      throw new CompanyError('prompt_too_large', 'Nội dung yêu cầu vượt quá giới hạn.');
    return text.trim();
  }

  /** The request a finished manual item starts: the item, its criteria, and its result. */
  private itemRequest(id: string): string {
    const item = this.ports.workItems.get(id);
    if (item === undefined) throw new CompanyError('work_item_not_found', MESSAGE.itemNotFound);
    if (item.status !== 'review' || item.squadRunId !== undefined)
      throw new CompanyError('work_item_status', MESSAGE.itemNotReviewable);
    return this.typedRequest(requestFromItem(item));
  }

  /**
   * Approves a proposal with the rows the user kept: creates one work item per row. Idempotent by
   * proposal: the work item service answers a repeated create with the same items.
   */
  async approve(
    command: SquadCommand & { runId: string; proposalId: string; rows: unknown },
  ): Promise<void> {
    if (this.answers.has(command.requestId)) return;
    const run = this.requireRun(command.runId);
    const proposal = this.requireProposal(run, command.proposalId);
    if (proposal.status === 'dismissed')
      throw new CompanyError('squad_status', MESSAGE.proposalDismissed);
    // An approved proposal answers a resend before its rows are read: a wait may be done by now.
    if (proposal.status === 'approved') {
      this.remember(command.requestId, run.id);
      this.scheduleTurnIfReviewed(run);
      return;
    }
    const checked = parseSquadRows(
      command.rows,
      (sequence) => this.ports.workItems.findOpen(sequence)?.id,
    );
    if (!checked.ok) throw new CompanyError('squad_rows_invalid', checked.message);
    const inFlight = this.approvals.get(proposal.id);
    if (inFlight !== undefined) {
      await inFlight;
      return;
    }
    const work = this.performApprove(run, proposal.id, checked.value, command.requestId);
    this.approvals.set(proposal.id, work);
    try {
      await work;
    } finally {
      this.approvals.delete(proposal.id);
    }
    this.scheduleTurnIfReviewed(run);
  }

  /** Drops a proposal the user does not want. The run stays only if it has approved work. */
  async dismiss(command: SquadCommand & { runId: string; proposalId: string }): Promise<void> {
    if (this.answers.has(command.requestId)) return;
    const run = this.requireRun(command.runId);
    const proposal = this.requireProposal(run, command.proposalId);
    if (proposal.status === 'dismissed') {
      this.remember(command.requestId, run.id);
      return;
    }
    if (proposal.status === 'approved')
      throw new CompanyError('squad_status', MESSAGE.proposalApproved);
    const at = this.iso();
    proposal.status = 'dismissed';
    const hasApproved = run.proposals.some((entry) => entry.status === 'approved');
    run.status = hasApproved ? 'working' : 'dismissed';
    delete run.note;
    appendEvent(run, squadEvent(at, 'dismissed'));
    this.remember(command.requestId, run.id);
    this.commit();
    await this.flush();
    this.scheduleTurnIfReviewed(run);
  }

  /** Asks the leader again after a failed turn. Only for runs that failed. */
  async retry(command: SquadCommand & { runId: string }): Promise<void> {
    if (this.answers.has(command.requestId)) return;
    const run = this.requireRun(command.runId);
    if (run.status !== 'failed') throw new CompanyError('squad_status', MESSAGE.notRetryable);
    const previousError = run.error;
    const at = this.iso();
    run.status = 'planning';
    delete run.error;
    appendEvent(run, squadEvent(at, 'request', MESSAGE.retried));
    this.remember(command.requestId, run.id);
    this.commit();
    try {
      await this.flush();
    } catch (error) {
      run.status = 'failed';
      run.error = previousError;
      run.history.pop();
      this.answers.delete(command.requestId);
      this.commit();
      await this.settleRollback();
      throw error;
    }
    this.scheduleTurn(run.id);
  }

  /** Stops the leader processes and the listeners. Turns that were in flight are not saved. */
  dispose(): void {
    this.disposed = true;
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
    for (const unsubscribe of this.unsubscribes) unsubscribe();
    this.unsubscribes.length = 0;
  }

  private async performApprove(
    run: StoredSquadRun,
    proposalId: string,
    approval: SquadApproval,
    requestId: string,
  ): Promise<void> {
    // Idempotent by proposal: a retry after a failed save gets the same items back.
    await this.ports.workItems.createWorkItems(approval.drafts, { squadRunId: proposalId });
    const proposal = run.proposals.find((entry) => entry.id === proposalId);
    if (proposal === undefined)
      throw new CompanyError('squad_proposal_not_found', MESSAGE.proposalNotFound);
    const at = this.iso();
    proposal.status = 'approved';
    proposal.rows = approval.rows;
    run.status = 'working';
    delete run.error;
    appendEvent(run, squadEvent(at, 'approved', `Đã giao ${approval.drafts.length} việc.`));
    this.remember(requestId, run.id);
    this.commit();
    await this.flush();
  }

  /** Queues a leader turn for a run. Turns of one run run in order; a turn that finds nothing to do returns. */
  private scheduleTurn(runId: string): void {
    const previous = this.turnQueue.get(runId) ?? Promise.resolve();
    const next = previous.then(() => this.runTurn(runId));
    this.turnQueue.set(runId, next);
    void next.then(() => {
      if (this.turnQueue.get(runId) === next) this.turnQueue.delete(runId);
    });
  }

  private scheduleTurnIfReviewed(run: StoredSquadRun): void {
    if (run.status === 'working' && run.pendingReviews.length > 0) this.scheduleTurn(run.id);
  }

  /** One leader turn. Never rejects: every failure is recorded on the run. */
  private async runTurn(runId: string): Promise<void> {
    const run = this.runs.get(runId);
    if (run === undefined || this.disposed) return;
    const eligible =
      run.status === 'planning' || (run.status === 'working' && run.pendingReviews.length > 0);
    if (!eligible) return;
    if (run.turns >= SQUAD_MAX_TURNS) {
      this.stopRun(run);
      return;
    }
    const controller = new AbortController();
    this.controllers.add(controller);
    try {
      const reviews = run.pendingReviews.slice();
      const members = this.ports.members();
      const items = this.itemViews(run);
      const openSequences = new Set(
        items.filter((item) => isOpenItemStatus(item.status)).map((item) => item.sequence),
      );
      const output = await this.ports.leader.run(
        buildLeaderPrompt({
          folderName: this.folderName,
          request: run.request,
          members,
          items,
          reviews,
          history: run.history,
          turn: run.turns + 1,
        }),
        controller.signal,
      );
      const checked = parseLeaderReply(output, members, openSequences);
      if (!checked.ok) throw new SquadLeaderError(checked.message);
      if (this.disposed) return;
      this.applyReply(run, checked.value, reviews);
    } catch (error) {
      if (this.disposed) return;
      this.failRun(run, leaderFailureMessage(error));
    } finally {
      this.controllers.delete(controller);
    }
  }

  private applyReply(
    run: StoredSquadRun,
    reply: LeaderReply,
    reviews: readonly SquadReview[],
  ): void {
    const at = this.iso();
    const read = new Set(reviews.map(reviewKey));
    run.pendingReviews = run.pendingReviews.filter((review) => !read.has(reviewKey(review)));
    run.turns += 1;
    run.note = reply.note;
    delete run.error;
    appendEvent(
      run,
      squadEvent(at, 'turn', `Lượt ${run.turns}: ${reply.note === '' ? 'đã trả lời' : reply.note}`),
    );
    if (reply.done) {
      run.status = 'done';
      run.pendingReviews = [];
      appendEvent(
        run,
        squadEvent(at, 'done', reply.note === '' ? MESSAGE.doneDefault : reply.note),
      );
    } else {
      run.proposals.push({
        id: this.ports.newId(),
        turn: run.turns,
        note: reply.note,
        rows: rowsOf(reply.assignments),
        status: 'pending',
        createdAt: at,
      });
      run.status = 'proposed';
      appendEvent(run, squadEvent(at, 'proposal', `Đề xuất ${reply.assignments.length} việc.`));
    }
    this.commit();
  }

  private failRun(run: StoredSquadRun, message: string): void {
    this.setFailed(run, message, this.iso());
    this.commit();
  }

  private setFailed(run: StoredSquadRun, message: string, at: string): void {
    run.status = 'failed';
    run.error = message;
    appendEvent(run, squadEvent(at, 'failed', message));
  }

  private stopRun(run: StoredSquadRun): void {
    const at = this.iso();
    run.status = 'stopped';
    run.note = MESSAGE.turnCap;
    run.pendingReviews = [];
    delete run.error;
    appendEvent(run, squadEvent(at, 'stopped', MESSAGE.turnCap));
    this.commit();
  }

  /** A finished item of an approved run: remember it for the next leader turn, and run that turn. */
  private onItemReview(item: WorkItem): void {
    if (this.disposed || item.squadRunId === undefined) return;
    const run = this.runForApprovedProposal(item.squadRunId);
    if (run === undefined) return;
    if (run.status === 'done' || run.status === 'stopped' || run.status === 'dismissed') return;
    const review: SquadReview = {
      itemId: item.id,
      at: item.updatedAt,
      text: clip(item.text, SQUAD_CONTEXT_TEXT_MAX_CHARS),
      ...(item.acceptance === undefined ? {} : { acceptance: item.acceptance }),
      ...(item.result === undefined
        ? {}
        : { result: clip(item.result, SQUAD_CONTEXT_RESULT_MAX_CHARS) }),
    };
    if (run.pendingReviews.some((entry) => reviewKey(entry) === reviewKey(review))) return;
    run.pendingReviews.push(review);
    this.commit();
    this.scheduleTurnIfReviewed(run);
  }

  /** Progress lives in the work items, so the squad message follows every item change of an approved run. */
  private onItemsChanged(): void {
    if (this.disposed) return;
    const hasApproved = [...this.runs.values()].some((run) =>
      run.proposals.some((proposal) => proposal.status === 'approved'),
    );
    if (hasApproved) this.commit();
  }

  private runForApprovedProposal(proposalId: string): StoredSquadRun | undefined {
    return [...this.runs.values()].find((run) =>
      run.proposals.some(
        (proposal) => proposal.id === proposalId && proposal.status === 'approved',
      ),
    );
  }

  /** The work items of a run's approved proposals, the newest kept, for the leader to read. */
  private itemViews(run: StoredSquadRun): LeaderItemView[] {
    const approved = new Set(
      run.proposals
        .filter((proposal) => proposal.status === 'approved')
        .map((proposal) => proposal.id),
    );
    const all = this.ports.workItems.snapshot().items;
    const sequenceById = new Map(all.map((item): [string, number] => [item.id, item.sequence]));
    return all
      .filter((item) => item.squadRunId !== undefined && approved.has(item.squadRunId))
      .slice(-SQUAD_CONTEXT_ITEMS_MAX)
      .map((item) => ({
        sequence: item.sequence,
        text: item.text,
        status: item.status,
        assignee: assigneeRef(item.assignee),
        priority: item.priority,
        ...(item.acceptance === undefined ? {} : { acceptance: item.acceptance }),
        dependsOn: item.dependsOn
          .map((id) => sequenceById.get(id))
          .filter((sequence): sequence is number => sequence !== undefined),
        ...(item.result === undefined
          ? {}
          : { result: clip(item.result, SQUAD_CONTEXT_RESULT_MAX_CHARS) }),
      }));
  }

  private remember(requestId: string, runId: string): void {
    if (this.answers.size >= REQUEST_MEMORY_MAX) {
      const oldest = this.answers.keys().next().value;
      if (oldest !== undefined) this.answers.delete(oldest);
    }
    this.answers.set(requestId, runId);
  }

  private requireRun(id: string): StoredSquadRun {
    const run = this.runs.get(id);
    if (run === undefined) throw new CompanyError('squad_run_not_found', MESSAGE.notFound);
    return run;
  }

  private requireProposal(run: StoredSquadRun, id: string): SquadProposal {
    const proposal = run.proposals.find((entry) => entry.id === id);
    if (proposal === undefined)
      throw new CompanyError('squad_proposal_not_found', MESSAGE.proposalNotFound);
    return proposal;
  }

  private iso(): string {
    return new Date(this.ports.now()).toISOString();
  }

  /** Persists and publishes the current state. Writes run in order, one at a time. */
  private commit(): void {
    this.revision += 1;
    this.prune();
    const file = structuredClone(this.toFile());
    this.ports.publish(this.snapshot());
    this.writeChain = this.writeChain
      .then(() => this.ports.persistence.save(file))
      .catch((error: unknown) => {
        this.saveError = error;
      });
  }

  /** Waits for pending writes and reports the last failed one, so a command can say so. */
  private async flush(): Promise<void> {
    await this.writeChain;
    const error = this.saveError;
    this.saveError = null;
    if (error !== null) {
      throw new CompanyError('company_command_failed', MESSAGE.saveFailed, { cause: error });
    }
  }

  /**
   * After a rollback, memory matches the last state that reached the disk, so a save that failed
   * while rolling back must not refuse the next command. Waits for pending writes, then forgets the error.
   */
  private async settleRollback(): Promise<void> {
    await this.writeChain;
    this.saveError = null;
  }

  private toFile(): SquadFile {
    return { version: 1, revision: this.revision, runs: [...this.runs.values()] };
  }

  /** Keeps at most {@link SQUAD_RUNS_KEEP} runs, dropping the least recently changed finished ones first. */
  private prune(): void {
    let excess = this.runs.size - SQUAD_RUNS_KEEP;
    if (excess <= 0) return;
    const finished = [...this.runs.values()]
      .filter((run) => FINISHED_STATUSES.includes(run.status))
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
    for (const run of finished) {
      if (excess <= 0) break;
      this.runs.delete(run.id);
      excess -= 1;
    }
  }
}

/** The text a user reads for a failed turn. Leader errors are already Vietnamese; others are shown in brief. */
function leaderFailureMessage(error: unknown): string {
  if (error instanceof SquadLeaderError) return error.message;
  const detail = error instanceof Error ? clip(error.message, 200) : MESSAGE.unknownError;
  return `Đội trưởng gặp lỗi: ${detail}. Thử lại.`;
}

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
  CompanySquadLiveMessage,
  CompanySquadMessage,
  CompanyWorkItemsMessage,
  SquadProposal,
  WorkItem,
} from '../../../../core/src/messages.js';
import { CompanyError } from '../companyError.js';
import { describeConflicts } from '../workItems/conflictModel.js';
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
  type SquadCatalog,
  squadEvent,
  type SquadFile,
  type SquadMember,
  squadProgress,
  type SquadReview,
  type SquadReviewOutcome,
  type StoredSquadRun,
  toWireRun,
  warningsOf,
} from './squadModel.js';
import { type LeaderRunner, SquadLeaderError } from './squadRunner.js';

/** Answers to recent commands kept, so a resent command is answered without repeating its work. */
const REQUEST_MEMORY_MAX = 256;
/** Settled work items remembered, so one settle starts one leader turn; the oldest fall off. */
const SETTLE_MEMORY_MAX = 512;

/** Run statuses that count as finished: they can be pruned and hold no turn. */
const FINISHED_STATUSES: readonly string[] = ['done', 'dismissed', 'stopped'];
/** Finished runs that may be removed; failures are finished for removal but not for pruning. */
const REMOVABLE_STATUSES: readonly string[] = [...FINISHED_STATUSES, 'failed'];

/** The work item calls a squad makes. The work item service satisfies this. */
export interface SquadWorkItems {
  snapshot(): CompanyWorkItemsMessage;
  createWorkItems(
    drafts: readonly WorkItemDraft[],
    options: { squadRunId: string },
  ): Promise<string[]>;
  onChange(listener: () => void): () => void;
  onItemSettled(listener: (item: WorkItem) => void): () => void;
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
  publish(message: CompanySquadMessage | CompanySquadLiveMessage): void;
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

/** A proposal the board approves, with the rows the user kept. */
type ApproveCommand = SquadCommand & {
  readonly runId: string;
  readonly proposalId: string;
  readonly rows: unknown;
};

type RunCommand = SquadCommand & { readonly runId: string };
type ReplyCommand = RunCommand & { readonly text: string };

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
  compactPlanned: 'Đã chia việc. Mỗi phiên tự làm việc của mình tới hết; đội trưởng không được hỏi lại.',
  unknownError: 'lỗi không rõ',
  requestShape:
    'Yêu cầu đội cần đúng một trong hai: nội dung, hoặc việc đã xong để hỏi đội trưởng bước tiếp.',
  itemNotFound: 'Không tìm thấy việc đó.',
  itemNotReviewable:
    'Chỉ hỏi đội trưởng bước tiếp từ việc đã xong (đang chờ duyệt) và không thuộc đội nào.',
  cancelNotActive: 'Chỉ huỷ được lượt chưa kết thúc.',
  cancelled: 'Đã huỷ lượt. Các việc đã tạo từ đề xuất được duyệt vẫn tiếp tục.',
  replyNotAllowed: 'Chỉ trả lời được đội gọn đang chờ bạn.',
  closeNotAllowed: 'Chỉ đóng được bản tổng kết của đội gọn đã xong.',
  removeNotFinished: 'Hãy huỷ lượt này trước khi xoá.',
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
  /** Work items whose settle already started a turn, by settle key, so one settle counts once. */
  private readonly settles = new Set<string>();
  /** The last leader turn queued per run. Turns of one run run one after another. */
  private readonly turnQueue = new Map<string, Promise<void>>();
  /** Leader processes in flight, by run, so one run can be cancelled without stopping another. */
  private readonly controllers = new Map<string, AbortController>();
  private readonly unsubscribes: (() => void)[] = [];
  private disposed = false;

  constructor(options: SquadServiceOptions, ports: SquadPorts) {
    this.workspacePath = options.workspacePath;
    this.folderName = options.folderName;
    this.ports = ports;
    this.unsubscribes.push(
      ports.workItems.onChange(() => this.onItemsChanged()),
      ports.workItems.onItemSettled((item) => this.onItemSettled(item)),
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
   * on. An item that already has an open run answers with that run and starts nothing new. The
   * first leader turn starts once the run is saved.
   */
  async request(command: SquadRequestCommand): Promise<string> {
    const replayed = this.answers.get(command.requestId);
    if (replayed !== undefined) return replayed;
    const open = this.openRunFor(command);
    if (open !== undefined) {
      this.remember(command.requestId, open.id);
      return open.id;
    }
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
      compact: this.ports.workItems.snapshot().settings.compactSquad,
      ...(command.fromWorkItemId === undefined ? {} : { fromWorkItemId: command.fromWorkItemId }),
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

  /**
   * The open run that already started from this finished item, if there is one. Done, dismissed
   * and stopped runs are closed, so a new request may start again. Typed requests never match.
   */
  private openRunFor(command: SquadRequestCommand): StoredSquadRun | undefined {
    if (command.fromWorkItemId === undefined || command.text !== undefined) return undefined;
    return [...this.runs.values()].find(
      (run) =>
        run.fromWorkItemId === command.fromWorkItemId && !FINISHED_STATUSES.includes(run.status),
    );
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
  async approve(command: ApproveCommand): Promise<void> {
    await this.approveProposal(command, false);
  }

  /**
   * The approval the board and the automatic next-step approval share. A resent command is answered
   * from memory; a proposal already in flight is awaited rather than approved twice.
   */
  private async approveProposal(command: ApproveCommand, automatic: boolean): Promise<void> {
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
      this.catalog(),
      (sequence) => this.ports.workItems.findOpen(sequence)?.id,
    );
    if (!checked.ok) throw new CompanyError('squad_rows_invalid', checked.message);
    const inFlight = this.approvals.get(proposal.id);
    if (inFlight !== undefined) {
      await inFlight;
      return;
    }
    const work = this.performApprove(run, proposal.id, checked.value, command.requestId, automatic);
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
  /** Cancels an unfinished run and its own in-flight leader turn. */
  async cancel(command: SquadCommand & { runId: string }): Promise<void> {
    if (this.answers.has(command.requestId)) return;
    const run = this.requireRun(command.runId);
    if (FINISHED_STATUSES.includes(run.status) || run.status === 'failed')
      throw new CompanyError('squad_status', MESSAGE.cancelNotActive);
    this.controllers.get(run.id)?.abort();
    for (const proposal of run.proposals) {
      if (proposal.status === 'pending') proposal.status = 'dismissed';
    }
    run.pendingReviews = [];
    run.status = 'stopped';
    delete run.error;
    delete run.note;
    const at = this.iso();
    appendEvent(run, squadEvent(at, 'stopped', MESSAGE.cancelled));
    this.remember(command.requestId, run.id);
    this.commit();
    await this.flush();
  }

  /**
   * Removes a finished run without changing any work item. A compact run that is done but still
   * waits for the user's reply counts as finished: removing it is the user dropping that reply.
   */
  async remove(command: SquadCommand & { runId: string }): Promise<void> {
    if (this.answers.has(command.requestId)) return;
    const run = this.requireRun(command.runId);
    if (!REMOVABLE_STATUSES.includes(run.status)) throw new CompanyError('squad_status', MESSAGE.removeNotFinished);
    this.runs.delete(run.id);
    this.remember(command.requestId, run.id);
    this.commit();
    await this.flush();
  }

  /** Answers a completed compact run and grants at most five additional leader turns. */
  async reply(command: ReplyCommand): Promise<void> {
    if (this.answers.has(command.requestId)) return;
    const run = this.requireRun(command.runId);
    const text = command.text.trim();
    if (!run.compact || run.status !== 'done' || text === '' || text.length > 4000) {
      throw new CompanyError('squad_status', MESSAGE.replyNotAllowed);
    }
    run.closed = false;
    run.status = 'planning';
    delete run.note;
    delete run.error;
    run.extraTurns = Math.min(5, (run.extraTurns ?? 0) + 1);
    appendEvent(run, squadEvent(this.iso(), 'turn', `Trả lời của bạn: ${text}`, 4000));
    this.remember(command.requestId, run.id);
    this.commit();
    await this.flush();
    this.scheduleTurn(run.id);
  }

  /** Closes a completed compact run after the user has read its summary. */
  async close(command: RunCommand): Promise<void> {
    if (this.answers.has(command.requestId)) return;
    const run = this.requireRun(command.runId);
    if (!run.compact || run.status !== 'done') {
      throw new CompanyError('squad_status', MESSAGE.closeNotAllowed);
    }
    run.closed = true;
    appendEvent(run, squadEvent(this.iso(), 'turn', 'Người dùng đã đóng bản tổng kết.'));
    this.remember(command.requestId, run.id);
    this.commit();
    await this.flush();
  }

  /** Whether a proposal belongs to a compact run. */
  isCompactProposal(proposalId: string): boolean {
    return [...this.runs.values()].some(
      (run) => run.compact === true && run.proposals.some((proposal) => proposal.id === proposalId),
    );
  }


  /** Stops the leader processes and the listeners. Turns that were in flight are not saved. */
  dispose(): void {
    this.disposed = true;
    for (const controller of this.controllers.values()) controller.abort();
    this.controllers.clear();
    for (const unsubscribe of this.unsubscribes) unsubscribe();
    this.unsubscribes.length = 0;
  }

  private async performApprove(
    run: StoredSquadRun,
    proposalId: string,
    approval: SquadApproval,
    requestId: string,
    automatic: boolean,
  ): Promise<void> {
    // Idempotent by proposal: a retry after a failed save gets the same items back.
    await this.ports.workItems.createWorkItems(approval.drafts, { squadRunId: proposalId });
    const proposal = run.proposals.find((entry) => entry.id === proposalId);
    if (proposal === undefined)
      throw new CompanyError('squad_proposal_not_found', MESSAGE.proposalNotFound);
    const at = this.iso();
    proposal.status = 'approved';
    proposal.rows = approval.rows;
    proposal.warnings = warningsOf(approval.rows, this.catalog());
    delete run.error;
    const count = approval.drafts.length;
    const message = automatic ? `Tự duyệt: đã giao ${count} việc.` : `Đã giao ${count} việc.`;
    appendEvent(run, squadEvent(at, 'approved', message));
    // A compact squad plans once: each item runs to its end on its own session, and no settle asks
    // the leader again. A regular run keeps reviewing its items' results turn by turn.
    if (run.compact === true) {
      run.status = 'done';
      run.pendingReviews = [];
      appendEvent(run, squadEvent(at, 'done', MESSAGE.compactPlanned));
    } else {
      run.status = 'working';
    }
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
    if (run.turns >= SQUAD_MAX_TURNS + (run.extraTurns ?? 0)) {
      this.stopRun(run);
      return;
    }
    const controller = new AbortController();
    this.controllers.set(run.id, controller);
    // The turn's progress goes out as it streams; it is not stored, and a final message clears it.
    const startedAt = this.iso();
    const sendLive = (live?: CompanySquadLiveMessage['live']): void => {
      if (this.disposed) return;
      this.ports.publish({ type: 'companySquadLive', workspacePath: this.workspacePath, runId: run.id, ...(live === undefined ? {} : { live }) });
    };
    sendLive({ phase: 'thinking', chars: 0, startedAt });
    try {
      const reviews = run.pendingReviews.slice();
      const snapshot = this.ports.workItems.snapshot();
      const catalog: SquadCatalog = { repos: snapshot.repos, agents: snapshot.agents };
      const members = this.ports.members();
      const items = this.itemViews(run, snapshot.items);
      const openSequences = new Set(
        items.filter((item) => isOpenItemStatus(item.status)).map((item) => item.sequence),
      );
      const output = await this.ports.leader.run(
        buildLeaderPrompt({
          folderName: this.folderName,
          request: run.request,
          repos: catalog.repos,
          agents: catalog.agents,
          autoJudge: snapshot.settings.autoJudge,
          members,
          items,
          reviews,
          history: run.history,
          turn: run.turns + 1,
          maxTurns: SQUAD_MAX_TURNS + (run.extraTurns ?? 0),
          compact: run.compact === true,
        }),
        controller.signal,
        (live) => sendLive({ ...live, startedAt }),
      );
      const checked = parseLeaderReply(output, members, catalog, openSequences, run.compact === true);
      if (!checked.ok) throw new SquadLeaderError(checked.message);
      if (this.disposed || this.runs.get(runId) !== run || FINISHED_STATUSES.includes(run.status))
        return;
      this.applyReply(run, checked.value, reviews);
    } catch (error) {
      if (
        this.disposed ||
        this.runs.get(runId) !== run ||
        FINISHED_STATUSES.includes(run.status)
      )
        return;
      this.failRun(run, leaderFailureMessage(error));
    } finally {
      sendLive();
      if (this.controllers.get(runId) === controller) this.controllers.delete(runId);
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
    let proposed: SquadProposal | undefined;
    if (reply.done) {
      run.status = 'done';
      run.pendingReviews = [];
      appendEvent(
        run,
        squadEvent(at, 'done', reply.note === '' ? MESSAGE.doneDefault : reply.note),
      );
    } else if (reply.assignments.length === 0) {
      // A wait: the leader's items are still running, and it is asked again when one settles.
      run.status = 'working';
    } else {
      const rows = rowsOf(reply.assignments);
      proposed = {
        id: this.ports.newId(),
        turn: run.turns,
        note: reply.note,
        rows,
        warnings: warningsOf(rows, this.catalog()),
        status: 'pending',
        createdAt: at,
      };
      run.proposals.push(proposed);
      run.status = 'proposed';
      appendEvent(run, squadEvent(at, 'proposal', `Đề xuất ${reply.assignments.length} việc.`));
    }
    this.commit();
    if (proposed !== undefined && this.autoApproves(run, proposed)) {
      this.approveAutomatically(run, proposed);
    }
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

  /**
   * Starts the next leader turn for a settled work item of an approved run. The work item port
   * calls this for every settle, and the judge calls it again after it decides, so a settle seen
   * twice counts once. Which settles the leader reads depends on automatic judging: see
   * {@link settleOutcome}.
   */
  onItemSettled(item: WorkItem): void {
    if (this.disposed || item.squadRunId === undefined) return;
    const run = this.runForApprovedProposal(item.squadRunId);
    if (run === undefined || FINISHED_STATUSES.includes(run.status)) return;
    const conflicts = itemConflicts(item);
    const key = `${item.id}|${item.status}|${item.updatedAt}|${conflicts ?? ''}`;
    if (this.settles.has(key)) return;
    if (this.settles.size >= SETTLE_MEMORY_MAX) {
      const oldest = this.settles.values().next().value;
      if (oldest !== undefined) this.settles.delete(oldest);
    }
    this.settles.add(key);
    const snapshot = this.ports.workItems.snapshot();
    const finished = planFinished(run, snapshot.items);
    const outcome = settleOutcome(
      item,
      snapshot.settings.autoJudge,
      finished,
      conflicts !== undefined,
      run.compact === true,
    );
    if (outcome === undefined) return;
    const result = item.result ?? (item.status === 'failed' ? item.reason : undefined);
    const review: SquadReview = {
      itemId: item.id,
      at: item.updatedAt,
      outcome,
      text: clip(item.text, SQUAD_CONTEXT_TEXT_MAX_CHARS),
      ...(item.acceptance === undefined ? {} : { acceptance: item.acceptance }),
      ...(result === undefined ? {} : { result: clip(result, SQUAD_CONTEXT_RESULT_MAX_CHARS) }),
      ...(conflicts === undefined ? {} : { conflicts }),
    };
    if (run.pendingReviews.some((entry) => reviewKey(entry) === reviewKey(review))) return;
    run.pendingReviews.push(review);
    this.commit();
    this.scheduleTurnIfReviewed(run);
  }

  /**
   * Whether a new proposal is one the board approves on its own: automatic approval is on and the
   * proposal carries no completeness warning. The first proposal of a run counts too, so a squad with
   * automatic approval plans and dispatches without waiting on the user.
   */
  /** Compact runs auto-approve every proposal; regular runs keep their existing warning gate. */
  private autoApproves(run: StoredSquadRun, proposal: SquadProposal): boolean {
    return (
      run.compact === true ||
      (this.ports.workItems.snapshot().settings.autoApproveNext && proposal.warnings.length === 0)
    );
  }

  /** Approves a clean next step as the board's approval would; a failure is recorded and the proposal stays pending. */
  private approveAutomatically(run: StoredSquadRun, proposal: SquadProposal): void {
    const command: ApproveCommand = {
      requestId: `auto:${proposal.id}`,
      runId: run.id,
      proposalId: proposal.id,
      rows: proposal.rows,
    };
    void this.approveProposal(command, true).catch((error: unknown) => {
      const current = this.runs.get(run.id);
      if (this.disposed || current === undefined) return;
      const detail = error instanceof Error ? clip(error.message, 200) : MESSAGE.unknownError;
      const failure = `Không tự duyệt được đề xuất: ${detail}.`;
      if (
        current.compact === true &&
        !current.history.some((event) => event.message?.startsWith('Không tự duyệt được đề xuất:'))
      ) {
        current.status = 'planning';
        appendEvent(
          current,
          squadEvent(this.iso(), 'turn', `${failure} Đội trưởng được thêm một lượt để tự sửa.`),
        );
        this.commit();
        this.scheduleTurn(current.id);
        return;
      }
      this.setFailed(current, `${failure} Run thất bại sau lượt sửa tự động.`, this.iso());
      this.commit();
    });
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
  private itemViews(run: StoredSquadRun, all: readonly WorkItem[]): LeaderItemView[] {
    const approved = new Set(
      run.proposals
        .filter((proposal) => proposal.status === 'approved')
        .map((proposal) => proposal.id),
    );
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

  /** The folder's repos and omp agents, as the work item service reads them now. */
  private catalog(): SquadCatalog {
    const snapshot = this.ports.workItems.snapshot();
    return { repos: snapshot.repos, agents: snapshot.agents };
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

/**
 * What a settled item tells the leader, or undefined when the leader need not read it now. A
 * review is read when automatic judging is off or when it overlaps another checkout, since the
 * leader then plans the merge; the judge decides the rest. A failure is always read; a done item
 * is read when judging is automatic or it finished the plan.
 */
function settleOutcome(
  item: WorkItem,
  autoJudge: boolean,
  finished: boolean,
  conflicted: boolean,
  compact: boolean,
): SquadReviewOutcome | undefined {
  if (compact) {
    if (item.status === 'review') return 'done';
    if (item.status === 'failed') return 'failed';
    if (item.status === 'done') return 'done';
    return undefined;
  }
  if (item.status === 'review') return autoJudge && !conflicted ? undefined : 'review';
  if (item.status === 'failed') return 'failed';
  if (item.status === 'done') return autoJudge || finished ? 'done' : undefined;
  return undefined;
}

/** The overlaps the board names for an item, such as "#3, checkout chính"; undefined when none. */
function itemConflicts(item: WorkItem): string | undefined {
  if (item.conflicts === undefined) return undefined;
  const names = describeConflicts(item.conflicts);
  return names.length === 0 ? undefined : names.join(', ');
}

/** Whether every work item of the run's approved proposals has finished, so the plan is complete. */
function planFinished(run: StoredSquadRun, items: readonly WorkItem[]): boolean {
  const approved = new Set(
    run.proposals
      .filter((proposal) => proposal.status === 'approved')
      .map((proposal) => proposal.id),
  );
  const planItems = items.filter(
    (item) => item.squadRunId !== undefined && approved.has(item.squadRunId),
  );
  return planItems.length > 0 && planItems.every((item) => !isOpenItemStatus(item.status));
}

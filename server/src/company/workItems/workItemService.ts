/**
 * WorkItemService: one folder's work items.
 *
 * A work item is a piece of work the user hands to one agent: a herdr pane, an omp session on the
 * board, a new omp chat opened for it, or whichever free agent the squad scheduler picks (`auto`).
 * The service stores items per folder, decides when each may start (see `workItemScheduler.ts`),
 * sends it to its agent, queues it behind the agent's current work otherwise, and moves its status
 * as herdr and the session report back. Every change is published as a full `companyWorkItems`
 * message and saved to disk.
 *
 * An item may wait for other items: it is sent only once every one of them is done, and its
 * priority decides its place in its agent's queue. An editing item also takes its code areas and
 * its checkout while it runs, so two editing items never work on the same place at once.
 *
 * The status rules live in `workItemModel.ts`. This module applies them and performs the side
 * effects through the injected ports, so tests run with fakes and no clock or socket.
 *
 * Phase 2 (squad leader) creates items through {@link WorkItemService.createWorkItems}.
 */

import type {
  AgentRole,
  CompanyRole,
  CompanyWorkItemsMessage,
  HerdrAgent,
  LedgerOverlapScan,
  OmpAgentInfo,
  SquadSettings,
  WorkItem,
  WorkItemAssignee,
  WorkItemBlocker,
  WorkItemVerdict,
} from '../../../../core/src/messages.js';
import { withoutTerminalEscapes } from '../../../../core/src/terminalText.js';
import {
  blockerOf,
  blockerReason,
  checkDependsOn,
  compareQueue,
  dependenciesDone,
  type DependencyState,
  type DependsOnRefusal,
  isWorkItemPriority,
  WORK_ITEM_ACCEPTANCE_MAX_CHARS,
  WORK_ITEM_PRIORITY_DEFAULT,
} from '../../../../core/src/workItemGraph.js';
import { isArchivedWorkItem } from '../../library/storageHelpers.js';
import type { AgyRuns, AgyRunView } from '../agyCode/agyRuns.js';
import type { ClaudeAuthProbe } from '../claudeCode/claudeAuth.js';
import type { ClaudeMcpSource } from '../claudeCode/claudeMcpSource.js';
import type { ClaudeRuns, ClaudeRunView } from '../claudeCode/claudeRuns.js';
import { CompanyError } from '../companyError.js';
import { BUNDLED_AGENTS, findAgent } from './agentCatalog.js';
import {
  type ConflictReport,
  conflictsFor,
  describeConflicts,
} from './conflictModel.js';
import { composeDispatchPrompt, DEFAULT_AGENT, type PromptEngine } from './dispatchPrompt.js';
import {
  buildJudgePrompt,
  decideJudgeAction,
  JUDGE_NOT_MET_PREFIX,
  JUDGE_RESULT_MAX_CHARS,
  type JudgeInput,
  type JudgeReply,
  parseJudgeReply,
  passedMessage,
} from './judgeModel.js';
import { GIB, isSquadSettings, SQUAD_SETTINGS_DEFAULT } from './squadSettings.js';
import type { SquadWorktree, WorktreeRemoval } from './squadWorktree.js';
import {
  type AgentObservation,
  assigneeKey,
  canCancel,
  canFollowUp,
  canMark,
  canReassign,
  clip,
  isFinished,
  isItemRole,
  isUuid,
  isWorkItemAssignee,
  JUDGE_ERROR_MAX_CHARS,
  makeEvent,
  normalizeAreas,
  normalizeAssignee,
  observeAssigneeSession,
  observeHerdrStatus,
  observeSessionStatus,
  occupiesAgent,
  type ParsedWorkItems,
  refuseText,
  ROLE_DESCRIPTION_MAX_CHARS,
  SQUAD_SESSIONS_KEPT,
  type StoredWorkItem,
  toWorkItem,
  WORK_ITEM_AREA_MAX_CHARS,
  WORK_ITEM_AREAS_MAX,
  WORK_ITEM_BLOCKER_DETAIL_MAX_CHARS,
  WORK_ITEM_FINISHED_KEEP,
  WORK_ITEM_GRACE_MS,
  WORK_ITEM_HISTORY_MAX,
  WORK_ITEM_HOLD_RETRY_MS,
  WORK_ITEM_REASON,
  WORK_ITEM_REASON_MAX_CHARS,
  WORK_ITEM_RESULT_LINES,
  WORK_ITEM_RESULT_MAX_CHARS,
  type WorkItemDraft,
  type WorkItemsFile,
} from './workItemModel.js';
import {
  checkoutKey,
  checkoutName,
  decideStart,
  type SchedulerContext,
  type SchedulerDecision,
  type SchedulerHold,
  type SchedulerItem,
  type SchedulerMember,
  squadWorkstreamKey,
} from './workItemScheduler.js';

/** How many recent request ids are remembered, so a resent command answers the same way. */
const REQUEST_MEMORY_MAX = 256;

/** How long a squad session may sit idle before the squad parks it to free its memory. */
const SQUAD_PARK_IDLE_MS = 15 * 60_000;
/** How often conflicts are re-checked while editing work is open and a client is connected. */
const CONFLICT_RECHECK_MS = 2 * 60_000;
/** The maintenance tick: parks idle squad sessions and re-checks conflicts when they are due. */
const MAINTENANCE_MS = 60_000;

/** How often a Claude Code run's output is shown: output bursts inside this window share one pass. */
const CLAUDE_PROGRESS_MS = 1000;

/** One herdr pane, as far as work items care. */
export interface WorkItemPaneView {
  readonly paneId: string;
  readonly status: HerdrAgent['status'];
  /** The checkout the pane runs in, when herdr reports one. */
  readonly cwd?: string;
}

/** What the roster answers about herdr panes at one moment. */
export interface WorkItemRosterView {
  readonly available: boolean;
  readonly panes: readonly WorkItemPaneView[];
}

/** herdr, as work items see it. `available` false means herdr cannot answer, so nothing is decided. */
export interface WorkItemRoster {
  panes(): WorkItemRosterView;
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
  /** The checkout the session runs in, when the session reports one. */
  readonly cwd?: string;
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
  /** Opens a new omp chat in `cwd` for `role`, under a squad workstream key, and returns its id. */
  openChat(input: {
    readonly cwd: string;
    readonly role: CompanyRole;
    readonly workstreamKey: string;
  }): Promise<string>;
  /** Brings a parked session back so a prompt can reach it. Rejects when the pool refuses. */
  wake(sessionId: string): Promise<void>;
  /** Parks an idle session to free its memory. False when the pool refuses now. */
  park(sessionId: string): Promise<boolean>;
}

/** What the board can pick from: the folder's repos and its omp agents. */
export interface WorkItemCatalog {
  readonly repos: readonly string[];
  readonly agents: readonly OmpAgentInfo[];
  /** The Claude Code subagent names a claude run may pass to `--agent`. */
  readonly claudeAgents: readonly string[];
}

/** Where the folder's file lives. */
export interface WorkItemPersistence {
  load(): Promise<ParsedWorkItems>;
  save(file: WorkItemsFile): Promise<void>;
}

/** Creates the isolated git worktree an editing item runs in. Rejects with the reason when it cannot. */
export interface WorkItemWorktrees {
  create(repo: string, shortId: string): Promise<SquadWorktree>;
  /** Removes a finished item's worktree. Refuses, never forces, when it is dirty or unmerged. */
  remove(repo: string, worktree: SquadWorktree): Promise<WorktreeRemoval>;
  /** Whether the worktree's directory is still on disk. */
  exists(worktree: SquadWorktree): boolean;
}

/** Everything the service reaches outside itself. */
export interface WorkItemPorts {
  readonly roster: WorkItemRoster;
  readonly sessions: WorkItemSessions;
  readonly persistence: WorkItemPersistence;
  readonly worktrees: WorkItemWorktrees;
  readonly prepareWorktree?: (input: { readonly folder: string; readonly repo: string; readonly worktree: string }) => Promise<void>;
  publish(message: CompanyWorkItemsMessage): void;
  now(): number;
  newId(): string;
  /** Runs `run` after `ms`. Returns a function that cancels it. */
  schedule(run: () => void, ms: number): () => void;
  /** The folder's repos and omp agents, read fresh. Rejects when the read itself fails. */
  catalog(): Promise<WorkItemCatalog>;
  /** Free memory in bytes, read whenever the scheduler may open a session. */
  freeMemoryBytes(): number;
  /** Runs one judge turn and resolves with its raw text. Rejects when the turn fails or aborts. */
  judge(prompt: string, signal: AbortSignal): Promise<string>;
  /** The ledger's overlap scans, read fresh. Rejects when the ledger cannot answer. */
  overlaps(): Promise<readonly LedgerOverlapScan[]>;
  /** Whether a board is looking at the ledger. The conflict check runs only while one is. */
  boardWatching(): boolean;
  /** Claude Code runs: one `claude -p` process per run, started in the item's checkout. */
  readonly claude: ClaudeRuns;
  /** Antigravity runs: one `agy` process per run (prompt on stdin), started in the item's checkout. */
  readonly agy: AgyRuns;
  /** Claude Code's auth status, read from `claude auth status` and cached. */
  readonly claudeAuth: ClaudeAuthProbe;
  /** The user's Claude MCP servers: the names the squad lists, and a worker run's config. */
  readonly claudeMcp: ClaudeMcpSource;
}

/** A command the board sent. The request id makes a resent command harmless. */
export interface WorkItemCommand {
  readonly requestId: string;
}

/** The item fields a create or an assign may name. Absent means none. */
type ItemFieldsInput = Pick<WorkItemDraft, 'repo' | 'role' | 'areas' | 'agent'>;

/** The item fields after checks: a repo from the folder's list, a role, normalized areas, a known agent. */
interface WorkItemFields {
  repo?: string;
  role?: CompanyRole;
  areas: string[];
  agent?: string;
}

/** A decision that starts an item: the item goes to a member, or to a session opened first. */
type StartDecision = Exclude<SchedulerDecision, { readonly kind: 'wait' }>;

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
  itemRoleInvalid: 'Vai không hợp lệ.',
  repoInvalid: 'Repo đó không nằm trong thư mục này.',
  areasInvalid: 'Vùng code tối đa 8 mục, mỗi mục tối đa 120 ký tự.',
  agentUnknown: 'Subagent omp đó không có trong danh sách.',
  settingsInvalid: 'Cài đặt đội không hợp lệ.',
  emptyText: 'Nội dung việc không được để trống.',
  promptTooLarge: 'Nội dung việc vượt quá giới hạn.',
  done: 'Việc đã xong.',
  priorityInvalid: 'Độ ưu tiên phải từ P0 đến P3.',
  acceptanceTooLong: 'Tiêu chí xong quá dài.',
  badRow: 'Việc chờ trong đề xuất không hợp lệ.',
  noWorktree: 'Việc này không có worktree đã xong để dọn.',
  worktreeInUse: 'Một phiên đang làm trong worktree này. Đậu hoặc đóng phiên đó trước.',
  worktreeDirty: 'Worktree còn thay đổi chưa commit nên chưa dọn.',
  worktreeUnmerged: 'Nhánh của worktree chưa merge vào origin/main nên chưa dọn.',
  worktreeRemoved: 'Đã dọn worktree.',
  worktreeMaking: 'Đang tạo worktree riêng cho việc này (fetch, checkout, script chuẩn bị); repo lớn có thể mất vài phút. Việc sẽ tự gửi khi xong.',
  worktreeKept:
    'Worktree của việc này còn trên đĩa, xoá việc sẽ mất đường dọn nó. Việc đã xong: bấm "Dọn worktree" trước; việc lỗi: gộp hoặc xoá worktree đó trước rồi mới xoá việc.',
} as const;

/** Vietnamese refusals for a wait list, by the reason the core check gives. */
const DEPENDS_MESSAGE: Record<DependsOnRefusal, string> = {
  too_many: 'Việc chỉ chờ tối đa 10 việc khác.',
  duplicate: 'Danh sách chờ có việc bị lặp.',
  self: 'Việc không thể chờ chính nó.',
  unknown: 'Có việc trong danh sách chờ không còn trên bảng.',
  cycle: 'Danh sách chờ này tạo thành vòng lặp giữa các việc.',
};

/** Why a queued item cannot be cancelled: the open items that still wait for it, by #n. */
function awaitedMessage(sequences: readonly number[]): string {
  const names = sequences.map((sequence) => `#${sequence}`).join(', ');
  return `Không huỷ được: ${names} đang chờ việc này. Hãy bỏ việc này khỏi danh sách chờ của các việc đó trước.`;
}

/** The folder's herdr and session views, read once for a pass or a snapshot. */
interface FolderView {
  readonly roster: WorkItemRosterView;
  readonly sessions: readonly WorkItemSessionView[];
}

/** Keeps a short text of an error for a reason line. */
function describe(error: unknown): string {
  return error instanceof Error ? clip(error.message, 200) : 'lỗi không rõ';
}

/** The last non-empty screen lines, as a result, without terminal colour codes. Undefined when the screen is empty. */
function summarizeScreen(text: string): string | undefined {
  const lines = withoutTerminalEscapes(text)
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

/** How the board names a scheduler member in a history line. */
function memberLabel(member: SchedulerMember): string {
  if (member.assignee.kind === 'herdr') return `pane herdr ${member.assignee.paneId ?? ''}`;
  return member.cwd === undefined ? 'phiên omp' : `phiên omp trong ${checkoutName(member.cwd)}`;
}

/** Sets the item's repo, role, areas and agent to exactly these fields; an absent one is cleared. */
function applyFields(item: StoredWorkItem, fields: WorkItemFields): void {
  if (fields.repo === undefined) delete item.repo;
  else item.repo = fields.repo;
  if (fields.role === undefined) delete item.role;
  else item.role = fields.role;
  item.areas = [...fields.areas];
  if (fields.agent === undefined) delete item.agent;
  else item.agent = fields.agent;
}

/** Work items for one folder, with their queue, status, and role notes. */
export class WorkItemService {
  private readonly workspacePath: string;
  private readonly ports: WorkItemPorts;
  private readonly items = new Map<string, StoredWorkItem>();
  private roles: AgentRole[] = [];
  private revision = 0;
  private nextSequence = 0;
  private settings: SquadSettings = { ...SQUAD_SETTINGS_DEFAULT };
  /** Sessions the squad opened, oldest first. Used for reuse and the open cap. */
  private squadSessionIds: string[] = [];
  /** The repo each squad-opened session was opened for, keyed by session id. */
  private squadSessionRepos = new Map<string, string>();
  private catalog: WorkItemCatalog = { repos: [], agents: BUNDLED_AGENTS, claudeAgents: [] };
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
  private readonly changeListeners = new Set<() => void>();
  private readonly settledListeners = new Set<(item: WorkItem) => void>();
  /** Items held back with the reason they cannot start yet: the omp pool is full or the worktree failed. */
  private readonly held = new Map<string, WorkItemBlocker>();
  private holdRetryPending = false;
  /** Judge turns in flight by item id: the run that may still apply, and the handle that aborts it. */
  private readonly judgeRuns = new Map<string, { runId: number; controller: AbortController }>();
  private judgeSeq = 0;
  /** Conflicts per item id, read from the ledger on each check. Kept in memory, not saved. */
  private readonly conflictReports = new Map<string, ConflictReport>();
  private conflictRefreshing = false;
  private lastConflictAt = Number.NEGATIVE_INFINITY;
  /** When each squad session was first seen idle by this process, by session id. */
  private readonly idleSince = new Map<string, number>();
  private maintenanceScheduled = false;
  /** Unsubscribes from CLI run changes. Set by load, cleared by dispose. */
  private unsubscribeClaude: (() => void) | null = null;
  private unsubscribeAgy: (() => void) | null = null;
  private readonly agyRunIds = new Map<string, string>();
  /** Whether a progress pass is already scheduled for CLI output. */
  private claudeNotifyPending = false;

  constructor(workspacePath: string, ports: WorkItemPorts) {
    this.workspacePath = workspacePath;
    this.ports = ports;
  }

  /** Reads the folder's file and catalog. Call once, before any command. */
  async load(): Promise<void> {
    const parsed = await this.ports.persistence.load();
    this.revision = parsed.file.revision;
    this.nextSequence = parsed.file.nextSequence;
    this.roles = parsed.file.roles;
    this.settings = { ...parsed.file.settings };
    this.squadSessionIds = [...parsed.file.squadSessionIds];
    this.squadSessionRepos = new Map(Object.entries(parsed.file.squadSessionRepos));
    for (const item of parsed.file.items) this.items.set(item.id, item);
    this.unsubscribeClaude = this.ports.claude.onChange(() => this.onClaudeRunChange());
    this.unsubscribeAgy = this.ports.agy.onChange(() => this.onClaudeRunChange());
    this.recoverClaudeRuns();
    this.recoverAgyRuns();
    await this.refreshCatalog();
    // A running item from before this start gets its grace check again.
    if ([...this.items.values()].some((item) => item.status === 'running'))
      this.scheduleGraceCheck();
    this.ensureMaintenance();
  }

  /** The folder's full state, as the board receives it. */
  snapshot(): CompanyWorkItemsMessage {
    const view = this.view();
    const items = this.sortedItems()
      .filter((item) => !isArchivedWorkItem(item, this.ports.now()))
      .map((item) => this.wire(item, view));
    return {
      type: 'companyWorkItems',
      workspacePath: this.workspacePath,
      revision: this.revision,
      items,
      roles: this.roles.map((role) => ({ ...role, agent: { ...role.agent } })),
      settings: { ...this.settings },
      claudeStatus: this.ports.claudeAuth.current(),
      claudeMcpServers: this.ports.claudeMcp.names([this.workspacePath, ...this.catalog.repos]),
      repos: [...this.catalog.repos],
      agents: this.catalog.agents.map((agent) => ({ ...agent })),
      parkedSessionIds: this.squadSessionIds.filter((id) =>
        view.sessions.some((session) => session.id === id && session.status === 'parked'),
      ),
    };
  }

  /** One item by id, as the board receives it. */
  get(id: string): WorkItem | undefined {
    const item = this.items.get(id);
    return item === undefined ? undefined : this.wire(item, this.view());
  }

  /** Archived items as the board would otherwise receive them. */
  archivedItems(): WorkItem[] {
    const view = this.view();
    return this.sortedItems()
      .filter((item) => isArchivedWorkItem(item, this.ports.now()))
      .map((item) => this.wire(item, view));
  }

  /** Returns an archived item to the board and persists the restoration timestamp. */
  async restore(id: string): Promise<void> {
    const item = this.items.get(id);
    if (item === undefined || !isArchivedWorkItem(item, this.ports.now())) {
      throw new CompanyError('work_item_not_found', 'Không tìm thấy việc đã lưu trữ.');
    }
    item.restoredAt = this.iso();
    this.commit();
    await this.flush();
  }

  /** The item with this #n, while it is still open: queued, running, waiting on input, or in review. */
  findOpen(sequence: number): WorkItem | undefined {
    const item = this.sortedItems().find(
      (entry) => entry.sequence === sequence && !isFinished(entry.status),
    );
    return item === undefined ? undefined : this.wire(item, this.view());
  }

  /**
   * Creates one item for an assignee. It is sent when the scheduler lets it start, and queued
   * until then. The same request id twice creates nothing new and answers with the first item's id.
   */
  async create(command: WorkItemCommand & Omit<WorkItemDraft, 'dependsOnDrafts'>): Promise<string> {
    const replayed = await this.catalogFor(command.requestId);
    if (replayed !== undefined) return replayed;
    const fields = this.validateDraft(command);
    const item = this.addItem(command, this.ports.newId(), command.dependsOn ?? [], fields);
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
    const answered = this.idsOfRun(options.squadRunId);
    if (answered.length > 0) return answered;
    await this.readCatalog();
    const again = this.idsOfRun(options.squadRunId);
    if (again.length > 0) return again;
    const plans = drafts.map((draft) => ({
      draft,
      id: this.ports.newId(),
      fields: this.validateDraft(draft),
    }));
    const waits = this.resolveBatchDependencies(plans);
    const created = plans.map((plan, index) =>
      this.addItem(plan.draft, plan.id, waits[index] ?? [], plan.fields, options.squadRunId),
    );
    // Waits on items of this batch can only be named once all of them exist.
    for (const item of created) item.waitSequences = this.sequencesOf(item.dependsOn);
    const ids = created.map((item) => item.id);
    await this.commitOrDiscard(ids, null);
    await this.reconcileAfterSave();
    return ids;
  }

  /**
   * Gives an item to another assignee, and sets its repo, role, areas and agent to the fields
   * sent (an absent field is cleared). The item is then queued again; the scheduler decides when.
   */
  async assign(
    command: WorkItemCommand & { id: string; assignee: WorkItemAssignee } & ItemFieldsInput,
  ): Promise<void> {
    if ((await this.catalogFor(command.requestId)) !== undefined) return;
    const item = this.requireItem(command.id);
    this.refuseUnlessReassignable(item);
    if (!isWorkItemAssignee(command.assignee)) {
      throw new CompanyError('assignee_invalid', MESSAGE.assigneeInvalid);
    }
    this.assertReachable(command.assignee);
    const fields = this.prepareFields(command);
    const before = structuredClone(item);
    item.assignee = normalizeAssignee(command.assignee);
    if (item.assignee.kind !== 'claude') delete item.claudeRun;
    if (item.assignee.kind !== 'agy') {
      this.stopAgyRun(item);
      delete item.agyRun;
    }
    applyFields(item, fields);
    this.requeue(
      item,
      this.promptFor(item.text, item.acceptance, fields.agent, item.assignee),
      'assigned',
      'Giao lại cho agent khác.',
    );
    this.remember(command.requestId, '');
    await this.commitOrRestore(before, command.requestId);
    await this.reconcileAfterSave();
  }

  /** Sends one more prompt to an item's assignee. Only for items in review or failed. */
  async followUp(command: WorkItemCommand & { id: string; text: string }): Promise<void> {
    if ((await this.catalogFor(command.requestId)) !== undefined) return;
    const item = this.requireItem(command.id);
    this.refuseUnlessFollowable(item);
    const refusal = refuseText(command.text);
    if (refusal !== null) throw this.textError(refusal);
    const text = command.text.trim();
    this.assertReachable(item.assignee);
    const before = structuredClone(item);
    this.requeue(
      item,
      this.promptFor(text, item.acceptance, item.agent, item.assignee),
      'followed_up',
      clip(text, WORK_ITEM_REASON_MAX_CHARS),
    );
    this.remember(command.requestId, '');
    await this.commitOrRestore(before, command.requestId);
    this.abortJudge(item);
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
    this.stopClaudeRun(item);
    this.stopAgyRun(item);
    item.status = command.verdict;
    this.abortJudge(item);
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
    this.notifySettled(item);
    await this.flush();
    // A verdict of done may free the items that waited for this one.
    if (command.verdict === 'done') await this.reconcileAfterSave();
  }

  /**
   * Removes an item nobody works on: a queued one never sent, or a finished one (done, failed).
   * Refused while the item's worktree is still on disk: the item is the board's only way back to it.
   */
  async cancel(command: WorkItemCommand & { id: string }): Promise<void> {
    if (this.replay(command.requestId) !== undefined) return;
    const item = this.requireItem(command.id);
    if (!canCancel(item.status)) this.refuseStatus(item);
    if (item.worktree !== undefined && item.worktreeRemoved !== true && this.ports.worktrees.exists(item.worktree))
      throw new CompanyError('work_item_status', MESSAGE.worktreeKept);
    const waiters = this.openWaitersOf(item.id);
    if (waiters.length > 0)
      throw new CompanyError(
        'work_item_awaited',
        awaitedMessage(waiters.map((waiter) => waiter.sequence)),
      );
    this.held.delete(item.id);
    this.items.delete(item.id);
    this.remember(command.requestId, '');
    this.commit();
    await this.flush();
  }

  /**
   * "board report": a note the agent writes about its own item, kept in the item's history. It
   * changes no status: a note is what the agent says, and the judge still decides.
   */
  async note(command: WorkItemCommand & { id: string; text: string }): Promise<void> {
    if (this.replay(command.requestId) !== undefined) return;
    const item = this.requireItem(command.id);
    const text = command.text.trim();
    if (text === '') throw new CompanyError('work_item_note', 'Nội dung báo cáo trống.');
    const at = this.iso();
    item.updatedAt = at;
    this.pushEvent(item, makeEvent(at, 'note', `Agent báo: ${text}`));
    this.remember(command.requestId, '');
    this.commit();
    await this.flush();
  }

  /** "Chấm lại": judges a review item again now. A conflict holds the judge until it clears. */
  async judgeAgain(command: WorkItemCommand & { id: string }): Promise<void> {
    if (this.replay(command.requestId) !== undefined) return;
    const item = this.requireItem(command.id);
    if (item.status !== 'review') throw new CompanyError('work_item_status', MESSAGE.status);
    this.remember(command.requestId, '');
    this.startJudge(item);
    await this.flush();
  }

  /**
   * Removes a done item's worktree once nothing in it is lost. Refused while a live session still
   * works in it, or when the worktree is dirty or its branch is not merged. Never forced.
   */
  async cleanWorktree(command: WorkItemCommand & { id: string }): Promise<void> {
    if (this.replay(command.requestId) !== undefined) return;
    const item = this.requireItem(command.id);
    const worktree = item.worktree;
    if (item.status !== 'done' || worktree === undefined || item.worktreeRemoved === true)
      throw new CompanyError('work_item_status', MESSAGE.noWorktree);
    const path = checkoutKey(worktree.path);
    const sessions = this.ports.sessions
      .list()
      .filter((session) => session.cwd !== undefined && checkoutKey(session.cwd) === path);
    if (
      sessions.some(
        (session) => session.status !== 'parked' && observeSessionStatus(session.status) !== 'gone',
      )
    )
      throw new CompanyError('work_item_status', MESSAGE.worktreeInUse);
    const outcome = await this.ports.worktrees.remove(item.repo ?? this.workspacePath, worktree);
    if (outcome === 'dirty') throw new CompanyError('work_item_status', MESSAGE.worktreeDirty);
    if (outcome === 'unmerged') throw new CompanyError('work_item_status', MESSAGE.worktreeUnmerged);
    const at = this.iso();
    item.worktreeRemoved = true;
    item.updatedAt = at;
    this.pushEvent(item, makeEvent(at, 'note', MESSAGE.worktreeRemoved));
    // A parked session on the removed checkout can never run again, so the squad forgets it.
    const removedSessions = new Set(sessions.map((session) => session.id));
    this.squadSessionIds = this.squadSessionIds.filter((id) => !removedSessions.has(id));
    for (const id of removedSessions) this.squadSessionRepos.delete(id);
    this.remember(command.requestId, '');
    this.commit();
    await this.flush();
  }

  /**
   * The open items (not done or failed) whose wait list names this item, oldest first. Cancelling
   * the item would leave each of them waiting on an id that no longer exists.
   */
  private openWaitersOf(id: string): StoredWorkItem[] {
    return [...this.items.values()]
      .filter((item) => !isFinished(item.status) && item.dependsOn.includes(id))
      .sort((a, b) => a.sequence - b.sequence);
  }

  /**
   * Replaces the wait list of a queued item. Only a queued item can change it. A save that fails
   * puts the item back as it was, so the new list is never used.
   */
  async setDependencies(
    command: WorkItemCommand & { id: string; dependsOn: readonly string[] },
  ): Promise<void> {
    if (this.replay(command.requestId) !== undefined) return;
    const item = this.requireItem(command.id);
    if (item.status !== 'queued') this.refuseStatus(item);
    this.refuseDependsOn(item.id, command.dependsOn);
    const before = structuredClone(item);
    item.dependsOn = [...command.dependsOn];
    item.waitSequences = this.sequencesOf(item.dependsOn);
    item.updatedAt = this.iso();
    this.pushEvent(item, makeEvent(item.updatedAt, 'note', this.waitNote(item.dependsOn)));
    this.remember(command.requestId, '');
    await this.commitOrRestore(before, command.requestId);
    await this.reconcileAfterSave();
  }

  /** Saves the role note for a herdr pane or an omp session. An empty description clears it. */
  async setRole(
    command: WorkItemCommand & { agent: WorkItemAssignee; description: string },
  ): Promise<void> {
    if (this.replay(command.requestId) !== undefined) return;
    if (
      !isWorkItemAssignee(command.agent) ||
      command.agent.kind === 'new-session' ||
      command.agent.kind === 'auto'
    ) {
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
   * Saves the folder's squad settings. Idempotent by request id. Raising a limit may let waiting
   * items start, so the pass runs once the change is on disk.
   */
  async setSettings(command: WorkItemCommand & { settings: SquadSettings }): Promise<void> {
    if (this.replay(command.requestId) !== undefined) return;
    if (!isSquadSettings(command.settings)) {
      throw new CompanyError('settings_invalid', MESSAGE.settingsInvalid);
    }
    this.settings = { ...command.settings };
    this.remember(command.requestId, '');
    this.commit();
    await this.flush();
    await this.reconcileAfterSave();
  }

  /** The folder's squad settings as they stand now. The role-specific engine selects each CLI. */
  currentSettings(): SquadSettings {
    return { ...this.settings };
  }

  /** The settings panel's Claude Code check: uses the status cached for up to 60 s, then publishes it. */
  async checkClaude(): Promise<void> {
    await this.ports.claudeAuth.check(false);
    this.commit();
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
    this.unsubscribeClaude?.();
    this.unsubscribeClaude = null;
    this.unsubscribeAgy?.();
    this.unsubscribeAgy = null;
    // Runs still in flight stop with the board; next start finds their items interrupted.
    for (const item of this.items.values()) {
      if (item.assignee.kind === 'claude' && item.claudeRunId !== undefined)
        this.ports.claude.kill(item.claudeRunId);
      const agyRunId = this.agyRunIds.get(item.id);
      if (item.assignee.kind === 'agy' && agyRunId !== undefined) this.ports.agy.kill(agyRunId);
    }
    for (const run of this.judgeRuns.values()) run.controller.abort();
    this.judgeRuns.clear();
    for (const cancel of this.cancelTimers) cancel();
    this.cancelTimers.clear();
    this.changeListeners.clear();
    this.settledListeners.clear();
  }

  /** Calls `listener` after every change to the folder's state. Returns the function that removes it. */
  onChange(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => {
      this.changeListeners.delete(listener);
    };
  }

  /**
   * Calls `listener` with each item the moment it settles: it reaches review, fails, or is marked done.
   * Returns the function that removes it.
   */
  onItemSettled(listener: (item: WorkItem) => void): () => void {
    this.settledListeners.add(listener);
    return () => {
      this.settledListeners.delete(listener);
    };
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
      await this.settleRollback();
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
      await this.settleRollback();
      throw error;
    }
  }

  /** Waits for pending writes; true when the newest one reached the disk. Keeps the error for flush. */
  private async writesLanded(): Promise<boolean> {
    await this.writeChain;
    return !this.lastWriteFailed;
  }

  /**
   * Saves a rollback, then drops its error: the command that asked for the change already reports
   * its own failure, and a later command must not inherit this one.
   */
  private async settleRollback(): Promise<void> {
    this.commit();
    await this.writeChain;
    this.saveError = null;
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

  /** Checks one draft and returns its item fields, normalized. Refuses anything the board must not store. */
  private validateDraft(draft: WorkItemDraft): WorkItemFields {
    const refusal = refuseText(draft.text);
    if (refusal !== null) throw this.textError(refusal);
    if (!isWorkItemAssignee(draft.assignee)) {
      throw new CompanyError('assignee_invalid', MESSAGE.assigneeInvalid);
    }
    this.assertReachable(draft.assignee);
    this.validateExtras(draft);
    return this.prepareFields(draft);
  }

  /** Checks the priority, criteria, and wait list a draft carries. */
  private validateExtras(
    draft: Pick<WorkItemDraft, 'priority' | 'acceptance' | 'dependsOn'>,
  ): void {
    if (draft.priority !== undefined && !isWorkItemPriority(draft.priority)) {
      throw new CompanyError('priority_invalid', MESSAGE.priorityInvalid);
    }
    const acceptance = draft.acceptance?.trim() ?? '';
    if (Array.from(acceptance).length > WORK_ITEM_ACCEPTANCE_MAX_CHARS) {
      throw new CompanyError('acceptance_too_long', MESSAGE.acceptanceTooLong);
    }
    this.refuseDependsOn(null, draft.dependsOn ?? []);
  }

  /**
   * Checks the repo, role, areas and agent an item names, and returns them normalized. The repo
   * must be one of the folder's repos and the agent one the catalog lists.
   */
  private prepareFields(input: ItemFieldsInput): WorkItemFields {
    const repo = input.repo?.trim() ?? '';
    const agent = input.agent?.trim() ?? '';
    const areas = normalizeAreas(input.areas ?? []);
    if (
      areas.length > WORK_ITEM_AREAS_MAX ||
      areas.some((area) => area.length > WORK_ITEM_AREA_MAX_CHARS)
    ) {
      throw new CompanyError('areas_invalid', MESSAGE.areasInvalid);
    }
    if (input.role !== undefined && !isItemRole(input.role)) {
      throw new CompanyError('item_role_invalid', MESSAGE.itemRoleInvalid);
    }
    const fields: WorkItemFields = { areas };
    if (repo !== '') {
      const match = this.catalog.repos.find((entry) => checkoutKey(entry) === checkoutKey(repo));
      if (match === undefined) throw new CompanyError('repo_invalid', MESSAGE.repoInvalid);
      fields.repo = match;
    }
    if (input.role !== undefined) fields.role = input.role;
    if (agent !== '') {
      if (findAgent(this.catalog.agents, agent) === undefined) {
        throw new CompanyError('agent_unknown', MESSAGE.agentUnknown);
      }
      fields.agent = agent;
    }
    return fields;
  }

  /** Refuses a wait list the core check rejects. `dependencyOf` sees the items the list may name. */
  private refuseDependsOn(
    selfId: string | null,
    dependsOn: readonly string[],
    dependencyOf: (id: string) => readonly string[] | undefined = (id) =>
      this.items.get(id)?.dependsOn,
  ): void {
    const refusal = checkDependsOn(selfId, dependsOn, dependencyOf);
    if (refusal !== null) throw new CompanyError('dependency_invalid', DEPENDS_MESSAGE[refusal]);
  }

  /**
   * Maps each draft's wait list to real ids: ids named outright, and batch positions to the ids
   * minted for them. Refuses a position outside the batch or on the draft itself, and any loop.
   */
  private resolveBatchDependencies(
    plans: readonly { readonly draft: WorkItemDraft; readonly id: string }[],
  ): string[][] {
    const waits = plans.map((plan, index) => {
      const fromBatch = (plan.draft.dependsOnDrafts ?? []).map((position) => {
        const target = plans[position];
        if (target === undefined || position === index) {
          throw new CompanyError('dependency_invalid', MESSAGE.badRow);
        }
        return target.id;
      });
      return [...(plan.draft.dependsOn ?? []), ...fromBatch];
    });
    const batchWaits = new Map(plans.map((plan, index) => [plan.id, waits[index] ?? []]));
    const dependencyOf = (id: string): readonly string[] | undefined =>
      batchWaits.get(id) ?? this.items.get(id)?.dependsOn;
    plans.forEach((plan, index) => {
      this.refuseDependsOn(plan.id, waits[index] ?? [], dependencyOf);
    });
    return waits;
  }

  /**
   * Refuses an assignee the board cannot reach right now. New sessions and auto items are always
   * reachable: a new session opens when it starts, and an auto item picks its agent then.
   */
  private assertReachable(assignee: WorkItemAssignee): void {
    if (
      assignee.kind === 'new-session' ||
      assignee.kind === 'auto' ||
      assignee.kind === 'claude' ||
      assignee.kind === 'agy'
    )
      return;
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

  /** Adds a new queued item under `id`. Nothing is sent here; the pass decides when. */
  private addItem(
    draft: WorkItemDraft,
    id: string,
    dependsOn: readonly string[],
    fields: WorkItemFields,
    squadRunId?: string,
  ): StoredWorkItem {
    const at = this.iso();
    const text = draft.text.trim();
    const acceptance = draft.acceptance?.trim() ?? '';
    const item: StoredWorkItem = {
      id,
      text,
      assignee: normalizeAssignee(draft.assignee),
      status: 'queued',
      sequence: this.nextSequence,
      priority: draft.priority ?? WORK_ITEM_PRIORITY_DEFAULT,
      dependsOn: [...dependsOn],
      waitSequences: this.sequencesOf(dependsOn),
      reason: WORK_ITEM_REASON.queued,
      createdAt: at,
      updatedAt: at,
      history: [makeEvent(at, 'created'), makeEvent(at, 'queued')],
      pendingPrompt: this.promptFor(text, acceptance, fields.agent, draft.assignee),
      ...(acceptance === '' ? {} : { acceptance }),
      ...(squadRunId === undefined ? {} : { squadRunId }),
      ...(draft.inPlace === true ? { inPlace: true } : {}),
    };
    applyFields(item, fields);
    this.nextSequence += 1;
    this.items.set(item.id, item);
    return item;
  }

  /**
   * The prompt an item owes its agent: its text, the subagent line, the safe-work block, then acceptance.
   * A Claude Code assignee gets the role line for its engine, not the omp task tool.
   */
  private promptFor(
    text: string,
    acceptance: string | undefined,
    agent: string | undefined,
    assignee: WorkItemAssignee,
  ): string {
    const engine: PromptEngine = assignee.kind === 'claude' ? 'claude' : 'omp';
    return composeDispatchPrompt({
      text,
      acceptance,
      agent,
      readOnly: this.isReadOnly(agent),
      engine,
    });
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
    for (const listener of this.changeListeners) listener();
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
      settings: { ...this.settings },
      squadSessionIds: [...this.squadSessionIds],
      squadSessionRepos: Object.fromEntries(this.squadSessionRepos),
    };
  }

  /**
   * Keeps the newest finished items. Live items are never pruned, and neither is a finished item
   * that a live one still waits for, so that wait can still be read.
   */
  private prune(): void {
    const awaited = new Set<string>();
    for (const item of this.items.values()) {
      if (!isFinished(item.status)) for (const id of item.dependsOn) awaited.add(id);
    }
    const finished = [...this.items.values()]
      .filter((item) => isFinished(item.status))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    let kept = 0;
    for (const item of finished) {
      if (kept < WORK_ITEM_FINISHED_KEEP || awaited.has(item.id)) {
        kept += 1;
        continue;
      }
      this.items.delete(item.id);
    }
  }

  /**
   * One status pass. It judges every agent that has live items (finished, gone, or still busy),
   * then starts each ready queued item the scheduler lets go, in queue order.
   */
  private async pass(): Promise<void> {
    const view = this.view();
    for (const key of this.liveAgentKeys()) {
      const items = this.liveItemsFor(key);
      const first = items[0];
      if (first === undefined) continue;
      const observation = this.observeAssignee(first.assignee, view);
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
      if (active !== undefined) await this.advance(active, observation);
    }
    this.reconcileClaudeRuns();
    this.reconcileAgyRuns();
    await this.startQueued(view);
  }

  /** Starts each ready queued item the scheduler lets go, in queue order, one decision at a time. */
  private async startQueued(view: FolderView): Promise<void> {
    for (const candidate of this.queueOrder()) {
      // An earlier start may have saved, failed or cancelled items, so each is checked as it comes.
      if (this.items.get(candidate.id) !== candidate || candidate.status !== 'queued') continue;
      if (!this.isReady(candidate)) continue;
      const decision = decideStart(this.schedulerItem(candidate), this.schedulerContext(view));
      if (decision.kind === 'wait') {
        if (this.held.delete(candidate.id)) this.ports.publish(this.snapshot());
        continue;
      }
      await this.start(candidate, decision);
    }
  }

  /**
   * Starts one item the scheduler let go. An auto item takes the member chosen for it; a decision
   * to open a session opens it first, and the session is remembered as the squad's.
   */
  private async start(item: StoredWorkItem, decision: StartDecision): Promise<void> {
    const auto = item.assignee.kind === 'auto';
    if (decision.kind === 'claude' || decision.kind === 'agy') {
      // In-place items keep the chosen checkout; other editing runs receive an isolated worktree.
      const cwd = decision.readOnly || item.inPlace === true
        ? decision.cwd
        : await this.isolatedCheckout(item, decision.cwd);
      if (cwd === undefined) return;
      if (auto) {
        item.assignee = { kind: decision.kind };
        item.pendingPrompt = this.promptFor(item.text, item.acceptance, item.agent, item.assignee);
        const cli = decision.kind === 'agy' ? 'Antigravity (agy)' : 'Claude Code (claude -p)';
        this.pushEvent(item, makeEvent(this.iso(), 'assigned', `Tự chọn: ${cli}.`));
      }
    } else if (decision.kind === 'open') {
      const cwd = decision.isolate ? await this.isolatedCheckout(item, decision.cwd) : decision.cwd;
      if (cwd === undefined) return;
      let sessionId: string;
      try {
        sessionId = await this.ports.sessions.openChat({
          cwd,
          role: decision.role,
          workstreamKey: squadWorkstreamKey(decision.role, cwd),
        });
      } catch (error) {
        // A full omp runner pool is temporary: the item waits and the next pass tries it again.
        if (error instanceof CompanyError && error.code === 'company_pool_full') {
          this.hold(item, { kind: 'pool_full' });
          return;
        }
        this.fail(item, WORK_ITEM_REASON.openFailed, describe(error));
        return;
      }
      this.recordSquadSession(sessionId, decision.cwd);
      item.assignee = { kind: 'session', sessionId };
      const message = auto
        ? `Tự chọn: mở phiên omp mới trong ${checkoutName(decision.cwd)}.`
        : 'Mở phiên omp mới cho việc này.';
      this.pushEvent(item, makeEvent(this.iso(), 'assigned', message));
    } else if (auto) {
      item.assignee = normalizeAssignee(decision.member.assignee);
      this.pushEvent(
        item,
        makeEvent(this.iso(), 'assigned', `Tự chọn: ${memberLabel(decision.member)}.`),
      );
    }
    this.held.delete(item.id);
    await this.dispatch(item);
  }

  /**
   * Remembers a session the squad opened for `repo`, keeping the newest SQUAD_SESSIONS_KEPT. The
   * repo is what reuse matches on, since an isolated session's cwd is its own worktree.
   */
  private recordSquadSession(sessionId: string, repo: string): void {
    this.squadSessionIds = [
      ...this.squadSessionIds.filter((id) => id !== sessionId),
      sessionId,
    ].slice(-SQUAD_SESSIONS_KEPT);
    this.squadSessionRepos.set(sessionId, repo);
    for (const id of [...this.squadSessionRepos.keys()]) {
      if (!this.squadSessionIds.includes(id)) this.squadSessionRepos.delete(id);
    }
  }

  /** Keys of the agents that have live items, in order of their oldest live item. */
  private liveAgentKeys(): string[] {
    const keys = new Map<string, number>();
    for (const item of this.sortedItems()) {
      // CLI items have no live pane/session to observe; their run state is reconciled directly.
      if (
        !isLive(item) ||
        item.assignee.kind === 'new-session' ||
        item.assignee.kind === 'auto' ||
        item.assignee.kind === 'claude' ||
        item.assignee.kind === 'agy'
      )
        continue;
      const key = assigneeKey(item.assignee);
      if (!keys.has(key)) keys.set(key, item.sequence);
    }
    return [...keys.keys()];
  }

  /** Live items of one agent, in queue order: priority first, then creation order. */
  private liveItemsFor(key: string): StoredWorkItem[] {
    return this.queueOrder().filter((item) => isLive(item) && assigneeKey(item.assignee) === key);
  }

  /** Every item in queue order: priority first, then creation order. */
  private queueOrder(): StoredWorkItem[] {
    return [...this.items.values()].sort(compareQueue);
  }

  private sortedItems(): StoredWorkItem[] {
    return [...this.items.values()].sort((a, b) => a.sequence - b.sequence);
  }

  /** The folder's herdr and session views as they stand now. */
  private view(): FolderView {
    return { roster: this.ports.roster.panes(), sessions: this.ports.sessions.list() };
  }

  /** One item as the board receives it: a queued item carries what it waits on, or why it cannot start. */
  private wire(item: StoredWorkItem, view: FolderView): WorkItem {
    const base = toWorkItem(item);
    const report = this.conflictReports.get(item.id);
    const wire: WorkItem =
      report === undefined
        ? base
        : { ...base, conflicts: { sequences: [...report.sequences], main: report.main } };
    if (item.status !== 'queued') return wire;
    // Agents are judged by the scheduler below; the dependency check never reads them.
    const blocker = blockerOf(item.dependsOn, (id) => this.dependencyState(item, id), false);
    if (blocker !== null) return { ...wire, blocker, reason: blockerReason(blocker) };
    const decision = decideStart(this.schedulerItem(item), this.schedulerContext(view));
    if (decision.kind === 'wait') return { ...wire, blocker: decision.blocker, reason: decision.reason };
    const held = this.held.get(item.id);
    if (held === undefined) return wire;
    return { ...wire, blocker: held, reason: blockerReason(held) };
  }

  /** What the queue knows about one dependency: its status, or failed at its last #n once it is gone. */
  private dependencyState(item: StoredWorkItem, id: string): DependencyState {
    const dependency = this.items.get(id);
    if (dependency !== undefined)
      return { status: dependency.status, sequence: dependency.sequence };
    return { status: 'failed', sequence: item.waitSequences[id] ?? 0 };
  }

  /** Whether every item the queued item waits for is done, so the pass may send it. */
  private isReady(item: StoredWorkItem): boolean {
    return dependenciesDone(item.dependsOn, (id) => this.dependencyState(item, id));
  }

  /** Whether an agent may edit the work: a read-only agent takes no area or checkout lock. */
  private isReadOnly(agent: string | undefined): boolean {
    return agent !== undefined && findAgent(this.catalog.agents, agent)?.readOnly === true;
  }

  /** The scheduler's view of one item. Explicit agents carry their member key; auto and new-session items do not. */
  private schedulerItem(item: StoredWorkItem): SchedulerItem {
    const explicit = item.assignee.kind === 'herdr' || item.assignee.kind === 'session';
    return {
      sequence: item.sequence,
      kind: item.assignee.kind,
      memberKey: explicit ? assigneeKey(item.assignee) : undefined,
      repo: item.repo ?? this.workspacePath,
      role: item.role,
      areas: item.areas ?? [],
      readOnly: this.isReadOnly(item.agent),
      inPlace: item.inPlace === true,
      agent: item.agent,
    };
  }

  /** Everything a scheduling decision reads, gathered from the views, the items, the settings and memory. */
  private schedulerContext(view: FolderView): SchedulerContext {
    const members = this.members(view);
    const checkouts = new Map(members.map((member) => [member.key, member.cwd]));
    const holds: SchedulerHold[] = [];
    for (const item of this.items.values()) {
      if (!occupiesAgent(item.status)) continue;
      const memberKey = assigneeKey(item.assignee);
      holds.push({
        memberKey,
        sequence: item.sequence,
        readOnly: this.isReadOnly(item.agent),
        areas: item.areas ?? [],
        checkout: item.inPlace === true ? item.repo : checkouts.get(memberKey),
      });
    }
    const squadSessionsOpen = this.squadSessionIds.filter((id) =>
      view.sessions.some((session) => session.id === id && observeSessionStatus(session.status) !== 'gone'),
    ).length;
    return {
      members,
      holds,
      maxParallel: this.settings.maxParallel,
      maxSquadSessions: this.settings.maxSquadSessions,
      squadSessionsOpen,
      freeBytes: this.ports.freeMemoryBytes(),
      minFreeBytes: this.settings.minFreeRamGb * GIB,
      claudeRunsOpen: this.claudeRunsOpen(),
      maxClaudeRuns: this.settings.maxClaudeRuns,
      agyRunsOpen: this.agyRunsOpen(),
      maxAgyRuns: this.settings.maxAgyRuns,
      engineWorker: this.settings.engineWorker,
    };
  }

  /** Every herdr pane and omp session as a scheduler member, with its role note and whether it reads free. */
  private members(view: FolderView): SchedulerMember[] {
    const notes = new Map(this.roles.map((role) => [assigneeKey(role.agent), role.description]));
    const panes = view.roster.panes.map((pane): SchedulerMember => {
      const assignee: WorkItemAssignee = { kind: 'herdr', paneId: pane.paneId };
      const key = assigneeKey(assignee);
      const observed = view.roster.available ? observeHerdrStatus(pane.status) : 'unknown';
      return {
        key,
        assignee,
        cwd: pane.cwd,
        role: undefined,
        note: notes.get(key),
        free: observed === 'free',
        busy: observed === 'busy' || observed === 'blocked',
        squadRepo: undefined,
      };
    });
    const sessions = view.sessions.map((session): SchedulerMember => {
      const assignee: WorkItemAssignee = { kind: 'session', sessionId: session.id };
      const key = assigneeKey(assignee);
      const observed = observeAssigneeSession(session.status, this.squadSessionIds.includes(session.id));
      return {
        key,
        assignee,
        cwd: session.cwd,
        role: isItemRole(session.role) ? session.role : undefined,
        note: notes.get(key),
        free: observed === 'free',
        busy: observed === 'busy' || observed === 'blocked',
        squadRepo: this.squadSessionRepos.get(session.id),
      };
    });
    return [...panes, ...sessions];
  }

  /** Reads the folder's repos and agents, publishing them when they changed. */
  private async readCatalog(): Promise<void> {
    if (await this.refreshCatalog()) this.ports.publish(this.snapshot());
  }

  /** The answer already given to this request, or undefined. A new request reads the catalog first. */
  private async catalogFor(requestId: string): Promise<string | undefined> {
    const replayed = this.replay(requestId);
    if (replayed !== undefined) return replayed;
    await this.readCatalog();
    return this.replay(requestId);
  }

  /**
   * Reads the folder's repos and omp agents. A failed read keeps the lists it had, and the next
   * command reads again. Returns whether the lists changed.
   */
  private async refreshCatalog(): Promise<boolean> {
    let next: WorkItemCatalog;
    try {
      next = await this.ports.catalog();
    } catch {
      return false;
    }
    const changed = JSON.stringify(next) !== JSON.stringify(this.catalog);
    this.catalog = {
      repos: [...next.repos],
      agents: next.agents.map((agent) => ({ ...agent })),
      claudeAgents: [...next.claudeAgents],
    };
    return changed;
  }

  /** Ids of the items one squad run already created, oldest first. */
  private idsOfRun(squadRunId: string): string[] {
    return [...this.items.values()]
      .filter((item) => item.squadRunId === squadRunId)
      .sort((a, b) => a.sequence - b.sequence)
      .map((item) => item.id);
  }

  /** What the queue knows about the herdr pane or session an item names. */
  private observeAssignee(assignee: WorkItemAssignee, view: FolderView): AgentObservation {
    // CLI runs are reconciled from their run state, never observed as agents.
    if (assignee.kind === 'claude' || assignee.kind === 'agy') return 'unknown';
    if (assignee.kind === 'new-session' || assignee.kind === 'auto') return 'free';
    if (assignee.kind === 'herdr') {
      if (!view.roster.available) return 'unknown';
      const pane = view.roster.panes.find((entry) => entry.paneId === assignee.paneId);
      return pane === undefined ? 'gone' : observeHerdrStatus(pane.status);
    }
    const session = view.sessions.find((entry) => entry.id === assignee.sessionId);
    if (session === undefined) return 'gone';
    return observeAssigneeSession(session.status, this.squadSessionIds.includes(session.id));
  }

  /** The #n of each listed item, kept on the waiting item so a removed dependency can still be named. */
  private sequencesOf(ids: readonly string[]): Record<string, number> {
    const waits: Record<string, number> = {};
    for (const id of ids) {
      const dependency = this.items.get(id);
      if (dependency !== undefined) waits[id] = dependency.sequence;
    }
    return waits;
  }

  /** The history line for a changed wait list, naming the waited-for items by #n. */
  private waitNote(dependsOn: readonly string[]): string {
    if (dependsOn.length === 0) return 'Bỏ hết việc chờ.';
    const sequences = dependsOn.map((id) => `#${this.items.get(id)?.sequence ?? 0}`);
    return `Chờ việc ${sequences.join(', ')}.`;
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
    // A judge that held the item for the user keeps it in needs-input until the user acts.
    if (item.status === 'needs_input' && item.reason?.startsWith(JUDGE_NOT_MET_PREFIX) === true)
      return;
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
    this.moveToReview(item, result, 'Agent đã dừng.');
  }

  /** Moves a running item to review with its result, then checks conflicts and judges it when autoJudge is on. */
  private moveToReview(item: StoredWorkItem, result: string | undefined, message: string): void {
    const at = this.iso();
    this.observedBusy.delete(item.id);
    item.status = 'review';
    item.updatedAt = at;
    item.reason = WORK_ITEM_REASON.review;
    if (result === undefined) delete item.result;
    else item.result = result;
    this.pushEvent(item, makeEvent(at, 'status', message));
    this.again = true;
    this.commit();
    this.notifySettled(item);
    this.judgeAfterReview(item);
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
    this.held.delete(item.id);
    item.status = 'failed';
    this.abortJudge(item);
    item.updatedAt = at;
    item.reason = clip(reason, WORK_ITEM_REASON_MAX_CHARS);
    this.pushEvent(item, makeEvent(at, 'status', message));
    this.again = true;
    this.commit();
    this.notifySettled(item);
  }

  /** Sends a queued item to its agent. `start` has already chosen the agent and opened its session. */
  private async dispatch(item: StoredWorkItem): Promise<void> {
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
      await this.send(item, item.pendingPrompt);
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

  private async send(item: StoredWorkItem, text: string): Promise<void> {
    const assignee = item.assignee;
    if (assignee.kind === 'claude') {
      this.startClaudeRun(item, text);
      return;
    }
    if (assignee.kind === 'agy') {
      this.startAgyRun(item, text);
      return;
    }
    if (assignee.kind === 'herdr') {
      await this.ports.roster.prompt(assignee.paneId ?? '', text);
      return;
    }
    if (assignee.kind === 'session') {
      const sessionId = assignee.sessionId ?? '';
      const view = this.ports.sessions.list().find((entry) => entry.id === sessionId);
      // A parked session is brought back first: a prompt sent to it would be refused.
      if (view?.status === 'parked') await this.ports.sessions.wake(sessionId);
      const role = view?.role;
      await this.ports.sessions.submit(
        sessionId,
        text,
        role === 'chat' ? 'chat' : 'company',
        this.ports.newId(),
      );
      return;
    }
    throw new Error('item has no agent to send to yet');
  }

  /** Whether the item's Claude Code run is in flight: its items are running or waiting for the user. */
  private claudeRunsOpen(): number {
    let open = 0;
    for (const item of this.items.values()) {
      if (item.assignee.kind === 'claude' && occupiesAgent(item.status)) open += 1;
    }
    return open;
  }

  private agyRunsOpen(): number {
    let open = 0;
    for (const item of this.items.values()) {
      if (item.assignee.kind === 'agy' && occupiesAgent(item.status)) open += 1;
    }
    return open;
  }

  /** Starts the Claude Code run that carries a dispatched item. A follow-up resumes the session the run opened. */
  private startClaudeRun(item: StoredWorkItem, prompt: string): void {
    const mode = this.isReadOnly(item.agent) ? 'read' : 'edit';
    const cwd = mode === 'read' || item.inPlace === true
      ? (item.repo ?? this.workspacePath)
      : item.worktree?.path;
    if (cwd === undefined) throw new Error('Việc này chưa có worktree để Claude Code làm.');
    const sessionId = item.claudeRun?.sessionId;
    const started = this.ports.claude.start({
      cwd,
      prompt,
      mode,
      sessionId: sessionId ?? this.ports.newId(),
      resume: sessionId !== undefined,
      agent: this.claudeAgentFor(item.agent),
      maxTurns: this.settings.claudeMaxTurns,
      permission: this.settings.claudePermission,
      allowedTools: this.settings.claudeAllowedTools,
      maxBudgetUsd: this.settings.claudeMaxBudgetUsd,
      mcpConfig: this.ports.claudeMcp.configFor(
        item.repo ?? this.workspacePath,
        this.settings.claudeWorkerMcp,
      ),
    });
    item.claudeRunId = started.runId;
    if (started.pid === undefined) delete item.claudeRunPid;
    else item.claudeRunPid = started.pid;
    item.claudeRun = {
      mode,
      startedAt: this.iso(),
      ...(sessionId === undefined ? {} : { sessionId }),
    };
  }

  /**
   * Starts the Antigravity run that carries a dispatched item. A later run of the same item (a
   * follow-up, a judge's request) continues the conversation the first run opened, so the agent
   * keeps the task: a fresh agy run would get the follow-up text alone.
   */
  private startAgyRun(item: StoredWorkItem, prompt: string): void {
    const mode = this.isReadOnly(item.agent) ? 'read' : 'edit';
    const cwd = mode === 'read' || item.inPlace === true
      ? (item.repo ?? this.workspacePath)
      : item.worktree?.path;
    if (cwd === undefined) throw new Error('Việc này chưa có worktree để Antigravity làm.');
    const conversationId = item.agyRun?.conversationId;
    const started = this.ports.agy.start({ cwd, prompt, ...(conversationId === undefined ? {} : { conversationId }) });
    this.agyRunIds.set(item.id, started.runId);
    item.agyRun = {
      mode,
      startedAt: this.iso(),
      ...(started.pid === undefined ? {} : { pid: started.pid }),
      ...(conversationId === undefined ? {} : { conversationId }),
    };
  }

  /** The Claude Code subagent an item runs as: its role name, when Claude Code has an agent by that name. */
  private claudeAgentFor(agent: string | undefined): string | undefined {
    if (agent === undefined || agent === DEFAULT_AGENT) return undefined;
    return this.catalog.claudeAgents.includes(agent) ? agent : undefined;
  }

  /** Stops an item's Claude Code run in flight, if any, and forgets it. Its progress goes with it. */
  private stopClaudeRun(item: StoredWorkItem): void {
    if (item.claudeRunId === undefined) return;
    this.ports.claude.kill(item.claudeRunId);
    this.ports.claude.forget(item.claudeRunId);
    delete item.claudeRunId;
    delete item.claudeRunPid;
    if (item.claudeRun !== undefined) delete item.claudeRun.progress;
  }

  /** Run output arrives in bursts: one status pass covers each burst. */
  private onClaudeRunChange(): void {
    if (this.claudeNotifyPending) return;
    this.claudeNotifyPending = true;
    const cancel = this.ports.schedule(() => {
      this.cancelTimers.delete(cancel);
      this.claudeNotifyPending = false;
      this.scheduleReconcile();
    }, CLAUDE_PROGRESS_MS);
    this.cancelTimers.add(cancel);
  }

  /** On load, each Claude Code run that was running when the board stopped fails as interrupted. */
  private recoverClaudeRuns(): void {
    for (const item of this.items.values()) {
      if (item.assignee.kind !== 'claude' || item.status !== 'running') continue;
      this.interruptClaude(item);
    }
  }

  /** Moves each running Claude Code item along, given its run's state now. */
  private reconcileClaudeRuns(): void {
    for (const item of this.items.values()) {
      if (item.assignee.kind !== 'claude' || item.status !== 'running') continue;
      const runId = item.claudeRunId;
      const view = runId === undefined ? undefined : this.ports.claude.view(runId);
      if (view === undefined) this.interruptClaude(item);
      else if (view.state === 'running') this.observeClaudeRun(item, view);
      else this.settleClaudeRun(item, view);
    }
  }

  /** A run still going: its progress, and once the CLI has opened the session, the id a follow-up resumes. */
  private observeClaudeRun(item: StoredWorkItem, view: ClaudeRunView): void {
    const run = item.claudeRun;
    if (run === undefined) return;
    const opened = run.sessionId === undefined && view.started;
    const progressChanged = view.progress !== undefined && view.progress !== run.progress;
    if (!opened && !progressChanged) return;
    if (opened) run.sessionId = view.sessionId;
    if (view.progress !== undefined) run.progress = view.progress;
    if (opened) this.commit();
    else this.ports.publish(this.snapshot());
  }

  /** A run that ended: its result goes to review; a failure, a timeout or a stop fails the item with the reason. */
  private settleClaudeRun(item: StoredWorkItem, view: ClaudeRunView): void {
    if (item.claudeRunId !== undefined) this.ports.claude.forget(item.claudeRunId);
    delete item.claudeRunId;
    delete item.claudeRunPid;
    if (item.claudeRun !== undefined) delete item.claudeRun.progress;
    if (view.state === 'finished') {
      const result =
        view.result === undefined ? undefined : clip(view.result, WORK_ITEM_RESULT_MAX_CHARS);
      this.moveToReview(item, result, 'Claude Code đã chạy xong.');
    } else if (view.state === 'timeout') {
      this.fail(item, WORK_ITEM_REASON.claudeTimeout);
    } else if (view.state === 'killed') {
      this.fail(item, WORK_ITEM_REASON.markedFailed);
    } else {
      const detail = view.error ?? 'không rõ lý do';
      this.fail(item, WORK_ITEM_REASON.claudeFailed(detail), detail);
    }
  }

  /**
   * A Claude Code run the board no longer follows. The item fails with the interrupted reason, so
   * "Gửi tiếp" resumes its session; a failed item holds no agent slot, unlike a waiting one.
   */
  private interruptClaude(item: StoredWorkItem): void {
    delete item.claudeRunId;
    delete item.claudeRunPid;
    if (item.claudeRun !== undefined) {
      delete item.claudeRun.progress;
      item.claudeRun.interrupted = true;
    }
    this.fail(item, WORK_ITEM_REASON.claudeInterrupted);
  }

  private stopAgyRun(item: StoredWorkItem): void {
    const runId = this.agyRunIds.get(item.id);
    if (runId !== undefined) {
      this.ports.agy.kill(runId);
      this.ports.agy.forget(runId);
      this.agyRunIds.delete(item.id);
    }
    if (item.agyRun !== undefined) {
      delete item.agyRun.progress;
      delete item.agyRun.pid;
    }
  }

  private recoverAgyRuns(): void {
    for (const item of this.items.values()) {
      if (item.assignee.kind !== 'agy' || item.status !== 'running') continue;
      this.interruptAgy(item);
    }
  }

  private reconcileAgyRuns(): void {
    for (const item of this.items.values()) {
      if (item.assignee.kind !== 'agy' || item.status !== 'running') continue;
      const runId = this.agyRunIds.get(item.id);
      const view = runId === undefined ? undefined : this.ports.agy.view(runId);
      if (view === undefined) this.interruptAgy(item);
      else if (view.state === 'running') this.observeAgyRun(item, view);
      else this.settleAgyRun(item, view);
    }
  }

  private observeAgyRun(item: StoredWorkItem, view: AgyRunView): void {
    const run = item.agyRun;
    if (run === undefined) return;
    const conversationChanged = view.conversationId !== undefined && view.conversationId !== run.conversationId;
    if (conversationChanged) run.conversationId = view.conversationId;
    const progressChanged = view.progress !== undefined && view.progress !== run.progress;
    if (progressChanged) run.progress = view.progress;
    if (conversationChanged || progressChanged) this.ports.publish(this.snapshot());
  }

  private settleAgyRun(item: StoredWorkItem, view: AgyRunView): void {
    const runId = this.agyRunIds.get(item.id);
    if (runId !== undefined) this.ports.agy.forget(runId);
    this.agyRunIds.delete(item.id);
    if (item.agyRun !== undefined) {
      delete item.agyRun.progress;
      delete item.agyRun.pid;
      if (view.conversationId !== undefined) item.agyRun.conversationId = view.conversationId;
    }
    if (view.state === 'finished') {
      this.moveToReview(item, view.result === undefined ? undefined : clip(view.result, WORK_ITEM_RESULT_MAX_CHARS), 'Antigravity đã chạy xong.');
    } else if (view.state === 'timeout') {
      this.fail(item, 'Antigravity chạy quá lâu nên đã dừng.');
    } else if (view.state === 'killed') {
      this.fail(item, WORK_ITEM_REASON.markedFailed);
    } else {
      const detail = view.error ?? 'không rõ lý do';
      this.fail(item, `Antigravity dừng lỗi: ${detail}`, detail);
    }
  }

  private interruptAgy(item: StoredWorkItem): void {
    this.agyRunIds.delete(item.id);
    if (item.agyRun !== undefined) {
      delete item.agyRun.progress;
      delete item.agyRun.pid;
      item.agyRun.interrupted = true;
    }
    this.fail(item, 'Board khởi động lại khi Antigravity đang chạy. Gửi tiếp để chạy lại.');
  }

  /** Re-checks the pass once the grace window after a dispatch has passed. */
  private scheduleGraceCheck(): void {
    const cancel = this.ports.schedule(() => {
      this.cancelTimers.delete(cancel);
      this.scheduleReconcile();
    }, WORK_ITEM_GRACE_MS);
    this.cancelTimers.add(cancel);
  }

  /**
   * The checkout an editing item's new session opens in: the worktree made for the item earlier, or a
   * new one in its repo. Undefined when that failed; the item then waits with a worktree blocker.
   */
  private async isolatedCheckout(item: StoredWorkItem, repo: string): Promise<string | undefined> {
    if (item.worktree !== undefined) return item.worktree.path;
    // Making a worktree of a large repo takes a while (fetch, checkout, setup script): say so.
    // A retry after a failed attempt says nothing new: the note stays the item's last event.
    if (item.history.at(-1)?.message !== MESSAGE.worktreeMaking) {
      this.pushEvent(item, makeEvent(this.iso(), 'note', MESSAGE.worktreeMaking));
    }
    this.commit();
    let worktree: SquadWorktree;
    try {
      worktree = await this.ports.worktrees.create(repo, item.id.slice(0, 8));
    } catch (error) {
      const detail = clip(describe(error), WORK_ITEM_BLOCKER_DETAIL_MAX_CHARS);
      this.hold(item, { kind: 'worktree', detail });
      return undefined;
    }
    try {
      await this.ports.prepareWorktree?.({
        folder: this.workspacePath,
        repo,
        worktree: worktree.path,
      });
    } catch (error) {
      item.worktree = worktree;
      this.fail(
        item,
        error instanceof Error
          ? `Script chuẩn bị worktree thất bại: ${error.message}`
          : 'Script chuẩn bị worktree thất bại.',
      );
      return undefined;
    }
    item.worktree = worktree;
    this.commit();
    // The user marked or cancelled the item while its worktree was made: it is kept on the item, so
    // "Dọn worktree" still reaches it, and nothing starts.
    if (this.items.get(item.id) !== item || item.status !== 'queued') return undefined;
    // The worktree must be on disk before its session opens; otherwise a restart would make another.
    if (!(await this.writesLanded())) {
      this.hold(item, { kind: 'worktree', detail: 'không lưu được việc để nhớ worktree' });
      return undefined;
    }
    return worktree.path;
  }

  /** Keeps a ready item queued with the reason it cannot start yet, and schedules another pass. */
  private hold(item: StoredWorkItem, blocker: WorkItemBlocker): void {
    const before = this.held.get(item.id);
    this.held.set(item.id, blocker);
    if (before?.kind !== blocker.kind || before.detail !== blocker.detail) {
      this.ports.publish(this.snapshot());
    }
    this.scheduleHoldRetry();
  }

  /** Runs another pass after the hold delay, unless one is already scheduled. */
  private scheduleHoldRetry(): void {
    if (this.holdRetryPending) return;
    this.holdRetryPending = true;
    const cancel = this.ports.schedule(() => {
      this.cancelTimers.delete(cancel);
      this.holdRetryPending = false;
      this.scheduleReconcile();
    }, WORK_ITEM_HOLD_RETRY_MS);
    this.cancelTimers.add(cancel);
  }

  /** Tells each settled listener about an item that reached review, failed, or was marked done. */
  private notifySettled(item: StoredWorkItem): void {
    const settled = toWorkItem(item);
    for (const listener of this.settledListeners) listener(settled);
  }

  /**
   * Checks conflicts, then judges a review item when autoJudge is on. The check comes first so the
   * judge reads current overlaps, and a conflicting item is never passed.
   */
  private judgeAfterReview(item: StoredWorkItem): void {
    if (this.disposed) return;
    void this.refreshConflicts().then(() => {
      const current = this.items.get(item.id);
      if (this.settings.autoJudge && current?.status === 'review') this.startJudge(current);
    });
  }

  /**
   * Starts one judge turn for a review item, or holds it while a conflict stands. A turn already in
   * flight is never doubled. The caller decides whether automatic judging applies.
   */
  private startJudge(item: StoredWorkItem): void {
    if (this.disposed || item.status !== 'review' || this.judgeRuns.has(item.id)) return;
    const followUps = item.judge?.followUps ?? 0;
    if (this.conflictReports.has(item.id)) {
      item.judge = { status: 'waiting', followUps };
      this.commit();
      return;
    }
    const runId = ++this.judgeSeq;
    const controller = new AbortController();
    this.judgeRuns.set(item.id, { runId, controller });
    item.judge = { status: 'running', followUps };
    this.commit();
    void this.runJudge(item, runId, controller.signal);
  }

  /** One judge turn. A reply that no longer applies, because the item moved on, is discarded unread. */
  private async runJudge(item: StoredWorkItem, runId: number, signal: AbortSignal): Promise<void> {
    let raw: string;
    try {
      raw = await this.ports.judge(buildJudgePrompt(this.judgeInput(item)), signal);
    } catch (error) {
      if (this.judgeRuns.get(item.id)?.runId === runId) {
        this.judgeRuns.delete(item.id);
        this.judgeError(item, describe(error));
      }
      return;
    }
    if (this.judgeRuns.get(item.id)?.runId !== runId) return;
    this.judgeRuns.delete(item.id);
    if (this.items.get(item.id) !== item || item.status !== 'review') return;
    const parsed = parseJudgeReply(raw);
    if (!parsed.ok) {
      this.judgeError(item, parsed.error);
      return;
    }
    this.applyJudgeReply(item, parsed.reply);
  }

  /** What the judge reads about one review item: its text, its result, and the overlaps it has now. */
  private judgeInput(item: StoredWorkItem): JudgeInput {
    const report = this.conflictReports.get(item.id);
    return {
      text: item.text,
      acceptance: item.acceptance,
      agent: item.agent,
      role: item.role,
      readOnly: this.isReadOnly(item.agent),
      // A result saved before colour codes were dropped still carries them; the judge reads plain text.
      result: item.result === undefined ? undefined : clip(withoutTerminalEscapes(item.result), JUDGE_RESULT_MAX_CHARS),
      conflicts: report === undefined ? [] : describeConflicts(report),
      evidenceAsked: item.judgeEvidenceAsked === true,
    };
  }

  /** Applies a valid judge reply: pass finishes the item, a follow-up sends the agent back, else the user decides. */
  private applyJudgeReply(item: StoredWorkItem, reply: JudgeReply): void {
    const followUps = item.judge?.followUps ?? 0;
    const action = decideJudgeAction(reply, {
      followUps,
      evidenceAsked: item.judgeEvidenceAsked === true,
    });
    if (action.kind === 'pass') {
      if (this.conflictReports.has(item.id)) {
        item.judge = { status: 'waiting', followUps };
        this.commit();
        return;
      }
      this.finishByJudge(item, reply.reason);
      return;
    }
    if (action.kind === 'follow_up') {
      item.judge = {
        status: 'verdict',
        verdict: reply.verdict,
        reason: reply.reason,
        followUps: followUps + 1,
      };
      item.judgeEvidenceAsked = action.evidenceAsked;
      this.requeue(
        item,
        this.promptFor(action.text, item.acceptance, item.agent, item.assignee),
        'followed_up',
        clip(`Giám khảo: ${reply.reason}`, WORK_ITEM_REASON_MAX_CHARS),
      );
      this.commit();
      this.scheduleReconcile();
      return;
    }
    item.judge = { status: 'verdict', verdict: reply.verdict, reason: reply.reason, followUps };
    this.setStatus(item, 'needs_input', clip(action.reason, WORK_ITEM_REASON_MAX_CHARS), action.reason);
    this.notifySettled(item);
  }

  /** The judge passed the item: it is done, as if the user had said so, and its dependents may start. */
  private finishByJudge(item: StoredWorkItem, reason: string): void {
    const at = this.iso();
    item.judge = { status: 'verdict', verdict: 'pass', reason, followUps: item.judge?.followUps ?? 0 };
    item.status = 'done';
    item.updatedAt = at;
    delete item.reason;
    this.pushEvent(item, makeEvent(at, 'status', passedMessage(reason)));
    this.commit();
    this.notifySettled(item);
    this.scheduleReconcile();
  }

  /** The judge failed or sent an unusable reply. The item stays in review and nothing is sent. */
  private judgeError(item: StoredWorkItem, message: string): void {
    const error = clip(message, JUDGE_ERROR_MAX_CHARS);
    item.judge = { status: 'error', followUps: item.judge?.followUps ?? 0, error };
    this.pushEvent(item, makeEvent(this.iso(), 'note', `Giám khảo lỗi: ${error}`));
    this.commit();
  }

  /** Stops a judge turn in flight. A settled item drops its judge state; an open one is marked interrupted. */
  private abortJudge(item: StoredWorkItem): void {
    this.judgeRuns.get(item.id)?.controller.abort();
    this.judgeRuns.delete(item.id);
    const judge = item.judge;
    if (judge === undefined || (judge.status !== 'running' && judge.status !== 'waiting')) return;
    if (isFinished(item.status)) delete item.judge;
    else item.judge = { ...judge, status: 'interrupted' };
  }

  /**
   * Reads the ledger's overlaps for the open editing items and records each item's conflicts. A new
   * or cleared conflict is noted on the item; a review item that gained one is reported to the squad.
   * A review item whose judge waited on a conflict is judged once that conflict clears. An unreadable
   * ledger keeps the last answer.
   */
  private async refreshConflicts(): Promise<void> {
    if (this.conflictRefreshing || this.disposed) return;
    const open = [...this.items.values()].filter(
      (item) =>
        (item.status === 'running' || item.status === 'needs_input' || item.status === 'review') &&
        !this.isReadOnly(item.agent),
    );
    let scans: readonly LedgerOverlapScan[];
    this.conflictRefreshing = true;
    try {
      if (open.length > 0) this.lastConflictAt = this.ports.now();
      scans = open.length === 0 ? [] : await this.ports.overlaps();
    } catch {
      return;
    } finally {
      this.conflictRefreshing = false;
    }
    const checkouts = open.map((item) => ({
      sequence: item.sequence,
      checkout: item.worktree?.path ?? item.repo ?? this.workspacePath,
    }));
    const found = conflictsFor(scans, checkouts);
    const at = this.iso();
    const changed: StoredWorkItem[] = [];
    for (const item of open) {
      const report = found.get(item.sequence);
      const before = this.conflictReports.get(item.id);
      const was = before === undefined ? [] : describeConflicts(before);
      const now = report === undefined ? [] : describeConflicts(report);
      if (was.join(', ') === now.join(', ')) continue;
      if (report === undefined) this.conflictReports.delete(item.id);
      else this.conflictReports.set(item.id, report);
      const note = now.length === 0 ? 'Hết xung đột.' : `Xung đột với ${now.join(', ')}.`;
      this.pushEvent(item, makeEvent(at, 'note', note));
      if (item.status === 'review') {
        item.updatedAt = at;
        // A conflict holds the judge. A judge already running checks the conflict when it replies.
        if (report !== undefined && this.settings.autoJudge && item.judge?.status !== 'running')
          item.judge = { status: 'waiting', followUps: item.judge?.followUps ?? 0 };
      }
      changed.push(item);
    }
    const openIds = new Set(open.map((item) => item.id));
    for (const id of [...this.conflictReports.keys()]) {
      if (!openIds.has(id)) this.conflictReports.delete(id);
    }
    if (changed.length > 0) this.commit();
    for (const item of changed) {
      if (item.status === 'review') this.notifySettled(item);
    }
    for (const item of open) {
      if (
        item.status === 'review' &&
        item.judge?.status === 'waiting' &&
        !this.conflictReports.has(item.id)
      )
        this.startJudge(item);
    }
  }

  /**
   * Parks each squad session that has sat idle for SQUAD_PARK_IDLE_MS with no queued, running or
   * waiting item on it. The pool may still refuse; the session is tried again on a later tick.
   */
  private async parkIdleSquadSessions(): Promise<void> {
    const sessions = this.ports.sessions.list();
    const now = this.ports.now();
    for (const id of this.squadSessionIds) {
      const session = sessions.find((entry) => entry.id === id);
      const busy = [...this.items.values()].some(
        (item) =>
          item.assignee.kind === 'session' &&
          item.assignee.sessionId === id &&
          (item.status === 'queued' || item.status === 'running' || item.status === 'needs_input'),
      );
      if (session?.status !== 'idle' || busy) {
        this.idleSince.delete(id);
        continue;
      }
      const since = this.idleSince.get(id) ?? now;
      this.idleSince.set(id, since);
      if (now - since < SQUAD_PARK_IDLE_MS) continue;
      if (!(await this.ports.sessions.park(id))) continue;
      this.idleSince.delete(id);
      this.ports.publish(this.snapshot());
    }
  }

  /** Starts the maintenance tick once. Each tick parks idle squad sessions and re-checks conflicts. */
  private ensureMaintenance(): void {
    if (this.maintenanceScheduled || this.disposed) return;
    this.maintenanceScheduled = true;
    const cancel = this.ports.schedule(() => {
      this.cancelTimers.delete(cancel);
      this.maintenanceScheduled = false;
      this.ensureMaintenance();
      void this.maintain();
    }, MAINTENANCE_MS);
    this.cancelTimers.add(cancel);
  }

  private async maintain(): Promise<void> {
    if (this.disposed) return;
    try {
      await this.parkIdleSquadSessions();
      const due = this.ports.now() - this.lastConflictAt >= CONFLICT_RECHECK_MS;
      if (due && this.ports.boardWatching()) await this.refreshConflicts();
    } catch {
      // A failed tick changes nothing it did not commit; the next tick tries again.
    }
  }
}

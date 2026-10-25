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

import { parse as parsePath } from 'node:path';

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
  WorkItemCloud,
  WorkItemCloudIssue,
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
import { GIB, isSquadSettings, parseSquadSettings, SQUAD_SETTINGS_DEFAULT } from './squadSettings.js';
import type { CommandRunner, SquadWorktree, WorktreeRemoval } from './squadWorktree.js';
import {
  cloudTodoPending,
  countUncommittedFiles,
  missingCloudBranch,
  parseFastHandoffResult,
  parseOpenCloudIssues,
  parseOrchestratorComments,
  updateCloudHandoff,
} from './workItemCloud.js';
import { type DeliveryFacts, sameDelivery, toDelivery } from './workItemDelivery.js';
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
  WORK_ITEM_HERDR_START_MS,
  WORK_ITEM_HISTORY_MAX,
  WORK_ITEM_HOLD_RETRY_MS,
  WORK_ITEM_REASON,
  WORK_ITEM_REASON_MAX_CHARS,
  WORK_ITEM_RESULT_LINES,
  WORK_ITEM_RESULT_MAX_CHARS,
  WORK_ITEM_STALE_REPLY_MS,
  type WorkItemDraft,
  type WorkItemsFile,
} from './workItemModel.js';
import {
  checkoutKey,
  checkoutName,
  decideStart,
  isInsideRepo,
  type SchedulerContext,
  type SchedulerDecision,
  type SchedulerHold,
  type SchedulerItem,
  type SchedulerMember,
  squadWorkstreamKey,
} from './workItemScheduler.js';

/** How many recent request ids are remembered, so a resent command answers the same way. */
const REQUEST_MEMORY_MAX = 256;
/** How often each item's branch is checked against origin/main and origin/staging. */
const DELIVERY_CHECK_MS = 2 * 60_000;
/** The least time between two `git fetch origin` of one repo. */
const DELIVERY_FETCH_MS = 5 * 60_000;
/** The first check after the board starts: soon, but not while the start itself is busy. */
const DELIVERY_FIRST_CHECK_MS = 15_000;
/** Cloud handoff and Git operations stay bounded so a dead CLI cannot stall the board. */
const CLOUD_GIT_TIMEOUT_MS = 120_000;
const CLOUD_GH_TIMEOUT_MS = 30_000;
const FAST_HANDOFF_TIMEOUT_MS = 5 * 60_000;
const CLOUD_ISSUE_CHECK_MS = 5 * 60_000;
const CLOUD_REPOSITORY = 'babydanh/agent-orchestrator';

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
  /** The herdr workspace holding the pane, such as `wA`. */
  readonly workspaceId?: string;
  /** The agent herdr sees in the pane: omp, claude, agy… Absent when herdr does not say. */
  readonly kind?: string;
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
  /**
   * The last reply of the agent in the pane, from its transcript: the whole final report, where the
   * screen holds only its last lines. Undefined when the transcript is unknown. Absent = no reader.
   */
  lastReply?(paneId: string): Promise<string | undefined>;
  /** Hibernated sessions herdr keeps, each in its pane. Absent = none. */
  sleeping?(): readonly { readonly paneId: string; readonly cwd?: string }[];
  /**
   * Opens an interactive agent (omp, Claude Code, agy) in a new herdr tab in `cwd` and resolves with
   * its pane, once the roster lists it. Absent = herdr cannot open one, and the board runs it instead.
   */
  startAgent?(input: { readonly cwd: string; readonly kind: 'omp' | 'claude' | 'agy'; readonly name: string; readonly args: readonly string[] }): Promise<string>;
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
  /** The session's last reply from its transcript, the whole final report. Undefined when unknown. */
  lastReply?(sessionId: string): Promise<string | undefined>;
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

/** Git, GitHub, handoff-file, and PowerShell operations used by cloud handoff. */
export interface WorkItemCloudPort {
  readonly run: CommandRunner;
  readonly fastHandoffScript: string;
  readHandoff(worktreePath: string): Promise<string | undefined>;
  writeHandoff(worktreePath: string, content: string): Promise<void>;
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
  /** Free disk space in bytes on the filesystem containing the repo path. */
  freeDiskBytes(repoPath: string): Promise<number>;
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
  /** Whether the approved proposal belongs to a compact squad run. */
  readonly isCompactSquadProposal?: (proposalId: string) => boolean;
  setLiveRunnerLimits?(live: number, retained: number): void;
  /** Injectable git/GitHub/PowerShell and handoff-file operations. */
  readonly cloud?: WorkItemCloudPort;
  /** Reads where an item's branch stands. Absent in tests that do not exercise it. */
  readonly delivery?: {
    /** Fetches origin for the repo; false when git failed. */
    fetch(repo: string): Promise<boolean>;
    /** Undefined when the branch is gone; null when git could not answer (the last delivery stays). */
    probe(repo: string, worktree: SquadWorktree, worktreePresent: boolean): Promise<DeliveryFacts | undefined | null>;
  };
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

/** The folder's herdr and session views, read together for a scheduling decision or snapshot. */
interface FolderView {
  readonly roster: WorkItemRosterView;
  readonly sessions: readonly WorkItemSessionView[];
}

const DISK_GB_FORMAT = new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 1 });

function diskDriveLabel(repo: string): string {
  const root = parsePath(repo).root;
  return root.replace(/[\\/]+$/, '') || root || repo;
}

function needsNewWorktree(item: StoredWorkItem, decision: StartDecision): boolean {
  if (item.worktree !== undefined || item.inPlace === true) return false;
  if (decision.kind === 'open') return decision.isolate;
  if (decision.kind === 'claude' || decision.kind === 'agy') return !decision.readOnly;
  return false;
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
  /** Items whose prompt is still being sent: a woken agent may take a while to take it. */
  private readonly sending = new Set<string>();
  /**
   * A herdr agent's last reply when its item was sent. herdr may report the pane idle before the
   * agent starts; while the reply is still this one, the agent has not answered the item yet.
   */
  private readonly replyAtSend = new Map<string, string>();
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
  /** Cancels the next delivery check; null when none is scheduled. */
  private deliveryTimer: (() => void) | null = null;
  /** When each repo was last fetched successfully (ms, for the throttle; ISO, for `checkedAt`). */
  private readonly lastFetch = new Map<string, number>();
  private readonly fetchedAt = new Map<string, string>();
  private readonly changeListeners = new Set<() => void>();
  private readonly settledListeners = new Set<(item: WorkItem) => void>();
  /** Items held with the reason their attempted start is waiting: pool, worktree, or disk space. */
  private readonly held = new Map<string, WorkItemBlocker>();
  /** Starts selected items once; queued items in this map reserve their scheduler slots. */
  private readonly inFlightStarts = new Map<string, StartDecision>();
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

  private cloudIssues: WorkItemCloudIssue[] = [];
  private cloudIssueFetchedAt = Number.NEGATIVE_INFINITY;
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
    this.applyRuntimeLimits();
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
    this.scheduleDeliveryCheck(DELIVERY_FIRST_CHECK_MS);
  }

  /** Checks every item's branch again after `ms`, then keeps checking every few minutes. */
  private scheduleDeliveryCheck(ms: number): void {
    if ((this.ports.delivery === undefined && this.ports.cloud === undefined) || this.disposed) return;
    this.deliveryTimer?.();
    this.deliveryTimer = this.ports.schedule(() => {
      this.deliveryTimer = null;
      void this.refreshDeliveries()
        .catch(() => undefined)
        .finally(() => this.scheduleDeliveryCheck(DELIVERY_CHECK_MS));
    }, ms);
  }

  /**
   * Reads where each item's branch stands (uncommitted in its worktree, on its branch, on
   * origin/staging, in origin/main) and publishes what changed. Origin is fetched at most every few
   * minutes per repo; `checkedAt` is the last successful fetch, so a failing fetch shows as an
   * aging time rather than a fresh verdict. A repo never fetched in this run keeps its last delivery.
   * A branch that no longer exists drops its delivery.
   */
  async refreshDeliveries(): Promise<void> {
    const port = this.ports.delivery;
    if (port !== undefined) {
      const items = [...this.items.values()].filter((item) => item.worktree !== undefined);
      for (const repo of new Set(items.map((item) => item.repo ?? this.workspacePath))) {
        if (this.ports.now() - (this.lastFetch.get(repo) ?? 0) < DELIVERY_FETCH_MS) continue;
        if (await port.fetch(repo)) {
          this.lastFetch.set(repo, this.ports.now());
          this.fetchedAt.set(repo, this.iso());
        }
      }
      let changed = false;
      for (const item of items) {
        if (this.disposed) return;
        const worktree = item.worktree;
        const repo = item.repo ?? this.workspacePath;
        const fetchedAt = this.fetchedAt.get(repo);
        if (worktree === undefined || fetchedAt === undefined) continue;
        const present = item.worktreeRemoved !== true && this.ports.worktrees.exists(worktree);
        const facts = await port.probe(repo, worktree, present);
        if (this.items.get(item.id) !== item || facts === null) continue;
        const next = facts === undefined ? undefined : toDelivery(facts, fetchedAt);
        if (sameDelivery(item.delivery, next)) continue;
        if (next === undefined) delete item.delivery;
        else item.delivery = next;
        changed = true;
      }
      if (changed) this.commit();
    }
    await this.refreshCloud();
  }

  private async refreshCloud(): Promise<void> {
    const port = this.ports.cloud;
    if (port === undefined || this.disposed) return;
    const completed: StoredWorkItem[] = [];
    let changed = false;
    for (const item of this.items.values()) {
      if (item.cloud?.state !== 'running') continue;
      const status = await this.cloudIssueStatus(item.cloud.issue);
      if (status === undefined || status.state === 'running' || this.items.get(item.id) !== item) continue;
      item.cloud = {
        ...item.cloud,
        state: status.state,
        ...(status.summary === undefined ? {} : { summary: status.summary }),
        ...(status.logUrl === undefined ? {} : { logUrl: status.logUrl }),
      };
      if (status.state === 'finished') {
        this.pushEvent(item, makeEvent(this.iso(), 'status', `Cloud hoàn tất Issue #${item.cloud.issue}.`));
        completed.push(item);
      } else {
        this.pushEvent(item, makeEvent(this.iso(), 'status', `Issue cloud #${item.cloud.issue} đã đóng.`));
      }
      changed = true;
    }
    if (changed) {
      this.commit();
      await this.flush();
    }
    for (const item of completed) await this.pullCloudItem(item, false);
    if (this.ports.now() - this.cloudIssueFetchedAt < CLOUD_ISSUE_CHECK_MS) return;
    const issues = await this.fetchOpenCloudIssues();
    if (issues === undefined) return;
    this.cloudIssueFetchedAt = this.ports.now();
    if (JSON.stringify(issues) === JSON.stringify(this.cloudIssues)) return;
    this.cloudIssues = issues;
    this.commit();
  }

  private async cloudIssueStatus(issue: number): Promise<{
    state: 'running' | 'finished' | 'closed';
    summary?: string;
    logUrl?: string;
  } | undefined> {
    const comment = await this.readOrchestratorComments(issue);
    if (comment === undefined) return undefined;
    if (comment !== null) return { state: 'finished', ...comment };
    const result = await this.runCloud('gh', ['api', `repos/${CLOUD_REPOSITORY}/issues/${issue}`], this.workspacePath, CLOUD_GH_TIMEOUT_MS);
    if (result.code !== 0) return undefined;
    try {
      const record = JSON.parse(result.stdout) as { state?: unknown };
      if (record.state === 'closed') return { state: 'closed' };
      return record.state === 'open' ? { state: 'running' } : undefined;
    } catch {
      return undefined;
    }
  }

  private async readOrchestratorComments(issue: number): Promise<{
    summary: string;
    logUrl?: string;
  } | null | undefined> {
    const result = await this.runCloud(
      'gh',
      ['api', '--paginate', '--slurp', `repos/${CLOUD_REPOSITORY}/issues/${issue}/comments`],
      this.workspacePath,
      CLOUD_GH_TIMEOUT_MS,
    );
    return result.code === 0 ? parseOrchestratorComments(result.stdout) : undefined;
  }

  private async fetchOpenCloudIssues(): Promise<WorkItemCloudIssue[] | undefined> {
    const result = await this.runCloud('gh', [
      'issue', 'list', '-R', CLOUD_REPOSITORY, '--state', 'open', '--search', '[Handoff] in:title',
      '--json', 'number,title,url,createdAt,body',
    ], this.workspacePath, CLOUD_GH_TIMEOUT_MS);
    if (result.code !== 0) return undefined;
    const linked = new Set([...this.items.values()].flatMap((item) => item.cloud === undefined ? [] : [item.cloud.issue]));
    const issues = parseOpenCloudIssues(result.stdout, linked);
    if (issues === undefined) return undefined;
    for (const issue of issues) {
      const comment = await this.readOrchestratorComments(issue.issue);
      if (comment !== null && comment !== undefined) issue.state = 'finished';
    }
    return issues;
  }

  private async runCloud(file: string, args: readonly string[], cwd: string, timeoutMs: number) {
    const port = this.ports.cloud;
    if (port === undefined) throw new CompanyError('cloud_unavailable', 'Tính năng cloud chưa được cấu hình.');
    return port.run(file, args, cwd, timeoutMs);
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
      cloudIssues: this.cloudIssues.map((issue) => ({ ...issue })),
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

  /** Creates and commits only HANDOFF.md before asking fast-handoff to create its Issue. */
  async pushToCloud(command: WorkItemCommand & { id: string }): Promise<void> {
    if (this.replay(command.requestId) !== undefined) return;
    const item = this.requireItem(command.id);
    const port = this.ports.cloud;
    if (port === undefined) throw new CompanyError('cloud_unavailable', 'Tính năng cloud chưa được cấu hình.');
    if (item.cloud !== undefined) throw new CompanyError('cloud_already_linked', 'Việc này đã có Issue cloud.');
    if (item.status === 'queued' || item.status === 'running')
      throw new CompanyError('work_item_busy', 'Chỉ có thể đẩy việc chưa chạy hoặc đã dừng lên cloud.');
    const worktree = item.worktree;
    if (worktree === undefined || item.worktreeRemoved === true || !this.ports.worktrees.exists(worktree))
      throw new CompanyError('cloud_worktree_missing', 'Không còn worktree của việc để bàn giao.');
    const status = await this.runCloud('git', ['status', '--porcelain', '--untracked-files=all'], worktree.path, CLOUD_GIT_TIMEOUT_MS);
    if (status.code !== 0) throw new CompanyError('cloud_status_failed', status.stderr || status.stdout || 'Không đọc được trạng thái worktree.');
    const dirty = countUncommittedFiles(status.stdout);
    if (dirty > 0) throw new CompanyError('cloud_worktree_dirty', `Worktree còn ${dirty} file chưa commit: commit hẹp đúng file của việc trước rồi mới đẩy lên cloud.`);
    const at = this.iso();
    const handoff = updateCloudHandoff(await port.readHandoff(worktree.path), this.wire(item, this.view()), at);
    await port.writeHandoff(worktree.path, handoff);
    const add = await this.runCloud('git', ['add', '--', 'HANDOFF.md'], worktree.path, CLOUD_GIT_TIMEOUT_MS);
    if (add.code !== 0) throw new CompanyError('cloud_handoff_commit_failed', add.stderr || add.stdout || 'Không thêm được HANDOFF.md.');
    const message = `docs(handoff): bàn giao #${item.sequence} lên cloud`;
    const commit = await this.runCloud('git', ['commit', '--only', '-m', message, '--', 'HANDOFF.md'], worktree.path, CLOUD_GIT_TIMEOUT_MS);
    if (commit.code !== 0) throw new CompanyError('cloud_handoff_commit_failed', commit.stderr || commit.stdout || 'Không commit được HANDOFF.md.');
    const clean = await this.runCloud('git', ['status', '--porcelain', '--untracked-files=all'], worktree.path, CLOUD_GIT_TIMEOUT_MS);
    if (clean.code !== 0) throw new CompanyError('cloud_status_failed', clean.stderr || clean.stdout || 'Không xác nhận được worktree sạch.');
    const remaining = countUncommittedFiles(clean.stdout);
    if (remaining > 0) throw new CompanyError('cloud_worktree_dirty', `Worktree còn ${remaining} file chưa commit: commit hẹp đúng file của việc trước rồi mới đẩy lên cloud.`);
    const title = `#${item.sequence} ${item.text.replace(/\s+/g, ' ').trim().slice(0, 80)}`;
    const result = await this.runCloud('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', port.fastHandoffScript,
      '-TaskTitle', title, '-TodoPending', cloudTodoPending(this.wire(item, this.view())),
    ], worktree.path, FAST_HANDOFF_TIMEOUT_MS);
    let issue: { issue: number; url: string };
    try {
      issue = parseFastHandoffResult(result);
    } catch (error) {
      throw new CompanyError('cloud_handoff_failed', error instanceof Error ? error.message : String(error));
    }
    item.cloud = {
      issue: issue.issue,
      url: issue.url,
      branch: worktree.branch,
      repo: item.repo ?? this.workspacePath,
      state: 'running',
      startedAt: at,
    };
    this.pushEvent(item, makeEvent(at, 'status', `Đã đẩy lên cloud: Issue #${issue.issue}.`));
    this.remember(command.requestId, '');
    this.commit();
    await this.flush();
  }

  /** Fetches a finished cloud branch, then performs only a safe fast-forward into the worktree. */
  async pullCloud(command: WorkItemCommand & { id: string }): Promise<void> {
    if (this.replay(command.requestId) !== undefined) return;
    const item = this.requireItem(command.id);
    if (!['finished', 'waiting_clean', 'diverged'].includes(item.cloud?.state ?? ''))
      throw new CompanyError('cloud_pull_unavailable', 'Chỉ có thể kéo kết quả cloud đã hoàn tất.');
    await this.pullCloudItem(item, true);
    this.remember(command.requestId, '');
  }

  /**
   * Closes an open handoff Issue no item holds, so it leaves the "Trên cloud" lane. Only the Issue
   * is closed: its `omp/issue-N` branch stays on origin, so a finished run can still be fetched.
   */
  async closeCloudIssue(command: WorkItemCommand & { issue: number }): Promise<void> {
    if (this.replay(command.requestId) !== undefined) return;
    if (!this.cloudIssues.some((issue) => issue.issue === command.issue))
      throw new CompanyError('cloud_issue_unknown', `Issue #${command.issue} không nằm trong cột Trên cloud.`);
    const result = await this.runCloud('gh', [
      'issue', 'close', String(command.issue), '-R', CLOUD_REPOSITORY,
      '--comment', `Đóng từ Agent Board. Nhánh omp/issue-${command.issue} vẫn giữ.`,
    ], this.workspacePath, CLOUD_GH_TIMEOUT_MS);
    if (result.code !== 0)
      throw new CompanyError('cloud_issue_close_failed', `Không đóng được Issue #${command.issue}: ${(result.stderr || result.stdout).trim().slice(0, 200)}`);
    this.cloudIssues = this.cloudIssues.filter((issue) => issue.issue !== command.issue);
    this.remember(command.requestId, '');
    this.commit();
  }

  /**
   * Removes an item nobody works on: a queued one never sent, or a finished one (done, failed).
   * Its worktree goes with it when nothing in it is lost (clean, branch merged, no session in it);
   * otherwise the delete is refused with what is in the way, so the worktree is never orphaned
   * silently. `keepWorktree` drops only the card and leaves the worktree and branch untouched.
   */
  async cancel(command: WorkItemCommand & { id: string; keepWorktree?: boolean }): Promise<void> {
    if (this.replay(command.requestId) !== undefined) return;
    const item = this.requireItem(command.id);
    if (!canCancel(item.status)) this.refuseStatus(item);
    const waiters = this.openWaitersOf(item.id);
    if (waiters.length > 0)
      throw new CompanyError(
        'work_item_awaited',
        awaitedMessage(waiters.map((waiter) => waiter.sequence)),
      );
    const removable = item.worktree !== undefined && item.worktreeRemoved !== true && this.ports.worktrees.exists(item.worktree);
    if (removable && command.keepWorktree !== true && item.worktree !== undefined)
      await this.removeWorktreeOf(item, item.worktree);
    // The item may have been removed by another command while its worktree was removed.
    if (this.items.get(item.id) !== item) return;
    this.held.delete(item.id);
    this.items.delete(item.id);
    this.remember(command.requestId, '');
    this.commit();
    await this.flush();
  }

  /** Removes the worktree of an item being deleted; refuses, naming the cause, when that would lose work. */
  private async removeWorktreeOf(item: StoredWorkItem, worktree: SquadWorktree): Promise<void> {
    const path = worktree.path;
    const pane = [...this.ports.roster.panes().panes, ...(this.ports.roster.sleeping?.() ?? [])]
      .find((entry) => isInsideRepo(entry.cwd, path));
    if (pane !== undefined)
      throw new CompanyError('work_item_status', `Phiên herdr ${pane.paneId} còn mở (kể cả đang ngủ) trong worktree của việc này (${path}). Đóng phiên đó rồi bấm Xoá lại.`);
    await this.parkIdleSquadSessionsIn(path);
    const key = checkoutKey(path);
    const live = this.ports.sessions.list().some(
      (session) => session.cwd !== undefined && checkoutKey(session.cwd) === key &&
        session.status !== 'parked' && observeSessionStatus(session.status) !== 'gone',
    );
    if (live) throw new CompanyError('work_item_status', MESSAGE.worktreeInUse);
    const outcome = await this.ports.worktrees.remove(item.repo ?? this.workspacePath, worktree);
    if (outcome === 'dirty') throw new CompanyError('work_item_status', `${MESSAGE.worktreeDirty} Gộp hoặc xoá tay ${path} rồi xoá việc.`);
    if (outcome === 'unmerged') throw new CompanyError('work_item_status', `${MESSAGE.worktreeUnmerged} Gộp hoặc xoá tay ${path} rồi xoá việc.`);
  }

  /**
   * Parks the idle squad sessions working in a checkout, so a done item's worktree can go without
   * waiting for the idle sweep. A busy or waiting session, or one the user opened, stays as it is.
   */
  private async parkIdleSquadSessionsIn(path: string): Promise<void> {
    const key = checkoutKey(path);
    for (const session of this.ports.sessions.list()) {
      if (session.status !== 'idle' || session.cwd === undefined || checkoutKey(session.cwd) !== key) continue;
      if (!this.squadSessionIds.includes(session.id)) continue;
      await this.ports.sessions.park(session.id);
    }
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

  /**
   * "Chấm lại": judges again now, on the agent's result read afresh (a herdr pane's transcript may
   * hold a fuller report than the one saved). Takes a review item, or one the judge sent back to the
   * user. A conflict holds the judge until it clears.
   */
  async judgeAgain(command: WorkItemCommand & { id: string }): Promise<void> {
    if (this.replay(command.requestId) !== undefined) return;
    const item = this.requireItem(command.id);
    const sentBack = item.status === 'needs_input' && item.judge?.status === 'verdict';
    if (item.status !== 'review' && !sentBack) throw new CompanyError('work_item_status', MESSAGE.status);
    this.remember(command.requestId, '');
    // Only a sent-back item still holds its pane, so the pane's last reply is still this item's.
    // A review item's pane may already run other work: its saved result stays.
    const paneId = sentBack && item.assignee.kind === 'herdr' ? item.assignee.paneId : undefined;
    const fresh = paneId === undefined ? undefined : await this.readResult(paneId);
    // The user may have marked or removed the item while its reply was read.
    if (this.items.get(item.id) !== item || (item.status !== 'review' && item.status !== 'needs_input')) return;
    if (fresh !== undefined) item.result = fresh;
    if (item.status === 'needs_input') {
      const at = this.iso();
      item.status = 'review';
      item.reason = WORK_ITEM_REASON.review;
      item.updatedAt = at;
      this.pushEvent(item, makeEvent(at, 'status', 'Bạn cho chấm lại.'));
      this.commit();
    }
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
    await this.parkIdleSquadSessionsIn(worktree.path);
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
    this.settings = parseSquadSettings(command.settings);
    this.remember(command.requestId, '');
    this.commit();
    await this.flush();
    this.applyRuntimeLimits();
    await this.reconcileAfterSave();
  }
  private applyRuntimeLimits(): void {
    const live = Math.max(4, this.settings.maxSquadSessions + 4);
    this.ports.setLiveRunnerLimits?.(live, Math.max(10, live + 6));
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
    this.deliveryTimer?.();
    this.deliveryTimer = null;
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

  private async pullCloudItem(item: StoredWorkItem, manual: boolean): Promise<void> {
    const cloud = item.cloud;
    if (cloud === undefined) throw new CompanyError('cloud_pull_unavailable', 'Việc này chưa có Issue cloud.');
    const worktree = item.worktree;
    if (worktree === undefined || item.worktreeRemoved === true || !this.ports.worktrees.exists(worktree)) {
      if (manual) throw new CompanyError('cloud_worktree_missing', 'Không còn worktree của việc để kéo kết quả.');
      return;
    }
    const branch = `omp/issue-${cloud.issue}`;
    const fetch = await this.runCloud('git', ['fetch', 'origin', branch], worktree.path, CLOUD_GIT_TIMEOUT_MS);
    const fetchOutput = `${fetch.stderr}\n${fetch.stdout}`;
    if (fetch.code !== 0) {
      if (missingCloudBranch(fetchOutput)) {
        await this.updateCloudState(item, { ...cloud, state: 'no_changes', reason: `Không có nhánh cloud mới để kéo (${branch}).` });
        return;
      }
      if (manual) throw new CompanyError('cloud_fetch_failed', fetch.stderr || fetch.stdout || 'Không fetch được nhánh cloud.');
      return;
    }
    const status = await this.runCloud('git', ['status', '--porcelain', '--untracked-files=all'], worktree.path, CLOUD_GIT_TIMEOUT_MS);
    if (status.code !== 0) {
      if (manual) throw new CompanyError('cloud_status_failed', status.stderr || status.stdout || 'Không đọc được trạng thái worktree.');
      return;
    }
    const dirty = countUncommittedFiles(status.stdout, true);
    if (dirty > 0) {
      await this.updateCloudState(item, {
        ...cloud,
        state: 'waiting_clean',
        reason: 'Worktree còn file chưa commit: commit hoặc dọn rồi bấm Kéo về',
      });
      return;
    }
    const merge = await this.runCloud('git', ['-C', worktree.path, 'merge', '--ff-only', 'FETCH_HEAD'], worktree.path, CLOUD_GIT_TIMEOUT_MS);
    if (merge.code !== 0) {
      const output = `${merge.stderr}\n${merge.stdout}`;
      if (/not possible to fast-forward|not a fast-forward|non-fast-forward/i.test(output)) {
        await this.updateCloudState(item, {
          ...cloud,
          state: 'diverged',
          reason: `Nhánh cloud và nhánh máy đã rẽ nhánh: gộp tay git -C ${worktree.path} merge origin/${branch}`,
        });
        return;
      }
      if (manual) throw new CompanyError('cloud_merge_failed', merge.stderr || merge.stdout || 'Không merge được nhánh cloud.');
      return;
    }
    const pulled = { ...cloud, state: 'pulled' as const };
    delete pulled.reason;
    await this.updateCloudState(item, pulled);
    this.lastFetch.delete(cloud.repo);
    this.fetchedAt.delete(cloud.repo);
    if (this.ports.delivery !== undefined) await this.refreshDeliveries();
  }

  private async updateCloudState(item: StoredWorkItem, cloud: WorkItemCloud): Promise<void> {
    if (this.items.get(item.id) !== item) return;
    if (cloud.reason === undefined) delete cloud.reason;
    item.cloud = cloud;
    this.pushEvent(item, makeEvent(this.iso(), 'status', this.cloudStateEvent(cloud)));
    this.commit();
    await this.flush();
  }

  private cloudStateEvent(cloud: WorkItemCloud): string {
    switch (cloud.state) {
      case 'no_changes': return `Không có thay đổi cloud mới cho Issue #${cloud.issue}.`;
      case 'waiting_clean': return 'Worktree còn thay đổi; chưa kéo kết quả cloud.';
      case 'diverged': return 'Nhánh cloud và nhánh máy đã rẽ nhánh; chưa kéo kết quả.';
      case 'pulled': return `Đã kéo kết quả cloud về (omp/issue-${cloud.issue}).`;
      default: return cloud.reason ?? `Trạng thái cloud: ${cloud.state}.`;
    }
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
   * The subagent line follows the agent that will read it: a Claude Code run, or the agent in the
   * herdr pane (Claude in a pane has no omp task tool either). An unknown pane is taken as omp.
   */
  private promptFor(
    text: string,
    acceptance: string | undefined,
    agent: string | undefined,
    assignee: WorkItemAssignee,
  ): string {
    const engine = this.engineOf(assignee);
    return composeDispatchPrompt({
      text,
      acceptance,
      agent,
      readOnly: this.isReadOnly(agent),
      engine,
    });
  }

  private engineOf(assignee: WorkItemAssignee): PromptEngine {
    if (assignee.kind === 'claude') return 'claude';
    if (assignee.kind !== 'herdr') return 'omp';
    const kind = this.ports.roster.panes().panes.find((pane) => pane.paneId === assignee.paneId)?.kind;
    if (kind === undefined || kind === 'omp' || kind === 'unknown') return 'omp';
    return kind === 'claude' ? 'claude' : 'other';
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
    await this.startQueued();
  }

  /** Makes sequential scheduling decisions, then waits for all selected worktree starts together. */
  private async startQueued(): Promise<void> {
    const parallelStarts: Promise<void>[] = [];
    for (const candidate of this.queueOrder()) {
      // Earlier starts may save, fail or cancel items, so each candidate gets a fresh context.
      if (
        this.items.get(candidate.id) !== candidate ||
        candidate.status !== 'queued' ||
        this.inFlightStarts.has(candidate.id)
      ) continue;
      if (!this.isReady(candidate)) continue;
      const decision = decideStart(this.schedulerItem(candidate), this.schedulerContext(this.view()));
      if (decision.kind === 'wait') {
        if (this.held.delete(candidate.id)) this.ports.publish(this.snapshot());
        continue;
      }
      const createsWorktree = needsNewWorktree(candidate, decision);
      this.held.delete(candidate.id);
      this.inFlightStarts.set(candidate.id, decision);
      const starting = (async (): Promise<void> => {
        if (createsWorktree) {
          const blocker = await this.worktreeDiskBlocker(candidate.repo ?? this.workspacePath);
          if (blocker !== undefined) {
            if (this.items.get(candidate.id) === candidate && candidate.status === 'queued') {
              this.hold(candidate, blocker);
            }
            return;
          }
        }
        await this.start(candidate, decision);
      })().finally(() => this.inFlightStarts.delete(candidate.id));
      if (createsWorktree) parallelStarts.push(starting);
      else await starting;
    }
    await Promise.all(parallelStarts);
  }

  private async worktreeDiskBlocker(repo: string): Promise<WorkItemBlocker | undefined> {
    const drive = diskDriveLabel(repo);
    let freeBytes: number;
    try {
      freeBytes = await this.ports.freeDiskBytes(repo);
    } catch (error) {
      return {
        kind: 'disk_full',
        area: drive,
        detail: clip(
          `Không đọc được dung lượng trống của ổ ${drive}: ${describe(error)}. Chờ kiểm tra lại trước khi tạo worktree.`,
          WORK_ITEM_BLOCKER_DETAIL_MAX_CHARS,
        ),
      };
    }
    const requiredGb = this.settings.minFreeDiskGb ?? 10;
    if (freeBytes >= requiredGb * GIB) return undefined;
    return {
      kind: 'disk_full',
      area: drive,
      detail: `Ổ ${drive} còn ${DISK_GB_FORMAT.format(freeBytes / GIB)} GB, cần ${DISK_GB_FORMAT.format(requiredGb)} GB để tạo worktree.`,
    };
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
      if (auto) item.pendingPrompt = this.promptFor(item.text, item.acceptance, item.agent, { kind: decision.kind });
      // With herdr linked the CLI runs as an interactive agent in its own tab: the user watches it
      // there, and the item follows that pane like any herdr agent. Without herdr it runs headless.
      const paneId = await this.openAgentPane(item, decision.kind, cwd, decision.readOnly);
      if (paneId === null) return;
      if (paneId !== undefined) {
        item.assignee = { kind: 'herdr', paneId };
        const cli = decision.kind === 'agy' ? 'Antigravity (agy)' : 'Claude Code';
        this.pushEvent(item, makeEvent(this.iso(), 'assigned', `Mở ${cli} trong tab herdr ${paneId}.`));
      } else if (auto) {
        item.assignee = { kind: decision.kind };
        const cli = decision.kind === 'agy' ? 'Antigravity (agy)' : 'Claude Code (claude -p)';
        this.pushEvent(item, makeEvent(this.iso(), 'assigned', `Tự chọn: ${cli}.`));
      }
    } else if (decision.kind === 'open') {
      // Every omp item runs like the user's own sessions: an omp agent in its own herdr tab, which the
      // user watches there and which outlives a board restart. Without herdr, compact squad items and
      // items the user filed use board chat sessions: the item is the whole brief, so no contract
      // stands behind the session (a role session refuses any prompt without one). Editing items open
      // in their own worktree; read-only items stay in the repo.
      const compactItem = item.assignee.kind === 'new-session' &&
        item.squadRunId !== undefined &&
        this.ports.isCompactSquadProposal?.(item.squadRunId) === true;
      const chatItem = compactItem || item.squadRunId === undefined;
      const cwd = decision.isolate ? await this.isolatedCheckout(item, decision.cwd) : decision.cwd;
      if (cwd === undefined) return;
      const paneId = await this.openAgentPane(item, 'omp', cwd, false);
      if (paneId === null) return;
      if (paneId !== undefined) {
        item.assignee = { kind: 'herdr', paneId };
        this.pushEvent(item, makeEvent(this.iso(), 'assigned', `Mở omp trong tab herdr ${paneId} (${checkoutName(cwd)}).`));
      } else {
        let sessionId: string;
        try {
          sessionId = await this.ports.sessions.openChat({
            cwd,
            role: chatItem ? 'chat' : decision.role,
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
        const message = compactItem
          ? `Phiên omp vai ${decision.role} trong ${checkoutName(cwd)} (dùng lại phiên rảnh hoặc đang đậu nếu có).`
          : auto
            ? `Tự chọn: mở phiên omp mới trong ${checkoutName(decision.cwd)}.`
            : 'Mở phiên omp mới cho việc này.';
        this.pushEvent(item, makeEvent(this.iso(), 'assigned', message));
      }
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
    const held = this.held.get(item.id);
    if (this.inFlightStarts.has(item.id)) {
      return held === undefined ? wire : { ...wire, blocker: held, reason: blockerReason(held) };
    }
    const decision = decideStart(this.schedulerItem(item), this.schedulerContext(view));
    if (decision.kind === 'wait') return { ...wire, blocker: decision.blocker, reason: decision.reason };
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
        repo: item.repo ?? this.workspacePath,
        checkout: item.inPlace === true ? item.repo : checkouts.get(memberKey),
      });
    }
    for (const [id] of this.inFlightStarts) {
      const item = this.items.get(id);
      if (item === undefined || item.status !== 'queued') continue;
      holds.push({
        memberKey: `preparing:${id}`,
        sequence: item.sequence,
        readOnly: this.isReadOnly(item.agent),
        areas: item.areas ?? [],
        repo: item.repo ?? this.workspacePath,
        checkout: item.inPlace === true ? item.repo : undefined,
      });
    }
    const squadSessionsOpen = this.squadSessionIds.filter((id) =>
      view.sessions.some((session) => id === session.id && observeSessionStatus(session.status) !== 'gone') ||
      view.roster.panes.some((pane) => pane.paneId === id),
    ).length;
    const preparingSessions = [...this.inFlightStarts].filter(([id, decision]) => {
      if (decision.kind !== 'open') return false;
      const item = this.items.get(id);
      return item !== undefined && item.status === 'queued' && item.assignee.kind !== 'session';
    }).length;
    return {
      members,
      holds,
      maxParallel: this.settings.maxParallel,
      maxPerRepo: this.settings.maxPerRepo ?? 4,
      maxSquadSessions: this.settings.maxSquadSessions,
      squadSessionsOpen: squadSessionsOpen + preparingSessions,
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
        if (item.squadRunId !== undefined && this.ports.isCompactSquadProposal?.(item.squadRunId)) {
          const before = item.status;
          const screen = await this.readHolderResult(item);
          if (item.status !== before) return;
          const result = `Agent dừng chờ trả lời: ${screen ?? reason}`;
          item.result = clip(result, WORK_ITEM_RESULT_MAX_CHARS);
          this.fail(item, item.result, item.result);
          return;
        }
        this.setStatus(item, 'needs_input', reason, reason);
      }
      return;
    }
    if (observation !== 'free') return;
    // A judge that held the item for the user keeps it in needs-input until the user acts.
    if (item.status === 'needs_input' && item.reason?.startsWith(JUDGE_NOT_MET_PREFIX) === true)
      return;
    if (this.sending.has(item.id)) return;
    const dispatchedMs = item.dispatchedAt === undefined ? 0 : Date.parse(item.dispatchedAt);
    const elapsed = this.ports.now() - dispatchedMs;
    // An agent herdr just opened takes a while to read a long brief before herdr shows it busy: an
    // idle pane is not taken for a finished one until it was seen at work, or the start window ends.
    const window = item.assignee.kind === 'herdr' ? WORK_ITEM_HERDR_START_MS : WORK_ITEM_GRACE_MS;
    if (!this.observedBusy.has(item.id) && elapsed < window) {
      if (elapsed >= WORK_ITEM_GRACE_MS) this.scheduleGraceCheck();
      return;
    }
    if (await this.replyUnchanged(item, elapsed)) {
      // An idle pane sends no event when its transcript grows: look again after a while.
      this.scheduleGraceCheck();
      return;
    }
    this.replyAtSend.delete(item.id);
    await this.complete(item);
  }

  /** True while a herdr agent's last reply is still the one it had when the item was sent. */
  private async replyUnchanged(item: StoredWorkItem, elapsed: number): Promise<boolean> {
    const before = this.replyAtSend.get(item.id);
    if (before === undefined || item.assignee.kind !== 'herdr') return false;
    // An agent that never writes a new reply (its transcript moved) still finishes in the end.
    if (elapsed >= WORK_ITEM_STALE_REPLY_MS) return false;
    const now = await this.ports.roster.lastReply?.(item.assignee.paneId ?? '');
    return now === undefined || now === before;
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

  /** The agent stopped after working. The item goes to review, with its last reply as the result. */
  private async complete(item: StoredWorkItem): Promise<void> {
    const before = item.status;
    const result = await this.readHolderResult(item);
    // The user may have acted while the screen was read; only a still-running item moves.
    if (item.status !== before || !occupiesAgent(item.status)) return;
    this.moveToReview(item, result, 'Agent đã dừng.');
  }

  /** Moves a running item to review with its result, then checks conflicts and judges it when autoJudge is on. */
  private moveToReview(item: StoredWorkItem, result: string | undefined, message: string): void {
    const at = this.iso();
    this.observedBusy.delete(item.id);
    if (item.squadRunId !== undefined && this.ports.isCompactSquadProposal?.(item.squadRunId)) {
      item.status = 'done';
      item.updatedAt = at;
      delete item.reason;
      if (result === undefined) delete item.result;
      else item.result = result;
      this.pushEvent(item, makeEvent(at, 'status', message));
      this.again = true;
      this.commit();
      this.notifySettled(item);
      this.scheduleReconcile();
      return;
    }
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

  /** The holder's last reply: a herdr pane's transcript or screen, or a board session's transcript. */
  private async readHolderResult(item: StoredWorkItem): Promise<string | undefined> {
    const { assignee } = item;
    if (assignee.kind === 'herdr' && assignee.paneId !== undefined) {
      return this.readResult(assignee.paneId);
    }
    if (assignee.kind !== 'session' || assignee.sessionId === undefined) return undefined;
    const reply = await this.ports.sessions.lastReply?.(assignee.sessionId).catch(() => undefined);
    return reply === undefined || reply.trim() === ''
      ? undefined
      : clip(reply.trim(), WORK_ITEM_RESULT_MAX_CHARS);
  }

  /** The agent's last reply from its transcript when it can be read, else the screen's last lines. */
  private async readResult(paneId: string): Promise<string | undefined> {
    const reply = await this.ports.roster.lastReply?.(paneId).catch(() => undefined);
    if (reply !== undefined && reply.trim() !== '') return clip(reply.trim(), WORK_ITEM_RESULT_MAX_CHARS);
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
    // Guarded before the first await: a pass while the baseline reply is read must not finish it.
    this.sending.add(item.id);
    const paneId = item.assignee.kind === 'herdr' ? item.assignee.paneId : undefined;
    const previous = paneId === undefined ? undefined : await this.ports.roster.lastReply?.(paneId).catch(() => undefined);
    if (previous !== undefined) this.replyAtSend.set(item.id, previous);
    try {
      await this.send(item, item.pendingPrompt);
    } catch (error) {
      this.replyAtSend.delete(item.id);
      if (item.status === 'running' && item.dispatchedAt === at) {
        const detail = describe(error);
        this.fail(item, WORK_ITEM_REASON.sendFailed(detail), detail);
      }
      return;
    } finally {
      this.sending.delete(item.id);
    }
    // The grace window runs from when the agent took the prompt, not from when sending began.
    if (item.status === 'running' && item.dispatchedAt === at) item.dispatchedAt = this.iso();
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

  /** Claude Code runs in flight: headless runs, and items an interactive Claude pane in herdr holds. */
  private claudeRunsOpen(): number {
    return this.cliRunsOpen('claude');
  }

  private agyRunsOpen(): number {
    return this.cliRunsOpen('agy');
  }

  private cliRunsOpen(kind: 'claude' | 'agy'): number {
    const paneKinds = new Map(this.ports.roster.panes().panes.map((pane) => [pane.paneId, pane.kind]));
    let open = 0;
    for (const item of this.items.values()) {
      if (!occupiesAgent(item.status)) continue;
      const assignee = item.assignee;
      if (assignee.kind === kind) open += 1;
      else if (assignee.kind === 'herdr' && paneKinds.get(assignee.paneId ?? '') === kind) open += 1;
    }
    return open;
  }

  /**
   * Opens the item's agent (omp, Claude Code or agy) in its own herdr tab: the pane id, undefined when
   * herdr cannot open one (the board then runs it), or null when the open failed and failed the item.
   * A read-only item's Claude starts in plan mode; an editing one in the folder's Claude permission.
   */
  private async openAgentPane(
    item: StoredWorkItem,
    kind: 'omp' | 'claude' | 'agy',
    cwd: string,
    readOnly: boolean,
  ): Promise<string | undefined | null> {
    const roster = this.ports.roster;
    if (roster.startAgent === undefined || !roster.panes().available) return undefined;
    // An unattended omp in a large TypeScript worktree starts its own tsserver (about 1 GB each, measured on
    // the Backend); the agent checks types with the repo's own `tsc` anyway, so board runs go without LSP.
    const args = kind === 'claude'
      ? ['--permission-mode', readOnly ? 'plan' : this.settings.claudePermission]
      : kind === 'omp' ? ['--no-lsp'] : [];
    try {
      return await roster.startAgent({ cwd, kind, name: `${kind}-${item.id.slice(0, 8)}`, args });
    } catch (error) {
      this.fail(item, WORK_ITEM_REASON.agentPaneFailed, describe(error));
      return null;
    }
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
      // A folder that is not a git repo has nothing to isolate: the item runs in the folder itself,
      // instead of waiting for a worktree that can never be made.
      if (/not a git repository/i.test(detail)) {
        this.pushEvent(item, makeEvent(this.iso(), 'note', 'Thư mục này không phải repo git: chạy ngay trong thư mục, không tạo worktree.'));
        return repo;
      }
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

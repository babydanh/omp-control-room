/**
 * companyState: the client's view of the company, as a pure reduction.
 *
 * The server owns every fact here. This module never invents a transition, and
 * it never "catches up" by applying a change it was not sure about:
 *
 *  - `companyStateChanged` is applied ONLY when its revision is exactly the next
 *    one. An older revision is a duplicate of something already applied and is
 *    dropped; a newer one is a GAP -- some change was missed, and no amount of
 *    applying later deltas repairs that, so the client stops applying and asks
 *    for a full snapshot instead. While a gap is open, every further change is
 *    ignored until that snapshot arrives.
 *  - A snapshot replaces the collections it enumerates (prompts, contracts,
 *    tasks, sessions, questions, quotas) and RESETS the revision baseline. The
 *    incremental collections (attempts, evidence, reports, usage) are replaced
 *    only when the snapshot carries them: a list it sends is complete, so it
 *    also drops any removal the client missed during a gap. An absent field
 *    keeps what the client holds, because the server has nothing newer to say
 *    about it; dropping the data would turn a resync into data loss. Their
 *    removals arrive as explicit `remove` changes.
 *  - Nothing here is optimistic. A command does not move a card; the card moves
 *    when the state change for it arrives.
 *
 * DOM-free and React-free on purpose: the client owns the transport, this owns
 * the rules, and the tests drive the rules directly.
 */

import type {
  AgentInfo,
  CompanyModelCatalogEntry,
  CompanyPromptSummary,
  CompanyReport,
  CompanySessionLogEntry,
  CompanySessionSummary,
  CompanySnapshot,
  HerdrAgent,
  Task,
  UsageRecord,
} from '../../../core/src/company.js';
import type {
  BrowserReaperStatusMessage,
  CompanyFileContent,
  CompanyFileEntry,
  CompanyFolderBrowseMessage,
  CompanyRemoveChange,
  CompanySquadMessage,
  CompanyStateChangedMessage,
  CompanyWorkItemsMessage,
  CompanyWorkspaceEntry,
  HerdrSleepingSession,
  OmpSessionEntry,
  ServerMessage,
} from '../../../core/src/messages.js';
import { type CommandResultView, failureNotice, viewCommandResult } from './commandResults.js';
import {
  COMPANY_SESSION_LOG_MAX_ENTRIES,
  COMPANY_TERMINAL_FRAME_QUEUE_MAX,
  COMPANY_TEXT_EXCERPT_GRAPHEMES,
  COMPANY_TEXT_STREAM_MAX_CHARS,
} from './constants.js';
import {
  type CompanyViewMode,
  DEFAULT_VIEW_MODE,
  emptyFolderScope,
  focusFolder,
  type FolderFocusInput,
  folderKeyOf,
  type FolderScope,
  foldersInView,
  inFolderView,
  mergeFolderScopes,
  UNTAGGED_FOLDER,
} from './folderView.js';
import {
  applySubmitResult,
  EMPTY_PROMPT_DRAFT,
  type PromptDraftState,
} from './promptSubmission.js';
import { selectionForSession } from './selection.js';
import type { FolderSquad } from './squadView.js';
import { excerptLine } from './textExcerpt.js';
import {
  emptyUsageState,
  reduceUsageMessage,
  usageCommandFailed,
  type UsageState,
} from './usage/usageState.js';
import type { FolderWorkItems } from './workItemView.js';

export type CompanyPutChange = Exclude<
  CompanyStateChangedMessage['changes'][number],
  CompanyRemoveChange
>;

/** What the client must do as a consequence of a reduced message. */
export type CompanyEffect =
  | { type: 'requestSnapshot'; workspacePath?: string }
  | { type: 'requestModelCatalog' }
  | { type: 'reAttachTerminal'; sessionId: string; runEpoch: number };

export interface CompanyResult {
  state: CompanyViewState;
  effects: CompanyEffect[];
}

/** The one selection shared by the board, the drawer and the office. */
export interface CompanySelection {
  sessionId: string | null;
  taskId: string | null;
  /** Drawer tab the session should open on; null keeps the drawer's default. */
  tab: CompanyDrawerTab | null;
  /** The herdr agent the composer is aimed at. Never set together with a session (see selectionWith). */
  herdrPaneId: string | null;
}

/**
 * Which drawer tab the selection is pointing at. `null` means "whatever the
 * drawer opens by default". It lives in the selection rather than in the
 * bubble or the board because all three surfaces ask for the same session, and
 * a click that means "show me the question it is blocked on" has to survive
 * the drawer being re-rendered by an unrelated company message.
 *
 * Four tabs cover a session: its activity timeline, its live terminal, the work
 * it holds, and its details. A pending question is a banner above them, not a tab.
 */
export type CompanyDrawerTab = 'activity' | 'terminal' | 'tasks' | 'details';

export const EMPTY_SELECTION: CompanySelection = {
  sessionId: null,
  taskId: null,
  tab: null,
  herdrPaneId: null,
};

export interface TextStreamView {
  sessionId: string;
  runEpoch: number;
  /** Newest delta sequence applied; older deltas are dropped. */
  seq: number;
  /** Bounded tail of public assistant output for this session. */
  tail: string;
  /** The bubble line: the last N graphemes of the tail. */
  excerpt: string;
}

export type TerminalFrameKind = 'snapshot' | 'data';

export interface TerminalFrame {
  seq: number;
  kind: TerminalFrameKind;
  /** base64 PTY bytes. */
  data: string;
}

export interface TerminalView {
  sessionId: string;
  runEpoch: number;
  attached: boolean;
  leaseId: string | null;
  /** Shared PTY size the lease last reported or was resized to; null before attach. */
  cols: number | null;
  rows: number | null;
  lastSeq: number;
  frames: TerminalFrame[];
  /** Set when a consumer fell behind; the client asks for a fresh screen. */
  overflow: boolean;
  closedReason: string | null;
}

/**
 * A session as the drawer needs it: the snapshot's summary plus the native
 * identity a later `session` put revealed.
 */
export interface SessionView extends CompanySessionSummary {
  workstreamId?: string;
  nativeSessionId?: string;
  nativeSessionPath?: string;
}

export interface ArtifactView {
  artifactId: string;
  contentType: string;
  totalBytes: number;
  eof: boolean;
  /** Pages in offset order; decoding happens at display time. */
  pages: { offset: number; dataBase64: string }[];
}

export interface FileListingView {
  path: string;
  entries: CompanyFileEntry[];
  loaded: boolean;
  error: string | null;
}

export interface FileContentView {
  path: string;
  /** Every page read so far, in the order requested. */
  pages: CompanyFileContent[];
  loaded: boolean;
  error: string | null;
}

/**
 * One session's log as the drawer shows it. Entries are keyed by seq, so the
 * replay that answers a drawer opening and the live pushes that follow it can
 * overlap without doubling a line.
 */
export interface SessionLogView {
  sessionId: string;
  /** Ascending by seq, unique by seq, and at most COMPANY_SESSION_LOG_MAX_ENTRIES long. */
  entries: CompanySessionLogEntry[];
  /** True once a replay has answered; until then the drawer shows a loading line. */
  replayed: boolean;
}

export interface HerdrScreenView {
  paneId: string;
  text: string;
  at: string;
}

/** What the board knows about the user's herdr server. */
export interface HerdrView {
  /** False until the first herdrAgents answer, so no herdr group is drawn before then. */
  loaded: boolean;
  available: boolean;
  reason: string | null;
  /** Live herdr agents in view: the roster's agents that the folder rules keep. */
  agents: HerdrAgent[];
  /** Hibernated omp sessions in view: a pane the herdr server still holds, with no live agent. */
  sleeping: HerdrSleepingSession[];
  /** Latest screen per pane; a late reply older than the one held is dropped. */
  screens: Record<string, HerdrScreenView>;
  /** Latest agent info per pane; a late reply older than the one held is dropped. */
  infos: Record<string, AgentInfo>;
}

export function emptyHerdrView(): HerdrView {
  return {
    loaded: false,
    available: false,
    reason: null,
    agents: [],
    sleeping: [],
    screens: {},
    infos: {},
  };
}

/** The server's herdr roster: every pane the herdr server reports, before the folder rules apply. */
export interface HerdrRoster {
  agents: HerdrAgent[];
  sleeping: HerdrSleepingSession[];
}

/** The omp sessions the resume picker lists: the latest answer to a request for them. */
export interface OmpSessionsView {
  requestId: string;
  folder: string;
  sessions: OmpSessionEntry[];
}

/** A folder switch carrying a session choice, held until the switch's verdict and the folder's snapshot. */
export interface PendingWorkspaceSelection {
  /** The folder switch's command: its verdict decides whether the choice stands. */
  requestId: string;
  path: string;
  sessionId: string;
  /** True once the server accepted the switch; the selection then waits for the snapshot. */
  confirmed: boolean;
}

/**
 * The board's view. The company fields it inherits from FolderScope are the merged view of
 * the folders in view; `folders` keeps each folder's own data, and the view is derived from
 * it on every change.
 */
export interface CompanyViewState extends FolderScope {
  /** Each folder's own company data, keyed by the folder path the server tags it with. */
  folders: Record<string, FolderScope>;
  /** `all` merges every open folder; `folder` shows only the active one. */
  viewMode: CompanyViewMode;
  /** The folder the user last picked or created in; the target of new work in `all` mode. */
  focusPath: string | null;
  /** The folder each session, task, contract, question or prompt in view belongs to. */
  folderOf: Record<string, string>;
  commandResults: Record<string, CommandResultView>;
  modelCatalog: CompanyModelCatalogEntry[];
  /** False until the server has answered the catalog request; an empty catalog before that is loading, not empty. */
  modelCatalogLoaded: boolean;
  terminals: Record<string, TerminalView>;
  artifacts: Record<string, ArtifactView>;
  fileListings: Record<string, FileListingView>;
  fileContents: Record<string, FileContentView>;
  /** Model the user picked for the next dispatch; null means "server default". */
  selectedModel: string | null;
  selection: CompanySelection;
  /** The composer's draft, retained until the server accepts it. */
  prompt: PromptDraftState;
  /** Session logs keyed by session id; a log survives the drawer closing. */
  sessionLogs: Record<string, SessionLogView>;
  /** Latest agent info per session; a late reply older than the one held is dropped. */
  sessionInfos: Record<string, AgentInfo>;
  herdr: HerdrView;
  /** The server's whole herdr roster; `herdr.agents` and `herdr.sleeping` are its part in view. */
  herdrRoster: HerdrRoster;
  /** The server's latest omp headless-browser report; null until one has arrived. */
  browserReaper: BrowserReaperStatusMessage | null;
  /** The latest answer to a resume-picker request; null until one has arrived. */
  ompSessions: OmpSessionsView | null;
  /** The folders the server reports; null until the server has sent a list. */
  workspaces: CompanyWorkspaceEntry[] | null;
  /** requestId of a folder switch in flight; its success clears the selection. */
  pendingWorkspaceOpen: string | null;
  /** A session a successful command named that is not on the board yet; selected once it is. */
  openingSessionId: string | null;
  /** A session chosen in a folder the board is switching to; selected once that folder's snapshot holds it. */
  pendingWorkspaceSelection: PendingWorkspaceSelection | null;
  /** Why the last choice of a session in another folder did not land; null when none failed. */
  workspaceSelectionNotice: string | null;
  /** The listing the server sent for the latest folder browse; null until one arrives. */
  folderBrowse: CompanyFolderBrowseMessage | null;
  /** requestId of the latest folder browse; a listing under any other id is dropped. */
  folderBrowseRequest: string | null;
  /** The usage page's data: the latest answer per request, and which requests are waiting. */
  usageSlots: UsageState;
  /**
   * Each folder's work items and roles, keyed by the folder path the server tags them with. A
   * folder's list is replaced only by a newer revision; which folders show is decided on read.
   */
  workItems: Record<string, FolderWorkItems>;
  /**
   * Each folder's squad runs, keyed by the folder path the server tags them with. A folder's list
   * is replaced only by a newer revision, as its work items are.
   */
  squad: Record<string, FolderSquad>;
}

export function emptyCompanyState(
  view: { viewMode: CompanyViewMode; focusPath: string | null } = {
    viewMode: DEFAULT_VIEW_MODE,
    focusPath: null,
  },
): CompanyViewState {
  return {
    ...emptyFolderScope(),
    folders: {},
    folderOf: {},
    viewMode: view.viewMode,
    focusPath: view.focusPath,
    commandResults: {},
    modelCatalog: [],
    modelCatalogLoaded: false,
    terminals: {},
    artifacts: {},
    fileListings: {},
    fileContents: {},
    selectedModel: null,
    selection: EMPTY_SELECTION,
    prompt: EMPTY_PROMPT_DRAFT,
    sessionLogs: {},
    sessionInfos: {},
    herdr: emptyHerdrView(),
    herdrRoster: { agents: [], sleeping: [] },
    browserReaper: null,
    ompSessions: null,
    workspaces: null,
    pendingWorkspaceOpen: null,
    openingSessionId: null,
    pendingWorkspaceSelection: null,
    workspaceSelectionNotice: null,
    folderBrowse: null,
    folderBrowseRequest: null,
    usageSlots: emptyUsageState(),
    workItems: {},
    squad: {},
  };
}

function unchanged(state: CompanyViewState, effects: CompanyEffect[] = []): CompanyResult {
  return { state, effects };
}

function indexById<T extends { id: string }>(entries: readonly T[]): Record<string, T> {
  const index: Record<string, T> = {};
  for (const entry of entries) index[entry.id] = entry;
  return index;
}

/**
 * Usage is deduplicated by the native entry that produced it: the same entry
 * can legitimately be re-reported by a rescan of the same session file, and
 * adding it twice would invent spend the company never made.
 */
export function usageKey(record: UsageRecord): string {
  return `${record.nativeSessionId}:${record.nativeEntryId}`;
}

/**
 * Merge a batch of session-log entries into what the client already holds.
 *
 * A replay and the live stream can describe the same seq, so entries are keyed
 * by seq and the newer delivery wins. The view stays ascending by seq and
 * bounded: when it overflows, the oldest entries go, because the drawer is
 * about what happened lately.
 */
export function mergeSessionLog(
  existing: SessionLogView | undefined,
  sessionId: string,
  incoming: readonly CompanySessionLogEntry[],
  replay: boolean,
): SessionLogView {
  const bySeq = new Map<number, CompanySessionLogEntry>();
  for (const entry of existing?.entries ?? []) bySeq.set(entry.seq, entry);
  for (const entry of incoming) bySeq.set(entry.seq, entry);
  const sorted = [...bySeq.values()].sort((left, right) => left.seq - right.seq);
  const overflow = sorted.length - COMPANY_SESSION_LOG_MAX_ENTRIES;
  return {
    sessionId,
    entries: overflow > 0 ? sorted.slice(overflow) : sorted,
    replayed: (existing?.replayed ?? false) || replay,
  };
}

/**
 * Keeps the entries whose key still names a live thing. A removed session or pane takes
 * its per-entity data with it.
 */
function keepLive<T>(
  records: Record<string, T>,
  isLive: (key: string) => boolean,
): Record<string, T> {
  const kept: Record<string, T> = {};
  for (const [key, value] of Object.entries(records)) {
    if (isLive(key)) kept[key] = value;
  }
  return kept;
}

function indexReports(reports: readonly CompanyReport[]): Record<string, CompanyReport> {
  // Keyed the way the server keys a report put: by contract.
  return Object.fromEntries(
    reports.map((report): [string, CompanyReport] => [report.contractId, report]),
  );
}

function indexUsage(records: readonly UsageRecord[]): Record<string, UsageRecord> {
  return Object.fromEntries(
    records.map((record): [string, UsageRecord] => [usageKey(record), record]),
  );
}

/** A screen reply older than the one already held is a late answer; keep the newer. */
function applyHerdrScreen(
  herdr: HerdrView,
  message: { paneId: string; text: string; at: string },
): HerdrView {
  const held = herdr.screens[message.paneId];
  if (held !== undefined && held.at > message.at) return herdr;
  return {
    ...herdr,
    screens: {
      ...herdr.screens,
      [message.paneId]: { paneId: message.paneId, text: message.text, at: message.at },
    },
  };
}

/**
 * Keeps the newer of a held agent info and an incoming one. Info is a measurement taken
 * at `collectedAt`, so a reply measured earlier than the one held is a late answer and is
 * dropped. A held info with an unreadable time is replaced; an incoming one with an
 * unreadable time never displaces a readable one.
 */
function withNewerInfo(
  infos: Record<string, AgentInfo>,
  key: string,
  incoming: AgentInfo,
): Record<string, AgentInfo> {
  const held = infos[key];
  if (held !== undefined && isOlderInfo(incoming, held)) return infos;
  return { ...infos, [key]: incoming };
}

function isOlderInfo(incoming: AgentInfo, held: AgentInfo): boolean {
  const heldAt = Date.parse(held.collectedAt);
  if (Number.isNaN(heldAt)) return false;
  const incomingAt = Date.parse(incoming.collectedAt);
  return Number.isNaN(incomingAt) || incomingAt < heldAt;
}

function applySnapshot(scope: FolderScope, snapshot: CompanySnapshot): FolderScope {
  // A Contract embeds its tasks; the snapshot's own task list is the
  // authoritative one, and the embedded copies fill any task it omits.
  const tasks: Record<string, Task> = {};
  for (const task of snapshot.tasks) tasks[task.id] = task;
  for (const contract of snapshot.contracts) {
    for (const task of contract.tasks) {
      if (tasks[task.id] === undefined) tasks[task.id] = task;
    }
  }

  const sessions = indexById(snapshot.sessions);

  return {
    ...scope,
    revision: snapshot.revision,
    needsSnapshot: false,
    settings: snapshot.settings,
    prompts: [...snapshot.prompts],
    contracts: indexById(snapshot.contracts),
    tasks,
    sessions,
    questions: indexById(snapshot.questions),
    quotas: Object.fromEntries(snapshot.quotas.map((quota) => [quota.provider, quota])),
    diagnostics: snapshot.diagnostics ?? scope.diagnostics,
    attempts: snapshot.attempts === undefined ? scope.attempts : indexById(snapshot.attempts),
    evidence: snapshot.evidence === undefined ? scope.evidence : indexById(snapshot.evidence),
    reports: snapshot.reports === undefined ? scope.reports : indexReports(snapshot.reports),
    usage: snapshot.usage === undefined ? scope.usage : indexUsage(snapshot.usage),
  };
}

function applyChange<S extends FolderScope>(
  state: S,
  change: CompanyPutChange | CompanyRemoveChange,
): S {
  if (change.op === 'remove') {
    switch (change.entity) {
      case 'prompt':
        return { ...state, prompts: state.prompts.filter((entry) => entry.id !== change.id) };
      case 'contract': {
        const contracts = { ...state.contracts };
        delete contracts[change.id];
        return { ...state, contracts };
      }
      case 'task': {
        const tasks = { ...state.tasks };
        delete tasks[change.id];
        return { ...state, tasks };
      }
      case 'session': {
        const sessions = { ...state.sessions };
        delete sessions[change.id];
        return { ...state, sessions };
      }
      case 'question': {
        const questions = { ...state.questions };
        delete questions[change.id];
        return { ...state, questions };
      }
      case 'attempt': {
        const attempts = { ...state.attempts };
        delete attempts[change.id];
        return { ...state, attempts };
      }
      case 'report': {
        const reports = { ...state.reports };
        delete reports[change.id];
        return { ...state, reports };
      }
      case 'evidence': {
        const evidence = { ...state.evidence };
        delete evidence[change.id];
        return { ...state, evidence };
      }
      case 'usage': {
        // A usage record is keyed by (nativeSessionId, nativeEntryId), so a
        // removal may name either half of that pair; match on all three forms
        // rather than guessing which one the journal used.
        const usage: Record<string, UsageRecord> = {};
        for (const [key, record] of Object.entries(state.usage)) {
          const named =
            key === change.id ||
            record.nativeEntryId === change.id ||
            record.sessionId === change.id;
          if (!named) usage[key] = record;
        }
        return { ...state, usage };
      }
      case 'quota': {
        const quotas = { ...state.quotas };
        delete quotas[change.id];
        return { ...state, quotas };
      }
      default:
        return state;
    }
  }

  switch (change.entity) {
    case 'prompt': {
      const summary: CompanyPromptSummary = {
        id: change.value.id,
        preview: change.value.preview,
        createdAt: change.value.createdAt,
        attachments: change.value.attachments ?? [],
        ...(change.value.targetSessionId === undefined
          ? {}
          : { targetSessionId: change.value.targetSessionId }),
      };
      const prompts = state.prompts.some((entry) => entry.id === summary.id)
        ? state.prompts.map((entry) => (entry.id === summary.id ? summary : entry))
        : [...state.prompts, summary];
      return { ...state, prompts };
    }
    case 'contract':
      return { ...state, contracts: { ...state.contracts, [change.id]: change.value } };
    case 'task':
      return { ...state, tasks: { ...state.tasks, [change.id]: change.value } };
    case 'session': {
      // A session put carries the native identity (which OMP session this is);
      // the snapshot's summaries do not. Both land in the same view so the
      // drawer can label both, and absent fields simply stay absent.
      const summary: SessionView = {
        id: change.value.id,
        code: change.value.code,
        name: change.value.name,
        role: change.value.role,
        requestedModel: change.value.requestedModel,
        effectiveModel: change.value.effectiveModel,
        agentId: change.value.agentId,
        runEpoch: change.value.runEpoch,
        status: change.value.status,
        activeTaskId: change.value.activeTaskId,
        lastUsedAt: change.value.lastUsedAt,
        contextSnapshot: change.value.contextSnapshot,
        insight: change.value.insight,
        workstreamId: change.value.workstreamId,
        nativeSessionId: change.value.nativeSessionId,
        nativeSessionPath: change.value.nativeSessionPath,
      };
      return { ...state, sessions: { ...state.sessions, [change.id]: summary } };
    }
    case 'question':
      return { ...state, questions: { ...state.questions, [change.id]: change.value } };
    case 'attempt':
      return { ...state, attempts: { ...state.attempts, [change.id]: change.value } };
    case 'report':
      return { ...state, reports: { ...state.reports, [change.id]: change.value } };
    case 'evidence':
      return { ...state, evidence: { ...state.evidence, [change.id]: change.value } };
    case 'settings':
      return { ...state, settings: change.value };
    case 'usage':
      return { ...state, usage: { ...state.usage, [usageKey(change.value)]: change.value } };
    case 'quota':
      return { ...state, quotas: { ...state.quotas, [change.id]: change.value } };
    case 'counters':
      return { ...state, counters: change.value };
    default:
      return state;
  }
}

/**
 * One folder's state change, applied on its own revision baseline. A gap in that folder's
 * revisions is repaired by asking for that folder's snapshot; the other folders are untouched.
 */
function applyStateChanged(
  state: CompanyViewState,
  message: CompanyStateChangedMessage,
): CompanyResult {
  const key = folderKeyOf(message);
  const scope = state.folders[key] ?? emptyFolderScope();
  // A gap is open, or this folder never had a baseline: neither can be repaired by
  // applying this change, so ask for its whole picture instead.
  if (scope.revision === null || scope.needsSnapshot) {
    if (scope.needsSnapshot) return unchanged(state);
    return awaitFolderSnapshot(state, key);
  }
  if (message.revision <= scope.revision) return unchanged(state);
  if (message.revision > scope.revision + 1) return awaitFolderSnapshot(state, key);

  let next = scope;
  for (const change of message.changes) next = applyChange(next, change);
  return unchanged(withFolderScope(state, key, { ...next, revision: message.revision }));
}

function applyTextDelta(
  scope: FolderScope,
  message: Extract<ServerMessage, { type: 'companyTextDelta' }>,
): FolderScope {
  const existing = scope.streams[message.sessionId];
  // A restart is a new run: its text is not a continuation of the old tail.
  const base: TextStreamView =
    existing && existing.runEpoch === message.runEpoch
      ? existing
      : {
          sessionId: message.sessionId,
          runEpoch: message.runEpoch,
          seq: 0,
          tail: '',
          excerpt: '',
        };
  if (message.seq <= base.seq) return scope;
  const tail = (base.tail + message.text).slice(-COMPANY_TEXT_STREAM_MAX_CHARS);
  return {
    ...scope,
    streams: {
      ...scope.streams,
      [message.sessionId]: {
        ...base,
        seq: message.seq,
        tail,
        excerpt: excerptLine(tail, COMPANY_TEXT_EXCERPT_GRAPHEMES),
      },
    },
  };
}

function newTerminalView(sessionId: string, runEpoch: number): TerminalView {
  return {
    sessionId,
    runEpoch,
    attached: false,
    leaseId: null,
    cols: null,
    rows: null,
    lastSeq: 0,
    frames: [],
    overflow: false,
    closedReason: null,
  };
}

function applyTerminalFrame(
  state: CompanyViewState,
  message: ServerMessage,
  kind: TerminalFrameKind,
): CompanyViewState {
  if (
    message.type !== 'terminalSnapshot' &&
    message.type !== 'terminalData' &&
    message.type !== 'terminalClosed'
  ) {
    return state;
  }
  const existing =
    state.terminals[message.sessionId] ?? newTerminalView(message.sessionId, message.runEpoch);
  if (message.runEpoch !== existing.runEpoch) return state;
  if (message.seq <= existing.lastSeq) return state;

  if (message.type === 'terminalClosed') {
    return {
      ...state,
      terminals: {
        ...state.terminals,
        [message.sessionId]: {
          ...existing,
          lastSeq: message.seq,
          attached: false,
          closedReason: message.reason,
        },
      },
    };
  }

  // A snapshot replaces the screen: earlier frames describe a buffer that no
  // longer exists, so they are dropped rather than replayed on top of it.
  const frames =
    kind === 'snapshot'
      ? [{ seq: message.seq, kind, data: message.data }]
      : [...existing.frames, { seq: message.seq, kind, data: message.data }];
  const overflow = frames.length > COMPANY_TERMINAL_FRAME_QUEUE_MAX;
  return {
    ...state,
    terminals: {
      ...state.terminals,
      [message.sessionId]: {
        ...existing,
        lastSeq: message.seq,
        frames: overflow ? frames.slice(-COMPANY_TERMINAL_FRAME_QUEUE_MAX) : frames,
        overflow,
      },
    },
  };
}

/**
 * The folders the server reports. When the active one changes, what the board held for
 * the old folder goes: its terminal leases belong to sessions that are no longer here, and
 * a selection or a resume list names those sessions.
 */
function applyWorkspaces(
  state: CompanyViewState,
  workspaces: readonly CompanyWorkspaceEntry[],
): CompanyViewState {
  const before = state.workspaces?.find((entry) => entry.active)?.path ?? null;
  const after = workspaces.find((entry) => entry.active)?.path ?? null;
  const held = project({ ...state, workspaces: [...workspaces] });
  if (state.workspaces === null || before === after) return held;
  // Folder mode shows one folder, so the selection belonged to the folder it left.
  // All mode shows every folder, so the selection and the terminals stay.
  if (state.viewMode !== 'folder') return held;
  return {
    ...held,
    terminals: {},
    selection: EMPTY_SELECTION,
    ompSessions: null,
    openingSessionId: null,
  };
}

/**
 * One folder's work items. The server sends a folder's whole list after every change, so a
 * newer revision replaces the one held; an older or repeated revision is dropped.
 */
function applyWorkItems(
  state: CompanyViewState,
  message: CompanyWorkItemsMessage,
): CompanyViewState {
  const key = folderKeyOf(message);
  const held: FolderWorkItems | undefined = state.workItems[key];
  if (held !== undefined && message.revision <= held.revision) return state;
  return {
    ...state,
    workItems: {
      ...state.workItems,
      [key]: {
        revision: message.revision,
        items: message.items.map((item) => ({ ...item, areas: item.areas ?? [] })),
        roles: [...message.roles],
        repos: [...(message.repos ?? [])],
        agents: [...(message.agents ?? [])],
        settings: message.settings ?? null,
        parkedSessionIds: [...(message.parkedSessionIds ?? [])],
      },
    },
  };
}

/**
 * One folder's squad runs. The server sends a folder's whole list after every change, so a newer
 * revision replaces the one held; an older or repeated revision is dropped.
 */
function applySquad(state: CompanyViewState, message: CompanySquadMessage): CompanyViewState {
  const key = folderKeyOf(message);
  const held: FolderSquad | undefined = state.squad[key];
  if (held !== undefined && message.revision <= held.revision) return state;
  return {
    ...state,
    squad: {
      ...state.squad,
      [key]: { revision: message.revision, runs: [...message.runs] },
    },
  };
}

/** Stores one folder's company data, then re-derives the view the board reads. */
function withFolderScope(
  state: CompanyViewState,
  key: string,
  scope: FolderScope,
): CompanyViewState {
  return project({ ...state, folders: { ...state.folders, [key]: scope } });
}

/**
 * Derives the flat view from the folders in view: their merged company data, plus the
 * per-session data that the merged ids keep live.
 */
function project(state: CompanyViewState): CompanyViewState {
  const input = {
    viewMode: state.viewMode,
    focusPath: state.focusPath,
    workspaces: state.workspaces,
  };
  const inView = foldersInView(input, Object.keys(state.folders));
  const focus = focusFolder(input) ?? inView[inView.length - 1] ?? null;
  const { folderOf, ...scope } = mergeFolderScopes(
    inView.map((path) => ({ path, scope: state.folders[path] ?? emptyFolderScope() })),
    focus,
  );
  return {
    ...state,
    ...scope,
    folderOf,
    herdr: herdrInView(state.herdr, state.herdrRoster, input),
    sessionLogs: keepLive(
      state.sessionLogs,
      (sessionId) => scope.sessions[sessionId] !== undefined,
    ),
    sessionInfos: keepLive(
      state.sessionInfos,
      (sessionId) => scope.sessions[sessionId] !== undefined,
    ),
  };
}

/**
 * The herdr panes in view: the roster's agents and sessions that the folder rules keep. A list
 * that holds the same panes as before is kept, so an unrelated change re-derives nothing.
 */
function herdrInView(herdr: HerdrView, roster: HerdrRoster, input: FolderFocusInput): HerdrView {
  const agents = keepIfSame(
    herdr.agents,
    roster.agents.filter((agent) => inFolderView(input, agent.workspacePath)),
  );
  const sleeping = keepIfSame(
    herdr.sleeping,
    roster.sleeping.filter((session) => inFolderView(input, session.workspacePath)),
  );
  if (agents === herdr.agents && sleeping === herdr.sleeping) return herdr;
  return { ...herdr, agents, sleeping };
}

/** The held list when it holds exactly the same items as `next`; otherwise `next`. */
function keepIfSame<T>(held: T[], next: T[]): T[] {
  const same = held.length === next.length && next.every((item, index) => item === held[index]);
  return same ? held : next;
}

/**
 * Asks the server for one folder's whole picture and marks that folder as waiting for it.
 * The other folders keep their data and their revisions.
 */
function awaitFolderSnapshot(state: CompanyViewState, key: string): CompanyResult {
  const scope = state.folders[key] ?? emptyFolderScope();
  const effect: CompanyEffect =
    key === UNTAGGED_FOLDER
      ? { type: 'requestSnapshot' }
      : { type: 'requestSnapshot', workspacePath: key };
  return {
    state: withFolderScope(state, key, { ...scope, needsSnapshot: true }),
    effects: [effect],
  };
}

/** Changes the board's view mode. A selection the new view no longer holds is dropped. */
export function applyViewMode(state: CompanyViewState, mode: CompanyViewMode): CompanyViewState {
  if (state.viewMode === mode) return state;
  return settleSelection({ state: project({ ...state, viewMode: mode }), effects: [] }).state;
}

/** Sets the folder new work targets. Only `all` mode reads it; `folder` mode uses the active folder. */
export function applyFocusFolder(state: CompanyViewState, path: string): CompanyViewState {
  if (state.focusPath === path) return state;
  return project({ ...state, focusPath: path });
}

function applyCommandResult(
  state: CompanyViewState,
  message: Extract<ServerMessage, { type: 'companyCommandResult' }>,
): CompanyResult {
  const result = viewCommandResult(message);
  const recorded: CompanyViewState = {
    ...state,
    commandResults: { ...state.commandResults, [result.requestId]: result },
    // The draft is the user's text until the server accepts it: a refused
    // prompt, a refused upload, or an answer to something else all leave it be.
    prompt: applySubmitResult(state.prompt, result),
    // A refused usage request fails its own slot. Any other verdict leaves the usage page as it was.
    usageSlots: usageCommandFailed(state.usageSlots, result),
  };
  const withSelection = applyWorkspaceSelectionVerdict(recorded, result);
  if (state.pendingWorkspaceOpen === result.requestId) {
    if (!result.ok) return { state: { ...withSelection, pendingWorkspaceOpen: null }, effects: [] };
    // The board now points at another folder: nothing selected belonged to the old one.
    return {
      state: {
        ...withSelection,
        pendingWorkspaceOpen: null,
        ompSessions: null,
        openingSessionId: null,
        selection: EMPTY_SELECTION,
      },
      effects: [{ type: 'requestSnapshot' }],
    };
  }
  // A command that opened or resumed a session names it; the board selects it once it is on screen.
  if (result.ok && result.sessionId !== undefined) {
    return { state: { ...withSelection, openingSessionId: result.sessionId }, effects: [] };
  }
  return { state: withSelection, effects: [] };
}

/**
 * The verdict on a session chosen in another folder. A refused switch drops that choice and
 * says why; an accepted one waits for the new folder's snapshot, which is what holds the session.
 */
function applyWorkspaceSelectionVerdict(
  state: CompanyViewState,
  result: CommandResultView,
): CompanyViewState {
  const pending = state.pendingWorkspaceSelection;
  if (pending === null || pending.requestId !== result.requestId) return state;
  if (result.ok) return { ...state, pendingWorkspaceSelection: { ...pending, confirmed: true } };
  return {
    ...state,
    pendingWorkspaceSelection: null,
    workspaceSelectionNotice: failureNotice(result, 'Không mở được thư mục.'),
  };
}

/**
 * Select a session chosen in another folder once the switch was accepted and the folder's
 * snapshot holds the session. Before that the board still shows the folder it left.
 */
function settleWorkspaceSelection(result: CompanyResult): CompanyResult {
  const { state } = result;
  const pending = state.pendingWorkspaceSelection;
  if (pending === null || !pending.confirmed || state.sessions[pending.sessionId] === undefined) {
    return result;
  }
  return {
    ...result,
    state: {
      ...state,
      pendingWorkspaceSelection: null,
      workspaceSelectionNotice: null,
      selection: selectionForSession(state, pending.sessionId),
    },
  };
}

/** A confirmed switch whose folder's snapshot lacks the session drops the choice, with a reason. */
function dropMissingWorkspaceSelection(state: CompanyViewState): CompanyViewState {
  const pending = state.pendingWorkspaceSelection;
  if (pending === null || !pending.confirmed || state.sessions[pending.sessionId] !== undefined) {
    return state;
  }
  return {
    ...state,
    pendingWorkspaceSelection: null,
    workspaceSelectionNotice: 'Phiên không còn trong thư mục này.',
  };
}

/**
 * Keep the selection honest after every change. A session or task the board no
 * longer holds is unselected. A session a command opened is selected as soon as it
 * appears, and a newly selected session opens on the drawer's default tab.
 */
function settleSelection(result: CompanyResult): CompanyResult {
  const { state } = result;
  let sessionId = state.selection.sessionId;
  let taskId = state.selection.taskId;
  let openingSessionId = state.openingSessionId;
  if (openingSessionId !== null && state.sessions[openingSessionId] !== undefined) {
    sessionId = openingSessionId;
    openingSessionId = null;
  }
  if (taskId !== null && state.tasks[taskId] === undefined) taskId = null;
  if (sessionId !== null && state.sessions[sessionId] === undefined) sessionId = null;
  // A herdr pane the folder view no longer holds is unselected with the rest.
  const heldPane = state.selection.herdrPaneId;
  const herdrLeftView =
    heldPane !== null &&
    !state.herdr.agents.some((agent) => agent.paneId === heldPane) &&
    !state.herdr.sleeping.some((session) => session.paneId === heldPane);
  if (
    sessionId === state.selection.sessionId &&
    taskId === state.selection.taskId &&
    openingSessionId === state.openingSessionId &&
    !herdrLeftView
  ) {
    return result;
  }
  return {
    ...result,
    state: {
      ...state,
      openingSessionId,
      selection: {
        sessionId,
        taskId,
        tab: sessionId === state.selection.sessionId ? state.selection.tab : null,
        herdrPaneId: null,
      },
    },
  };
}

/**
 * Reduce one company server message, then settle the selection against the result.
 * Unknown or foreign messages are ignored rather than throwing: this runs inside
 * the app's single transport handler.
 */
export function applyCompanyMessage(
  state: CompanyViewState,
  message: ServerMessage,
): CompanyResult {
  return settleWorkspaceSelection(settleSelection(reduceMessage(state, message)));
}

function reduceMessage(state: CompanyViewState, message: ServerMessage): CompanyResult {
  switch (message.type) {
    case 'companySnapshot': {
      const key = folderKeyOf(message);
      const scope = applySnapshot(state.folders[key] ?? emptyFolderScope(), message.snapshot);
      return unchanged(dropMissingWorkspaceSelection(withFolderScope(state, key, scope)));
    }
    case 'companyStateChanged':
      return applyStateChanged(state, message);
    case 'companyCommandResult':
      return applyCommandResult(state, message);
    case 'companyTextDelta': {
      const key = folderKeyOf(message);
      const scope = state.folders[key] ?? emptyFolderScope();
      const next = applyTextDelta(scope, message);
      return unchanged(next === scope ? state : withFolderScope(state, key, next));
    }
    case 'companyModelCatalog':
      // The catalog is what the composer's image gate reads. A model the user
      // picked that the catalog no longer lists stays selected: the server
      // answers for it with `model_unavailable`, which is more truthful than
      // silently switching the user to something else.
      return unchanged({ ...state, modelCatalog: [...message.entries], modelCatalogLoaded: true });
    case 'companyOmpSessions':
      return unchanged({
        ...state,
        ompSessions: {
          requestId: message.requestId,
          folder: message.folder,
          sessions: [...message.sessions],
        },
      });
    case 'companyWorkspaces':
      return unchanged(applyWorkspaces(state, message.workspaces));
    case 'companyWorkItems':
      return unchanged(applyWorkItems(state, message));
    case 'companySquad':
      return unchanged(applySquad(state, message));
    case 'companyFolderBrowse': {
      // Only the listing that answers the latest browse is held; an older one is a late answer.
      const current = message.requestId === state.folderBrowseRequest;
      return unchanged(current ? { ...state, folderBrowse: message } : state);
    }
    case 'companyArtifactPage': {
      const page = message.page;
      const previous: ArtifactView = state.artifacts[page.id] ?? {
        artifactId: page.id,
        contentType: page.contentType,
        totalBytes: page.totalBytes,
        eof: page.eof,
        pages: [],
      };
      // Pages can be re-requested at an offset already held; keep one copy.
      const pages = previous.pages.some((entry) => entry.offset === page.offset)
        ? previous.pages
        : [...previous.pages, { offset: page.offset, dataBase64: page.dataBase64 }].sort(
            (left, right) => left.offset - right.offset,
          );
      return unchanged({
        ...state,
        artifacts: {
          ...state.artifacts,
          [page.id]: {
            ...previous,
            contentType: page.contentType,
            totalBytes: page.totalBytes,
            eof: page.eof,
            pages,
          },
        },
      });
    }
    case 'companyFileList':
      return unchanged({
        ...state,
        fileListings: {
          ...state.fileListings,
          [message.path]: {
            path: message.path,
            entries: message.entries,
            loaded: true,
            error: null,
          },
        },
      });
    case 'companyFileRead': {
      const content = message.content;
      const previous: FileContentView = state.fileContents[content.path] ?? {
        path: content.path,
        pages: [],
        loaded: false,
        error: null,
      };
      // Re-reading the same offset replaces that page rather than duplicating it.
      const pages = previous.pages.some((page) => page.offset === content.offset)
        ? previous.pages.map((page) => (page.offset === content.offset ? content : page))
        : [...previous.pages, content];
      return unchanged({
        ...state,
        fileContents: {
          ...state.fileContents,
          [content.path]: { path: content.path, pages, loaded: true, error: null },
        },
      });
    }
    case 'companySessionLog':
      return unchanged({
        ...state,
        sessionLogs: {
          ...state.sessionLogs,
          [message.sessionId]: mergeSessionLog(
            state.sessionLogs[message.sessionId],
            message.sessionId,
            message.entries,
            message.replay,
          ),
        },
      });
    case 'companySessionInfo':
      return unchanged({
        ...state,
        sessionInfos: withNewerInfo(state.sessionInfos, message.sessionId, message.info),
      });
    case 'herdrAgents':
      return unchanged(
        project({
          ...state,
          herdrRoster: { agents: [...message.agents], sleeping: [...message.sleeping] },
          herdr: {
            ...state.herdr,
            loaded: true,
            available: message.available,
            reason: message.reason ?? null,
            infos: keepLive(state.herdr.infos, (paneId) =>
              message.agents.some((agent) => agent.paneId === paneId),
            ),
          },
        }),
      );
    case 'herdrScreen':
      return unchanged({ ...state, herdr: applyHerdrScreen(state.herdr, message) });
    case 'browserReaperStatus':
      return unchanged({ ...state, browserReaper: message });
    case 'herdrInfo':
      return unchanged({
        ...state,
        herdr: {
          ...state.herdr,
          infos: withNewerInfo(state.herdr.infos, message.paneId, message.info),
        },
      });
    case 'terminalAttached': {
      const previous =
        state.terminals[message.sessionId] ?? newTerminalView(message.sessionId, message.runEpoch);
      return unchanged({
        ...state,
        terminals: {
          ...state.terminals,
          [message.sessionId]: {
            ...previous,
            runEpoch: message.runEpoch,
            attached: true,
            leaseId: message.leaseId,
            cols: message.cols,
            rows: message.rows,
            frames: [],
            overflow: false,
            closedReason: null,
          },
        },
      });
    }
    case 'terminalSnapshot':
      return unchanged(applyTerminalFrame(state, message, 'snapshot'));
    case 'terminalData':
      return unchanged(applyTerminalFrame(state, message, 'data'));
    case 'terminalClosed':
      return unchanged(applyTerminalFrame(state, message, 'snapshot'));
    case 'usageLimits':
    case 'usageHistory':
    case 'usageStats':
      return unchanged({ ...state, usageSlots: reduceUsageMessage(state.usageSlots, message) });
    default:
      return unchanged(state);
  }
}

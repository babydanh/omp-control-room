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
 *    incremental collections (attempts, evidence, reports, usage) are kept
 *    across it: the server sends those only when they change, so dropping them
 *    would turn a resync into data loss. Their removals arrive as explicit
 *    `remove` changes.
 *  - Nothing here is optimistic. A command does not move a card; the card moves
 *    when the state change for it arrives.
 *
 * DOM-free and React-free on purpose: the client owns the transport, this owns
 * the rules, and the tests drive the rules directly.
 */

import type {
  Attempt,
  CompanyCounters,
  CompanyDiagnostics,
  CompanyModelCatalogEntry,
  CompanyPromptSummary,
  CompanyReport,
  CompanySessionSummary,
  CompanySettings,
  CompanySnapshot,
  Contract,
  Question,
  QuotaSnapshot,
  Task,
  UsageRecord,
  VerificationEvidence,
} from '../../../core/src/company.js';
import type {
  CompanyFileContent,
  CompanyFileEntry,
  CompanyRemoveChange,
  CompanyStateChangedMessage,
  ServerMessage,
} from '../../../core/src/messages.js';
import { type CommandResultView, viewCommandResult } from './commandResults.js';
import {
  COMPANY_TERMINAL_FRAME_QUEUE_MAX,
  COMPANY_TEXT_EXCERPT_GRAPHEMES,
  COMPANY_TEXT_STREAM_MAX_CHARS,
} from './constants.js';
import {
  applySubmitResult,
  EMPTY_PROMPT_DRAFT,
  type PromptDraftState,
} from './promptSubmission.js';
import { excerptLine } from './textExcerpt.js';

export type CompanyPutChange = Exclude<
  CompanyStateChangedMessage['changes'][number],
  CompanyRemoveChange
>;

/** What the client must do as a consequence of a reduced message. */
export type CompanyEffect =
  | { type: 'requestSnapshot' }
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
}

/**
 * Which drawer tab the selection is pointing at. `null` means "whatever the
 * drawer opens by default". It lives in the selection rather than in the
 * bubble or the board because all three surfaces ask for the same session, and
 * a click that means "show me the question it is blocked on" has to survive
 * the drawer being re-rendered by an unrelated company message.
 */
export type CompanyDrawerTab = 'terminal' | 'activity' | 'questions' | 'usage' | 'report';

export const EMPTY_SELECTION: CompanySelection = { sessionId: null, taskId: null, tab: null };

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

export interface CompanyViewState {
  /** Last revision the client can account for; null before the first snapshot. */
  revision: number | null;
  /** True when a change was missed and a snapshot has been requested. */
  needsSnapshot: boolean;
  settings: CompanySettings | null;
  prompts: CompanyPromptSummary[];
  contracts: Record<string, Contract>;
  tasks: Record<string, Task>;
  sessions: Record<string, SessionView>;
  questions: Record<string, Question>;
  attempts: Record<string, Attempt>;
  evidence: Record<string, VerificationEvidence>;
  reports: Record<string, CompanyReport>;
  /** Keyed by (nativeSessionId, nativeEntryId) so a re-sent entry cannot double count. */
  usage: Record<string, UsageRecord>;
  quotas: Record<string, QuotaSnapshot>;
  counters: CompanyCounters | null;
  diagnostics: CompanyDiagnostics | null;
  commandResults: Record<string, CommandResultView>;
  modelCatalog: CompanyModelCatalogEntry[];
  streams: Record<string, TextStreamView>;
  terminals: Record<string, TerminalView>;
  artifacts: Record<string, ArtifactView>;
  fileListings: Record<string, FileListingView>;
  fileContents: Record<string, FileContentView>;
  /** Model the user picked for the next dispatch; null means "server default". */
  selectedModel: string | null;
  selection: CompanySelection;
  /** The composer's draft, retained until the server accepts it. */
  prompt: PromptDraftState;
}

export function emptyCompanyState(): CompanyViewState {
  return {
    revision: null,
    needsSnapshot: false,
    settings: null,
    prompts: [],
    contracts: {},
    tasks: {},
    sessions: {},
    questions: {},
    attempts: {},
    evidence: {},
    reports: {},
    usage: {},
    quotas: {},
    counters: null,
    diagnostics: null,
    commandResults: {},
    modelCatalog: [],
    streams: {},
    terminals: {},
    artifacts: {},
    fileListings: {},
    fileContents: {},
    selectedModel: null,
    selection: EMPTY_SELECTION,
    prompt: EMPTY_PROMPT_DRAFT,
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

function applySnapshot(state: CompanyViewState, snapshot: CompanySnapshot): CompanyViewState {
  // A Contract embeds its tasks; the snapshot's own task list is the
  // authoritative one, and the embedded copies fill any task it omits.
  const tasks: Record<string, Task> = {};
  for (const task of snapshot.tasks) tasks[task.id] = task;
  for (const contract of snapshot.contracts) {
    for (const task of contract.tasks) {
      if (tasks[task.id] === undefined) tasks[task.id] = task;
    }
  }

  return {
    ...state,
    revision: snapshot.revision,
    needsSnapshot: false,
    settings: snapshot.settings,
    prompts: [...snapshot.prompts],
    contracts: indexById(snapshot.contracts),
    tasks,
    sessions: indexById(snapshot.sessions),
    questions: indexById(snapshot.questions),
    quotas: Object.fromEntries(snapshot.quotas.map((quota) => [quota.provider, quota])),
    diagnostics: snapshot.diagnostics ?? state.diagnostics,
  };
}

function applyChange(state: CompanyViewState, change: CompanyPutChange | CompanyRemoveChange) {
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

function applyStateChanged(
  state: CompanyViewState,
  message: CompanyStateChangedMessage,
): CompanyResult {
  // A gap is open, or we never had a baseline: neither can be repaired by
  // applying this change, so ask for the whole picture instead.
  if (state.revision === null || state.needsSnapshot) {
    if (state.needsSnapshot) return unchanged(state);
    return { state: { ...state, needsSnapshot: true }, effects: [{ type: 'requestSnapshot' }] };
  }
  if (message.revision <= state.revision) return unchanged(state);
  if (message.revision > state.revision + 1) {
    return { state: { ...state, needsSnapshot: true }, effects: [{ type: 'requestSnapshot' }] };
  }

  let next = state;
  for (const change of message.changes) next = applyChange(next, change);
  return { state: { ...next, revision: message.revision }, effects: [] };
}

function applyTextDelta(
  state: CompanyViewState,
  message: Extract<ServerMessage, { type: 'companyTextDelta' }>,
): CompanyViewState {
  const existing = state.streams[message.sessionId];
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
  if (message.seq <= base.seq) return state;
  const tail = (base.tail + message.text).slice(-COMPANY_TEXT_STREAM_MAX_CHARS);
  return {
    ...state,
    streams: {
      ...state.streams,
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

function applyCommandResult(
  state: CompanyViewState,
  message: Extract<ServerMessage, { type: 'companyCommandResult' }>,
): CompanyViewState {
  const result = viewCommandResult(message);
  return {
    ...state,
    commandResults: { ...state.commandResults, [result.requestId]: result },
    // The draft is the user's text until the server accepts it: a refused
    // prompt, a refused upload, or an answer to something else all leave it be.
    prompt: applySubmitResult(state.prompt, result),
  };
}

/**
 * Reduce one company server message. Unknown or foreign messages are ignored
 * rather than throwing: this runs inside the app's single transport handler.
 */
export function applyCompanyMessage(
  state: CompanyViewState,
  message: ServerMessage,
): CompanyResult {
  switch (message.type) {
    case 'companySnapshot':
      return unchanged(applySnapshot(state, message.snapshot));
    case 'companyStateChanged':
      return applyStateChanged(state, message);
    case 'companyCommandResult':
      return unchanged(applyCommandResult(state, message));
    case 'companyTextDelta':
      return unchanged(applyTextDelta(state, message));
    case 'companyModelCatalog':
      // The catalog is what the composer's image gate reads. A model the user
      // picked that the catalog no longer lists stays selected: the server
      // answers for it with `model_unavailable`, which is more truthful than
      // silently switching the user to something else.
      return unchanged({ ...state, modelCatalog: [...message.entries] });
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
    default:
      return unchanged(state);
  }
}

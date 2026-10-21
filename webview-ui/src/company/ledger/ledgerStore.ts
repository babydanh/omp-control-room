/**
 * Ledger client state. A pure reducer folds the server's ledger replies into
 * `LedgerState`; a store holds that state and tells React when it changes. Request
 * helpers tag each request with a fresh id and remember the newest id per kind, so a
 * reply is applied only when it answers that newest request. A late reply to a
 * superseded request is stale and dropped.
 *
 * The company board never receives `officeAccess`: it never sends `webviewReady`,
 * and that handshake would load the whole office. Privilege therefore comes from a
 * probe, the first `ledgerViewRequest` of each connection. A snapshot answers it
 * (privileged); a refusal means the connection is read-only.
 */

import { useSyncExternalStore } from 'react';

import { TRANSPORT_DISCONNECTED_ERROR } from '../../../../core/src/messageDelivery.js';
import type {
  ClientMessage,
  LedgerCommandResultMessage,
  LedgerFileDiffMessage,
  LedgerFileDiffRequestMessage,
  LedgerFileHistoryMessage,
  LedgerFileHistoryRequestMessage,
  LedgerFileTouch,
  LedgerSendMessage,
  LedgerSnapshotMessage,
  LedgerTimeline,
  LedgerTimelineMessage,
  LedgerTimelineRequestMessage,
  LedgerView,
  LedgerViewRequestMessage,
  ServerMessage,
} from '../../../../core/src/messages.js';
import { newRequestId as defaultRequestId } from '../companyMessages.js';
import type { LedgerWindow } from './ledgerFormat.js';

/** The replies the ledger store applies. Everything else on the socket is ignored. */
export type LedgerServerMessage =
  | LedgerSnapshotMessage
  | LedgerTimelineMessage
  | LedgerFileDiffMessage
  | LedgerFileHistoryMessage
  | LedgerCommandResultMessage;

/** The requests the ledger store sends. */
export type LedgerRequestMessage =
  | LedgerViewRequestMessage
  | LedgerTimelineRequestMessage
  | LedgerFileDiffRequestMessage
  | LedgerFileHistoryRequestMessage
  | LedgerSendMessage;

export type LedgerSend = (message: ClientMessage) => void;

export type LedgerDiffStatus = 'loading' | 'done' | 'failed';

export interface LedgerDiffView {
  requestId: string;
  worktree: string;
  path: string;
  status: LedgerDiffStatus;
  diff: string;
  truncated: boolean;
  reason: string | null;
}
export type LedgerFileHistoryStatus = 'loading' | 'done' | 'failed';

export interface LedgerFileHistoryView {
  requestId: string;
  path: string;
  status: LedgerFileHistoryStatus;
  entries: LedgerFileTouch[];
  reason?: string;
}

export type LedgerSendStatus = 'sending' | 'delivered' | 'refused';

export interface LedgerSendView {
  requestId: string;
  sessionId: string;
  status: LedgerSendStatus;
  reason: string | null;
  delivered: string[];
}

/** The newest request id of each kind; null when none is in flight. */
export interface LedgerLatest {
  view: string | null;
  timeline: string | null;
  diff: string | null;
  fileHistory: string | null;
}

export interface LedgerState {
  /** Null until the probe is answered; then whether this connection may change things. */
  privileged: boolean | null;
  /** Bumped on each connect, so views re-request what the old socket never answered. */
  connection: number;
  probeRequestId: string | null;
  view: LedgerView | null;
  viewError: string | null;
  timeline: LedgerTimeline | null;
  timelineWindow: LedgerWindow;
  timelineError: string | null;
  diff: LedgerDiffView | null;
  fileHistory: LedgerFileHistoryView | null;
  /** Newest last, capped at SEND_HISTORY_LIMIT. */
  sends: LedgerSendView[];
  latest: LedgerLatest;
}

export const LEDGER_DEFAULT_WINDOW: LedgerWindow = 60;

const SEND_HISTORY_LIMIT = 20;
const REFUSED_REASON = 'Máy chủ từ chối yêu cầu cây git.';
const SEND_FAILED_REASON = 'Không gửi được yêu cầu cây git.';
export const LEDGER_LOST_REASON =
  'Mất kết nối trước khi có kết quả. Chưa rõ lệnh đã được xử lý hay chưa.';
export const LEDGER_NO_CONNECTION_REASON = 'Chưa kết nối tới máy chủ, yêu cầu chưa được gửi.';

export function createInitialLedgerState(): LedgerState {
  return {
    privileged: null,
    connection: 0,
    probeRequestId: null,
    view: null,
    viewError: null,
    timeline: null,
    timelineWindow: LEDGER_DEFAULT_WINDOW,
    timelineError: null,
    diff: null,
    fileHistory: null,
    sends: [],
    latest: { view: null, timeline: null, diff: null, fileHistory: null },
  };
}

const LEDGER_SERVER_TYPES: Record<string, true> = {
  ledgerSnapshot: true,
  ledgerTimeline: true,
  ledgerFileDiff: true,
  ledgerFileHistory: true,
  ledgerCommandResult: true,
};

/** True for the ledger replies. The company whitelist does not cover them, so they are routed here. */
export function isLedgerServerMessage(message: ServerMessage): message is LedgerServerMessage {
  return Object.hasOwn(LEDGER_SERVER_TYPES, message.type);
}

/** Marks every unanswered request as lost: its reply died with the old socket. */
function settleLost(state: LedgerState): LedgerState {
  const sends = state.sends.map((send): LedgerSendView =>
    send.status === 'sending' ? { ...send, status: 'refused', reason: LEDGER_LOST_REASON } : send,
  );
  const diff: LedgerDiffView | null =
    state.diff !== null && state.diff.status === 'loading'
      ? { ...state.diff, status: 'failed', reason: LEDGER_LOST_REASON }
      : state.diff;
  const fileHistory: LedgerFileHistoryView | null =
    state.fileHistory !== null && state.fileHistory.status === 'loading'
      ? { ...state.fileHistory, status: 'failed', reason: LEDGER_LOST_REASON }
      : state.fileHistory;
  return { ...state, sends, diff, fileHistory };
}

/** Starts a connection: the probe becomes the newest view request. */
export function reduceLedgerConnect(state: LedgerState, probeRequestId: string): LedgerState {
  return {
    ...settleLost(state),
    connection: state.connection + 1,
    probeRequestId,
    viewError: null,
    latest: { view: probeRequestId, timeline: null, diff: null, fileHistory: null },
  };
}

/** Records an outgoing request as the newest of its kind, before it is sent. */
export function reduceLedgerRequest(
  state: LedgerState,
  request: LedgerRequestMessage,
): LedgerState {
  switch (request.type) {
    case 'ledgerViewRequest':
      return { ...state, viewError: null, latest: { ...state.latest, view: request.requestId } };
    case 'ledgerTimelineRequest':
      return {
        ...state,
        timelineWindow: request.windowMinutes,
        timelineError: null,
        latest: { ...state.latest, timeline: request.requestId },
      };
    case 'ledgerFileDiffRequest': {
      const diff: LedgerDiffView = {
        requestId: request.requestId,
        worktree: request.worktree,
        path: request.path,
        status: 'loading',
        diff: '',
        truncated: false,
        reason: null,
      };
      return { ...state, diff, latest: { ...state.latest, diff: request.requestId } };
    }
    case 'ledgerFileHistoryRequest': {
      const fileHistory: LedgerFileHistoryView = {
        requestId: request.requestId,
        path: request.path,
        status: 'loading',
        entries: [],
      };
      return { ...state, fileHistory, latest: { ...state.latest, fileHistory: request.requestId } };
    }
    case 'ledgerSendMessage': {
      const entry: LedgerSendView = {
        requestId: request.requestId,
        sessionId: request.sessionId,
        status: 'sending',
        reason: null,
        delivered: [],
      };
      return { ...state, sends: [...state.sends, entry].slice(-SEND_HISTORY_LIMIT) };
    }
  }
}

/** Patches one send entry by request id. Returns the same state when the id is unknown. */
function updateSend(
  state: LedgerState,
  requestId: string,
  patch: Pick<LedgerSendView, 'status' | 'reason' | 'delivered'>,
): LedgerState {
  if (!state.sends.some((send) => send.requestId === requestId)) return state;
  return {
    ...state,
    sends: state.sends.map((send) => (send.requestId === requestId ? { ...send, ...patch } : send)),
  };
}

/**
 * Settles a refused or unsendable request: marks its send entry, and clears the
 * newest-request slot it occupied, recording the reason where the view shows it.
 */
function settleRefused(state: LedgerState, requestId: string, reason: string): LedgerState {
  let next = updateSend(state, requestId, { status: 'refused', reason, delivered: [] });
  if (state.latest.view === requestId) {
    next = { ...next, viewError: reason, latest: { ...next.latest, view: null } };
  }
  if (state.latest.timeline === requestId) {
    next = { ...next, timelineError: reason, latest: { ...next.latest, timeline: null } };
  }
  if (state.latest.diff === requestId) {
    const diff: LedgerDiffView | null =
      next.diff === null ? null : { ...next.diff, status: 'failed', reason };
    next = { ...next, diff, latest: { ...next.latest, diff: null } };
  }
  if (state.latest.fileHistory === requestId) {
    const fileHistory: LedgerFileHistoryView | null =
      next.fileHistory === null
        ? null
        : { ...next.fileHistory, status: 'failed', reason };
    next = { ...next, fileHistory, latest: { ...next.latest, fileHistory: null } };
  }
  return next;
}

/** The transport refused to send a request. Nothing left the socket, so the request failed outright. */
export function reduceLedgerSendFailure(
  state: LedgerState,
  requestId: string,
  reason: string,
): LedgerState {
  const next = settleRefused(state, requestId, reason);
  return state.probeRequestId === requestId ? { ...next, probeRequestId: null } : next;
}

function reduceSnapshot(state: LedgerState, message: LedgerSnapshotMessage): LedgerState {
  if (message.requestId === undefined) {
    // A broadcast, sent to privileged sockets whenever the view changes. An older
    // view never replaces a newer one.
    if (state.view !== null && message.view.generatedAt < state.view.generatedAt) return state;
    return { ...state, view: message.view, viewError: null, privileged: true };
  }
  const isProbe = message.requestId === state.probeRequestId;
  const isLatest = message.requestId === state.latest.view;
  if (!isProbe && !isLatest) return state;
  return {
    ...state,
    view: message.view,
    viewError: null,
    privileged: true,
    probeRequestId: isProbe ? null : state.probeRequestId,
    latest: isLatest ? { ...state.latest, view: null } : state.latest,
  };
}

function reduceTimeline(state: LedgerState, message: LedgerTimelineMessage): LedgerState {
  if (message.requestId !== state.latest.timeline) return state;
  if (message.timeline.windowMinutes !== state.timelineWindow) return state;
  return {
    ...state,
    timeline: message.timeline,
    timelineError: null,
    privileged: true,
    latest: { ...state.latest, timeline: null },
  };
}

function reduceFileDiff(state: LedgerState, message: LedgerFileDiffMessage): LedgerState {
  if (message.requestId !== state.latest.diff || state.diff === null) return state;
  const diff: LedgerDiffView = {
    ...state.diff,
    status: message.ok ? 'done' : 'failed',
    diff: message.diff,
    truncated: message.truncated,
    reason: message.reason ?? null,
  };
  return { ...state, diff, privileged: true, latest: { ...state.latest, diff: null } };
}
function reduceFileHistory(
  state: LedgerState,
  message: LedgerFileHistoryMessage,
): LedgerState {
  if (
    message.requestId !== state.latest.fileHistory ||
    state.fileHistory === null ||
    message.path !== state.fileHistory.path
  ) return state;
  const fileHistory: LedgerFileHistoryView = {
    requestId: message.requestId,
    path: message.path,
    status: message.reason === undefined ? 'done' : 'failed',
    entries: message.entries,
    reason: message.reason,
  };
  return {
    ...state,
    fileHistory,
    privileged: true,
    latest: { ...state.latest, fileHistory: null },
  };
}

function reduceCommandResult(state: LedgerState, message: LedgerCommandResultMessage): LedgerState {
  let next = state;
  if (message.requestId === state.probeRequestId) {
    // A refused probe means this connection is read-only.
    next = { ...next, probeRequestId: null, privileged: message.ok };
  }
  if (message.ok) {
    const sent = updateSend(next, message.requestId, {
      status: 'delivered',
      reason: null,
      delivered: message.delivered ?? [],
    });
    return sent === next ? next : { ...sent, privileged: true };
  }
  return settleRefused(next, message.requestId, message.reason ?? REFUSED_REASON);
}

/** Folds one ledger reply into the state. Stale replies return the same state object. */
export function reduceLedgerMessage(state: LedgerState, message: LedgerServerMessage): LedgerState {
  switch (message.type) {
    case 'ledgerSnapshot':
      return reduceSnapshot(state, message);
    case 'ledgerTimeline':
      return reduceTimeline(state, message);
    case 'ledgerFileDiff':
      return reduceFileDiff(state, message);
    case 'ledgerFileHistory':
      return reduceFileHistory(state, message);
    case 'ledgerCommandResult':
      return reduceCommandResult(state, message);
  }
}

/** The state an outside reader sees. Components read it through `useLedgerState`. */
export interface LedgerStoreOptions {
  send: LedgerSend;
  /** Request ids; defaults to `newRequestId`. Tests inject a counter. */
  newRequestId?: () => string;
}

export interface LedgerStore {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => LedgerState;
  /** Folds one server message into the state; non-ledger messages are ignored. */
  accept: (message: ServerMessage) => void;
  /** Starts a connection: probes privilege and re-requests the view. */
  connect: () => void;
  requestView: () => void;
  requestTimeline: (windowMinutes: LedgerWindow) => void;
  requestFileDiff: (worktree: string, path: string) => void;
  requestFileHistory: (path: string) => string;
  /** Sends `text` to an agent. Returns the request id its result will carry. */
  sendMessage: (sessionId: string, text: string) => string;
  /** Swaps the transport. The dev fixture uses it to answer requests locally. */
  setSend: (send: LedgerSend) => void;
}

export function createLedgerStore(options: LedgerStoreOptions): LedgerStore {
  const newRequestId = options.newRequestId ?? defaultRequestId;
  let send = options.send;
  let state = createInitialLedgerState();
  const listeners = new Set<() => void>();

  function commit(next: LedgerState): void {
    if (next === state) return;
    state = next;
    for (const listener of listeners) listener();
  }

  function transmit(request: LedgerRequestMessage): string {
    commit(reduceLedgerRequest(state, request));
    try {
      send(request);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const reason =
        detail === TRANSPORT_DISCONNECTED_ERROR ? LEDGER_NO_CONNECTION_REASON : SEND_FAILED_REASON;
      commit(reduceLedgerSendFailure(state, request.requestId, reason));
    }
    return request.requestId;
  }

  return {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => state,
    accept: (message) => {
      if (isLedgerServerMessage(message)) commit(reduceLedgerMessage(state, message));
    },
    connect: () => {
      const requestId = newRequestId();
      commit(reduceLedgerConnect(state, requestId));
      transmit({ type: 'ledgerViewRequest', requestId });
    },
    requestView: () => {
      transmit({ type: 'ledgerViewRequest', requestId: newRequestId() });
    },
    requestTimeline: (windowMinutes) => {
      transmit({ type: 'ledgerTimelineRequest', requestId: newRequestId(), windowMinutes });
    },
    requestFileDiff: (worktree, path) => {
      transmit({ type: 'ledgerFileDiffRequest', requestId: newRequestId(), worktree, path });
    },
    sendMessage: (sessionId, text) =>
      transmit({ type: 'ledgerSendMessage', requestId: newRequestId(), sessionId, text }),
    requestFileHistory: (path) =>
      transmit({ type: 'ledgerFileHistoryRequest', requestId: newRequestId(), path }),
    setSend: (next) => {
      send = next;
    },
  };
}

/** The store's current state; React re-renders when it changes. */
export function useLedgerState(store: LedgerStore): LedgerState {
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}

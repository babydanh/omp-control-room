import { useSyncExternalStore } from 'react';

import { TRANSPORT_DISCONNECTED_ERROR } from '../../../../core/src/messageDelivery.js';
import type {
  ClientMessage,
  FleetCommandResultMessage,
  FleetRequestMessage,
  FleetSnapshotMessage,
  FleetTaskCreatedMessage,
  FleetTaskCreateMessage,
  FleetTerminalOpenedMessage,
  FleetTerminalOpenMessage,
  ServerMessage,
} from '../../../../core/src/messages.js';
import { newRequestId as defaultRequestId } from '../companyMessages.js';

export type FleetServerMessage =
  | FleetSnapshotMessage
  | FleetCommandResultMessage
  | FleetTerminalOpenedMessage
  | FleetTaskCreatedMessage;

/** A cloud tmux session the board is showing in its terminal panel. */
export interface FleetTerminal {
  readonly machine: string;
  readonly session: string;
  readonly terminalId: number;
}

/** One in-flight action (open a terminal / create a task); only the latest one is tracked. */
export interface FleetAction {
  readonly requestId: string;
  readonly kind: 'terminal' | 'task';
  readonly machine: string;
  readonly session: string;
}
export type FleetSend = (message: ClientMessage) => void;

export interface FleetState {
  readonly privileged: boolean | null;
  readonly connection: number;
  readonly probeRequestId: string | null;
  readonly latestRequestId: string | null;
  readonly snapshot: FleetSnapshotMessage | null;
  readonly error: string | null;
  readonly action: FleetAction | null;
  readonly actionError: string | null;
  readonly terminal: FleetTerminal | null;
  /** Set when a task was created: the machine/session to open next. */
  readonly createdTask: { readonly machine: string; readonly session: string } | null;
}

export interface FleetStoreOptions {
  readonly send: FleetSend;
  readonly newRequestId?: () => string;
}

export interface FleetStore {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => FleetState;
  accept: (message: ServerMessage) => void;
  connect: () => void;
  requestFleet: () => string;
  openTerminal: (machine: string, session: string) => void;
  closeTerminal: () => void;
  createTask: (task: Omit<FleetTaskCreateMessage, 'type' | 'requestId'>) => void;
}

const NO_CONNECTION_REASON = 'Chưa kết nối tới máy chủ, yêu cầu chưa được gửi.';
const SEND_FAILED_REASON = 'Không gửi được yêu cầu xem Cloud.';

export function createInitialFleetState(): FleetState {
  return {
    privileged: null,
    connection: 0,
    probeRequestId: null,
    latestRequestId: null,
    snapshot: null,
    error: null,
    action: null,
    actionError: null,
    terminal: null,
    createdTask: null,
  };
}

export function isFleetServerMessage(message: ServerMessage): message is FleetServerMessage {
  return (
    message.type === 'fleetSnapshot' ||
    message.type === 'fleetCommandResult' ||
    message.type === 'fleetTerminalOpened' ||
    message.type === 'fleetTaskCreated'
  );
}

export function createFleetStore(options: FleetStoreOptions): FleetStore {
  const newRequestId = options.newRequestId ?? defaultRequestId;
  const send = options.send;
  let state = createInitialFleetState();
  const listeners = new Set<() => void>();

  function commit(next: FleetState): void {
    if (next === state) return;
    state = next;
    for (const listener of listeners) listener();
  }

  function transmit(request: FleetRequestMessage): void {
    commit({ ...state, latestRequestId: request.requestId, error: null });
    try {
      send(request);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      commit({
        ...state,
        latestRequestId: null,
        error: detail === TRANSPORT_DISCONNECTED_ERROR ? NO_CONNECTION_REASON : SEND_FAILED_REASON,
      });
    }
  }

  function act(request: FleetTerminalOpenMessage | FleetTaskCreateMessage, kind: FleetAction['kind'], session: string): void {
    // One action at a time: a double click must not create two cloud tasks.
    if (state.action !== null) return;
    commit({ ...state, action: { requestId: request.requestId, kind, machine: request.machine, session }, actionError: null, createdTask: null });
    try {
      send(request);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      commit({ ...state, action: null, actionError: detail === TRANSPORT_DISCONNECTED_ERROR ? NO_CONNECTION_REASON : SEND_FAILED_REASON });
    }
  }

  function acceptAction(message: FleetServerMessage): boolean {
    const action = state.action;
    if (action === null || message.requestId !== action.requestId) return false;
    if (message.type === 'fleetTerminalOpened') {
      commit({ ...state, action: null, terminal: { machine: action.machine, session: action.session, terminalId: message.terminalId } });
    } else if (message.type === 'fleetTaskCreated') {
      commit({ ...state, action: null, createdTask: { machine: message.machine, session: message.session } });
    } else if (message.type === 'fleetCommandResult') {
      commit({ ...state, action: null, actionError: message.reason ?? SEND_FAILED_REASON });
    }
    return true;
  }

  return {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => state,
    accept: (message) => {
      if (!isFleetServerMessage(message)) return;
      if (acceptAction(message)) return;
      if (message.requestId !== state.latestRequestId) return;
      if (message.type === 'fleetSnapshot') {
        commit({
          ...state,
          privileged: true,
          probeRequestId: null,
          latestRequestId: null,
          snapshot: message,
          error: null,
        });
        return;
      }
      if (message.type !== 'fleetCommandResult') return;
      const isProbe = message.requestId === state.probeRequestId;
      commit({
        ...state,
        privileged: isProbe ? message.code !== 'forbidden' : state.privileged,
        probeRequestId: isProbe ? null : state.probeRequestId,
        latestRequestId: null,
        error: message.reason ?? SEND_FAILED_REASON,
      });
    },
    connect: () => {
      const requestId = newRequestId();
      commit({
        ...state,
        connection: state.connection + 1,
        probeRequestId: requestId,
        latestRequestId: requestId,
        error: null,
      });
      transmit({ type: 'fleetRequest', requestId });
    },
    requestFleet: () => {
      const requestId = newRequestId();
      transmit({ type: 'fleetRequest', requestId });
      return requestId;
    },
    openTerminal: (machine, session) => {
      act({ type: 'fleetTerminalOpen', requestId: newRequestId(), machine, session }, 'terminal', session);
    },
    closeTerminal: () => commit({ ...state, terminal: null }),
    createTask: (task) => {
      act({ type: 'fleetTaskCreate', requestId: newRequestId(), ...task }, 'task', task.slug);
    },
  };
}

export function useFleetState(store: FleetStore): FleetState {
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}

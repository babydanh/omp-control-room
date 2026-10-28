import { useSyncExternalStore } from 'react';

import { TRANSPORT_DISCONNECTED_ERROR } from '../../../../core/src/messageDelivery.js';
import type {
  ClientMessage,
  FleetCommandResultMessage,
  FleetRequestMessage,
  FleetSnapshotMessage,
  ServerMessage,
} from '../../../../core/src/messages.js';
import { newRequestId as defaultRequestId } from '../companyMessages.js';

export type FleetServerMessage = FleetSnapshotMessage | FleetCommandResultMessage;
export type FleetSend = (message: ClientMessage) => void;

export interface FleetState {
  readonly privileged: boolean | null;
  readonly connection: number;
  readonly probeRequestId: string | null;
  readonly latestRequestId: string | null;
  readonly snapshot: FleetSnapshotMessage | null;
  readonly error: string | null;
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
  };
}

export function isFleetServerMessage(message: ServerMessage): message is FleetServerMessage {
  return message.type === 'fleetSnapshot' || message.type === 'fleetCommandResult';
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

  return {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => state,
    accept: (message) => {
      if (!isFleetServerMessage(message) || message.requestId !== state.latestRequestId) return;
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
  };
}

export function useFleetState(store: FleetStore): FleetState {
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}

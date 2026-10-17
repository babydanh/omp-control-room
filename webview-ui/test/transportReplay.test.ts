import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TRANSPORT_DISCONNECTED_ERROR } from '../../core/src/messageDelivery.js';
import type { ClientMessage } from '../../core/src/messages.js';
import { WebSocketTransport } from '../src/transport/webSocketTransport.js';

const OPEN = 1;
const CONNECTING = 0;

/** Minimal WebSocket stand-in: the transport only touches these members. */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static CONNECTING = 0;
  static OPEN = 1;

  readyState = CONNECTING;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  readonly url: string;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
  }

  /** Drive the connection open and flush anything queued while connecting. */
  open(): void {
    this.readyState = OPEN;
    this.onopen?.();
  }
}

const originalWebSocket = globalThis.WebSocket;

const PROMPT: ClientMessage = {
  type: 'companyPromptSubmit',
  prompt: { requestId: '11111111-1111-4111-8111-111111111111', text: 'ship it', delivery: 'prompt' },
};
const TERMINAL_INPUT = {
  type: 'terminalInput',
  sessionId: '22222222-2222-4222-8222-222222222222',
  runEpoch: 0,
  data: 'ls\n',
} as unknown as ClientMessage;
const SNAPSHOT_REQUEST = {
  type: 'companySnapshotRequest',
  requestId: '33333333-3333-4333-8333-333333333333',
} as unknown as ClientMessage;

describe('WebSocketTransport replay policy', () => {
  let transport: WebSocketTransport;

  beforeEach(() => {
    FakeWebSocket.instances = [];
    (globalThis as { WebSocket: unknown }).WebSocket = FakeWebSocket;
    transport = new WebSocketTransport('ws://127.0.0.1:3100/ws');
    transport.connect();
  });

  afterEach(() => {
    transport.dispose();
    (globalThis as { WebSocket: unknown }).WebSocket = originalWebSocket;
  });

  it('throws instead of queueing a prompt sent while disconnected', () => {
    expect(() => transport.send(PROMPT)).toThrowError(TRANSPORT_DISCONNECTED_ERROR);
    expect(() => transport.send(TERMINAL_INPUT)).toThrowError(TRANSPORT_DISCONNECTED_ERROR);

    FakeWebSocket.instances[0].open();
    expect(FakeWebSocket.instances[0].sent).toHaveLength(0);
  });

  it('still queues idempotent reads and flushes them on reconnect', () => {
    transport.send(SNAPSHOT_REQUEST);
    expect(FakeWebSocket.instances[0].sent).toHaveLength(0);

    FakeWebSocket.instances[0].open();
    expect(FakeWebSocket.instances[0].sent.map((raw) => JSON.parse(raw).type)).toEqual([
      'companySnapshotRequest',
    ]);
  });

  it('does not replay a rejected prompt once the socket comes back', () => {
    expect(() => transport.send(PROMPT)).toThrow(TRANSPORT_DISCONNECTED_ERROR);

    const socket = FakeWebSocket.instances[0];
    socket.open();
    transport.send(PROMPT); // now that it is open, the UI re-sends deliberately
    expect(socket.sent.map((raw) => JSON.parse(raw).type)).toEqual(['companyPromptSubmit']);
  });
});
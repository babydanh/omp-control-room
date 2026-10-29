import type { LedgerView, ServerMessage } from '../../../core/src/messages.js';
import type { PtySessionManager } from '../terminal/ptySessionManager.js';
import { CloudControl, CloudControlError } from './cloudControl.js';
import {
  FLEET_REASON_BAD_INPUT,
  FLEET_REASON_COMMAND_FAILED,
  FLEET_REASON_NO_MACHINE,
  FLEET_REASON_NO_TERMINAL,
  FLEET_REASON_READ_ONLY,
  FLEET_REASON_UNAVAILABLE,
} from './constants.js';
import { buildFleetSnapshot } from './fleetSnapshot.js';
import { createFleetHubClient, type FleetHubClient, FleetUnavailableError } from './hubClient.js';

const FALLBACK_REQUEST_ID = '00000000-0000-4000-8000-000000000000';
const LEDGER_WAIT_MS = 5000;
const defaultFleetHubClient = createFleetHubClient();
let defaultCloudControl: CloudControl | null = null;

export interface FleetCommandContext {
  readonly fleet?: FleetHubClient;
  readonly cloud?: CloudControl;
  readonly ledger: { getView: () => Promise<LedgerView> } | null;
  readonly ptyManager?: PtySessionManager | null;
  readonly privileged: boolean;
}

const FLEET_TYPES = new Set(['fleetRequest', 'fleetTerminalOpen', 'fleetTaskCreate']);

export function handleFleetMessage(
  msg: Record<string, unknown>,
  send: (message: ServerMessage) => void,
  context: FleetCommandContext,
): boolean {
  if (typeof msg.type !== 'string' || !FLEET_TYPES.has(msg.type)) return false;
  const requestId = typeof msg.requestId === 'string' ? msg.requestId : FALLBACK_REQUEST_ID;

  if (!context.privileged) {
    send(commandResult(requestId, 'forbidden', FLEET_REASON_READ_ONLY));
    return true;
  }

  if (msg.type === 'fleetTerminalOpen') {
    openTerminal(msg, requestId, send, context);
    return true;
  }
  if (msg.type === 'fleetTaskCreate') {
    createTask(msg, requestId, send, context);
    return true;
  }

  const fleet = context.fleet ?? defaultFleetHubClient;
  // A cold ledger view can take over a minute; show the machines without local overlaps rather than wait.
  const ledgerView = context.ledger?.getView().catch(() => null) ?? Promise.resolve(null);
  const localView = Promise.race([ledgerView, new Promise<null>((resolve) => setTimeout(resolve, LEDGER_WAIT_MS, null))]);
  Promise.all([fleet.fetchFleet(), localView])
    .then(([response, view]) => send(buildFleetSnapshot(requestId, response, view)))
    .catch((error: unknown) => {
      const unavailable = error instanceof FleetUnavailableError;
      send(commandResult(requestId, unavailable ? 'unavailable' : 'failed', unavailable ? FLEET_REASON_UNAVAILABLE : FLEET_REASON_COMMAND_FAILED));
    });
  return true;
}

function cloudOf(context: FleetCommandContext): CloudControl {
  return context.cloud ?? (defaultCloudControl ??= new CloudControl());
}

function openTerminal(
  msg: Record<string, unknown>,
  requestId: string,
  send: (message: ServerMessage) => void,
  context: FleetCommandContext,
): void {
  const ptyManager = context.ptyManager;
  if (!ptyManager?.isAvailable()) {
    send(commandResult(requestId, 'unavailable', FLEET_REASON_NO_TERMINAL));
    return;
  }
  const machine = typeof msg.machine === 'string' ? msg.machine : '';
  const session = typeof msg.session === 'string' ? msg.session : '';
  cloudOf(context)
    .openTerminal(ptyManager, machine, session)
    .then((terminalId) => send({ type: 'fleetTerminalOpened', requestId, terminalId }))
    .catch((error: unknown) => send(failure(requestId, error)));
}

function createTask(
  msg: Record<string, unknown>,
  requestId: string,
  send: (message: ServerMessage) => void,
  context: FleetCommandContext,
): void {
  const machine = typeof msg.machine === 'string' ? msg.machine : '';
  const slug = typeof msg.slug === 'string' ? msg.slug : '';
  const prompt = typeof msg.prompt === 'string' ? msg.prompt : '';
  cloudOf(context)
    .createTask(machine, msg.repo, slug, prompt)
    .then((session) => send({ type: 'fleetTaskCreated', requestId, machine, session }))
    .catch((error: unknown) => send(failure(requestId, error)));
}

function failure(requestId: string, error: unknown): ServerMessage {
  if (error instanceof CloudControlError) {
    if (error.code === 'bad_input') return commandResult(requestId, 'failed', FLEET_REASON_BAD_INPUT);
    if (error.code === 'no_machine') return commandResult(requestId, 'unavailable', FLEET_REASON_NO_MACHINE);
    return commandResult(requestId, 'failed', error.message);
  }
  return commandResult(requestId, 'failed', FLEET_REASON_COMMAND_FAILED);
}

function commandResult(
  requestId: string,
  code: 'forbidden' | 'unavailable' | 'failed',
  reason: string,
): ServerMessage {
  return { type: 'fleetCommandResult', requestId, ok: false, code, reason };
}

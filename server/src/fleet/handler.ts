import type { LedgerView, ServerMessage } from '../../../core/src/messages.js';
import { FLEET_REASON_COMMAND_FAILED, FLEET_REASON_READ_ONLY, FLEET_REASON_UNAVAILABLE } from './constants.js';
import { buildFleetSnapshot } from './fleetSnapshot.js';
import { createFleetHubClient, type FleetHubClient, FleetUnavailableError } from './hubClient.js';

const FALLBACK_REQUEST_ID = '00000000-0000-4000-8000-000000000000';
const LEDGER_WAIT_MS = 5000;
const defaultFleetHubClient = createFleetHubClient();

export interface FleetCommandContext {
  readonly fleet?: FleetHubClient;
  readonly ledger: { getView: () => Promise<LedgerView> } | null;
  readonly privileged: boolean;
}

export function handleFleetMessage(
  msg: Record<string, unknown>,
  send: (message: ServerMessage) => void,
  context: FleetCommandContext,
): boolean {
  if (msg.type !== 'fleetRequest') return false;
  const requestId = typeof msg.requestId === 'string' ? msg.requestId : FALLBACK_REQUEST_ID;

  if (!context.privileged) {
    send(commandResult(requestId, 'forbidden', FLEET_REASON_READ_ONLY));
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

function commandResult(
  requestId: string,
  code: 'forbidden' | 'unavailable' | 'failed',
  reason: string,
): ServerMessage {
  return { type: 'fleetCommandResult', requestId, ok: false, code, reason };
}

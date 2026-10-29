import type { GitGuardReport, LedgerView, ServerMessage } from '../../../core/src/messages.js';
import type { PtySessionManager } from '../terminal/ptySessionManager.js';
import { CloudControl, CloudControlError } from './cloudControl.js';
import {
  FLEET_REASON_BAD_INPUT,
  FLEET_REASON_COMMAND_FAILED,
  FLEET_REASON_NO_MACHINE,
  FLEET_REASON_NO_TERMINAL,
  FLEET_REASON_NOT_REPORTED,
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
  readonly getLocalGuard?: () => GitGuardReport | null;
  readonly privileged: boolean;
}

export async function getFleetGuardRiskCounts(localGuard?: () => GitGuardReport | null) {
  const reports: (GitGuardReport | null)[] = [localGuard?.() ?? null];
  try {
    const fleet = await defaultFleetHubClient.fetchFleet();
    reports.push(...fleet.machines.map((machine) => machine.guard ?? null));
  } catch {
    // A local board status remains useful when the cloud hub is offline or unconfigured.
  }
  return reports.reduce(
    (counts, report) => {
      for (const risk of report?.risks ?? []) counts[risk.level] += 1;
      return counts;
    },
    { red: 0, yellow: 0 },
  );
}

const FLEET_TYPES = new Set([
  'fleetRequest',
  'fleetTerminalOpen',
  'fleetTaskCreate',
  'fleetLavishOpen',
  'fleetDiffRequest',
]);

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
  if (msg.type === 'fleetLavishOpen') {
    const machine = typeof msg.machine === 'string' ? msg.machine : '';
    const key = typeof msg.key === 'string' ? msg.key : '';
    cloudOf(context)
      .openLavish(machine, key)
      .then((url) => send({ type: 'fleetLavishOpened', requestId, url }))
      .catch((error: unknown) => send(failure(requestId, error)));
    return true;
  }
  if (msg.type === 'fleetDiffRequest') {
    readDiff(msg, requestId, send, context);
    return true;
  }

  const fleet = context.fleet ?? defaultFleetHubClient;
  // A cold ledger view can take over a minute; show the machines without local overlaps rather than wait.
  const ledgerView = context.ledger?.getView().catch(() => null) ?? Promise.resolve(null);
  const localView = Promise.race([ledgerView, new Promise<null>((resolve) => setTimeout(resolve, LEDGER_WAIT_MS, null))]);
  Promise.all([fleet.fetchFleet(), localView])
    .then(([response, view]) =>
      send(buildFleetSnapshot(requestId, response, view, context.getLocalGuard?.() ?? null)),
    )
    .catch(async (error: unknown) => {
      const unavailable = error instanceof FleetUnavailableError;
      const localGuard = context.getLocalGuard?.() ?? null;
      if (localGuard !== null) {
        const view = await localView;
        send({
          ...buildFleetSnapshot(requestId, { now: Date.now(), machines: [] }, view, localGuard),
          hubError: unavailable ? FLEET_REASON_UNAVAILABLE : FLEET_REASON_COMMAND_FAILED,
        });
        return;
      }
      send(
        commandResult(
          requestId,
          unavailable ? 'unavailable' : 'failed',
          unavailable ? FLEET_REASON_UNAVAILABLE : FLEET_REASON_COMMAND_FAILED,
        ),
      );
    });
  return true;
}

function cloudOf(context: FleetCommandContext): CloudControl {
  if (context.cloud) return context.cloud;
  if (defaultCloudControl === null) {
    const created = new CloudControl();
    // Port-forwards are child processes: close them with the board (a forced kill cannot run this).
    process.once('exit', () => created.dispose());
    defaultCloudControl = created;
  }
  return defaultCloudControl;
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

/** Only a path the machine itself reported to the hub may be read: the board never browses arbitrary folders. */
function readDiff(
  msg: Record<string, unknown>,
  requestId: string,
  send: (message: ServerMessage) => void,
  context: FleetCommandContext,
): void {
  const machine = typeof msg.machine === 'string' ? msg.machine : '';
  const path = typeof msg.path === 'string' ? msg.path : '';
  const fleet = context.fleet ?? defaultFleetHubClient;
  fleet
    .fetchFleet()
    .then(async (response) => {
      const reported = response.machines.some(
        (entry) => entry.agent_id === machine && entry.repos.some((repo) => repo.path === path),
      );
      if (!reported) {
        send(commandResult(requestId, 'failed', FLEET_REASON_NOT_REPORTED));
        return;
      }
      const diff = await cloudOf(context).readDiff(machine, path);
      send({ type: 'fleetDiff', requestId, machine, path, text: diff.text, truncated: diff.truncated });
    })
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

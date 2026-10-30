import type { FleetMachineSnapshot } from '../../../../core/src/messages.js';
import type { SessionFaceMood } from '../projects/projectTreeView.js';
import type { FleetState } from './fleetStore.js';

/** A cloud session active within this many seconds shows its working face. */
const CLOUD_WORKING_WITHIN_S = 60;

/** The face a cloud tmux session wears: working while it was active in the last minute, resting after. */
export function cloudFaceMood(idleSeconds: number): SessionFaceMood {
  return idleSeconds < CLOUD_WORKING_WITHIN_S ? 'work' : 'idle';
}

export interface PendingCloudRow {
  readonly machine: string;
  readonly session: string;
}

/**
 * The row to show before the machine reports the new tmux session: while the task is being created
 * (the machine may be waking up), then after it is created until the next fleet snapshot lists it.
 * The tmux session is named after the task slug, so the row matches the real one by machine and name.
 */
export function pendingCloudRow(
  fleet: Pick<FleetState, 'action' | 'createdTask'>,
  machines: readonly FleetMachineSnapshot[],
): PendingCloudRow | null {
  const target =
    fleet.action?.kind === 'task'
      ? { machine: fleet.action.machine, session: fleet.action.session }
      : fleet.createdTask;
  if (target === null) return null;
  const reported = machines.some(
    (machine) =>
      machine.agentId === target.machine && (machine.tmuxSessions ?? []).some((session) => session.name === target.session),
  );
  return reported ? null : { machine: target.machine, session: target.session };
}

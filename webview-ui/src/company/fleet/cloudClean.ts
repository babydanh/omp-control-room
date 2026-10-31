import type { FleetMachineSnapshot } from '../../../../core/src/messages.js';
import { cloudFolderKey } from './cloudFolders.js';

/** A removed task is hidden at most this long, even when its machine never reports it gone (paused, or offline). */
export const CLOUD_CLEAN_HIDE_MS = 5 * 60_000;

/**
 * Removed cloud tasks (key = machine/session, value = when) stay hidden until the machine's own report agrees:
 * its tmux listing and repositories no longer name the task. A machine that stopped reporting cannot say so,
 * so the hide time ends it instead. `settled` are the keys to forget for good (also from the remembered sessions).
 */
export function settleCleaned(
  pending: ReadonlyMap<string, number>,
  machines: readonly FleetMachineSnapshot[],
  now: number,
): { remaining: Map<string, number>; settled: string[] } {
  const remaining = new Map<string, number>();
  const settled: string[] = [];
  for (const [key, at] of pending) {
    const gone = machines.some(
      (machine) =>
        machine.state === 'online' &&
        machine.tmuxSessions !== undefined &&
        !machine.tmuxSessions.some((session) => cloudFolderKey(machine.agentId, session.name) === key) &&
        !machine.repos.some((repo) => repo.branch === `cloud/${key.replace('/', '-')}`),
    );
    if (gone || now - at > CLOUD_CLEAN_HIDE_MS) settled.push(key);
    else remaining.set(key, at);
  }
  return { remaining, settled };
}

/**
 * sessionActions: which lifecycle controls a session's status actually offers.
 *
 * The drawer must not show a button the server would refuse. Pause is for a
 * running session; resume is for one that is stopped, crashed or parked;
 * archive only exists for a session with nothing in flight, because archiving
 * frees a pool slot and that is not a thing to do to a running worker.
 *
 * The status strings come from the wire, so an unknown status falls back to the
 * conservative set (nothing) rather than to a full row of buttons.
 */

export interface SessionControlSet {
  pause: boolean;
  resume: boolean;
  kill: boolean;
  restart: boolean;
  archive: boolean;
}

const NONE: SessionControlSet = {
  pause: false,
  resume: false,
  kill: false,
  restart: false,
  archive: false,
};

const CONTROLS_BY_STATUS: Readonly<Record<string, SessionControlSet>> = {
  parked: { ...NONE, resume: true, restart: true },
  starting: { ...NONE, kill: true },
  idle: { ...NONE, pause: true, restart: true, kill: true, archive: true },
  busy: { ...NONE, pause: true, kill: true },
  waiting_input: { ...NONE, pause: true, kill: true },
  pausing: { ...NONE },
  paused: { ...NONE, resume: true, restart: true, kill: true, archive: true },
  stopping: { ...NONE },
  stopped: { ...NONE, resume: true, restart: true },
  crashed: { ...NONE, resume: true, restart: true },
  archived: { ...NONE },
};

export function sessionControls(status: string): SessionControlSet {
  return CONTROLS_BY_STATUS[status] ?? NONE;
}

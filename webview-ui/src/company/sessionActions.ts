/**
 * sessionActions: which lifecycle controls a session's status actually offers,
 * and what its terminal may do.
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

/** What a session's terminal may do, and what the drawer shows in its place. */
export interface TerminalPolicy {
  /** Whether a terminal lease may be taken: only for a session with a live process. */
  attach: boolean;
  /** Whether the drawer offers "Tiếp tục" in place of the terminal. */
  resume: boolean;
  /** The Vietnamese line shown when there is no terminal to attach; null when attaching. */
  message: string | null;
}

const LIVE: TerminalPolicy = { attach: true, resume: false, message: null };

const TERMINAL_POLICY_BY_STATUS: Readonly<Record<string, TerminalPolicy>> = {
  starting: LIVE,
  idle: LIVE,
  busy: LIVE,
  waiting_input: LIVE,
  parked: {
    attach: false,
    resume: true,
    message: 'Phiên đang được tạm trữ, nên không có tiến trình nào để mở. Tiếp tục để chạy lại.',
  },
  paused: {
    attach: false,
    resume: true,
    message: 'Phiên đang tạm dừng. Tiếp tục để mở lại bảng điều khiển.',
  },
  stopped: {
    attach: false,
    resume: true,
    message: 'Phiên đã dừng. Tiếp tục để chạy lại và mở bảng điều khiển.',
  },
  crashed: {
    attach: false,
    resume: true,
    message: 'Tiến trình của phiên đã sập. Tiếp tục để chạy lại và mở bảng điều khiển.',
  },
  pausing: {
    attach: false,
    resume: false,
    message: 'Phiên đang tạm dừng. Bảng điều khiển sẽ đóng khi xong.',
  },
  stopping: {
    attach: false,
    resume: false,
    message: 'Phiên đang dừng. Bảng điều khiển sẽ đóng khi xong.',
  },
  archived: {
    attach: false,
    resume: false,
    message: 'Phiên đã được lưu trữ, nên không còn tiến trình nào.',
  },
};

const UNKNOWN_POLICY: TerminalPolicy = {
  attach: false,
  resume: false,
  message: 'Trạng thái phiên không xác định, nên không mở bảng điều khiển.',
};

export function terminalPolicy(status: string): TerminalPolicy {
  return TERMINAL_POLICY_BY_STATUS[status] ?? UNKNOWN_POLICY;
}

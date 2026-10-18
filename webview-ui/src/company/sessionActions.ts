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

import type { CompanySessionSummary } from '../../../core/src/company.js';

export interface SessionControlSet {
  interrupt: boolean;
  pause: boolean;
  resume: boolean;
  kill: boolean;
  restart: boolean;
  archive: boolean;
}

const NONE: SessionControlSet = {
  interrupt: false,
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
  busy: { ...NONE, interrupt: true, pause: true, kill: true },
  waiting_input: { ...NONE, interrupt: true, pause: true, kill: true },
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

/** Statuses in which a session has a run or a turn in flight, so it holds work. */
const WORKING_STATUSES: Readonly<Record<string, true>> = {
  starting: true,
  busy: true,
  waiting_input: true,
  pausing: true,
  stopping: true,
};

/** Why delete is refused while a session holds work; the menu and the drawer show it. */
export const HOLDS_WORK_REASON = 'Phiên đang giữ việc nên chưa xoá được.';

/** Shown in a delete confirm: the omp session file and the board log go with the session. */
export const DELETE_CONFIRM_DETAIL =
  'File phiên omp và nhật ký của bảng cũng bị xoá. Không thể hoàn tác.';

/** The line shown when the server refuses a command and gives no message of its own. */
export const REFUSED_NOTICE = 'Máy chủ từ chối lệnh này.';

/**
 * Whether a session holds work the server will not let go of: a task attached, a
 * question still waiting on the user, or a run in flight. Delete is refused for one.
 */
export function sessionHoldsWork(
  session: Pick<CompanySessionSummary, 'status' | 'activeTaskId'>,
  questionPending: boolean,
): boolean {
  return (
    session.activeTaskId !== undefined ||
    questionPending ||
    WORKING_STATUSES[session.status] === true
  );
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

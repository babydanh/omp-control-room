/**
 * sessionStop: ends a live ledger session the Project tree lists, by its process.
 *
 * The ledger records each agent process (omp, Claude, agy) with its pid. Stopping
 * kills that process and the ones it started (shells, test runs), the way closing
 * its terminal would; a herdr pane falls back to its shell. A subagent shares its
 * parent's process, so it cannot be stopped alone. The board never stops itself.
 */

import type { SessionRow } from '../ledger/ledgerDb.js';
import { LibraryUserError } from '../library/libraryError.js';

export interface SessionStopDeps {
  /** The ledger's session rows, live and ended. */
  readonly sessionRows: () => readonly SessionRow[];
  /** Whether a process with this pid is running. */
  readonly isAlive: (pid: number) => boolean;
  /** Ends a process and its children. */
  readonly killTree: (pid: number) => void;
  /** The board's own pid, never stopped. */
  readonly selfPid: number;
}

export function stopLedgerSession(sessionId: string, deps: SessionStopDeps): void {
  const row = deps.sessionRows().find((candidate) => candidate.sessionId === sessionId);
  if (row === undefined || row.endedAt !== null) throw new LibraryUserError('Phiên này đã kết thúc.');
  if (row.agentKind?.toLowerCase() === 'sub') {
    throw new LibraryUserError('Subagent chạy chung tiến trình với phiên cha: tắt phiên cha để dừng nó.');
  }
  const pid = row.pid;
  if (pid === null || !Number.isInteger(pid) || pid <= 0) throw new LibraryUserError('Sổ hoạt động không ghi tiến trình của phiên này.');
  if (pid === deps.selfPid) throw new LibraryUserError('Đây là tiến trình của chính board.');
  if (!deps.isAlive(pid)) throw new LibraryUserError('Tiến trình của phiên đã dừng.');
  deps.killTree(pid);
}

/** `process.kill(pid, 0)` probes without signalling; it throws when no such process runs. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process runs but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

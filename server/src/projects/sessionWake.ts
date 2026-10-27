/**
 * sessionWake: reopens a main session that exited lately, where it ran.
 *
 * The ledger keeps an ended session for a day (see withRecentlyEnded), with its folder and its
 * transcript. An omp session a board chat ran reopens as that board chat, so one transcript never
 * gets two processes. Any other omp or Claude Code session resumes in a new herdr tab: omp from its
 * file, Claude Code from its id. A session already reopened under the same herdr agent name is that
 * same wake asked twice: its pane is returned and no second agent starts.
 */

import type { SessionRow } from '../ledger/ledgerDb.js';
import { LibraryUserError } from '../library/libraryError.js';
import { engineForLedger } from './projectTree.js';

export interface SessionWakeDeps {
  /** The ledger's session rows, live and ended. */
  readonly sessionRows: () => readonly SessionRow[];
  /** Reopens the board chat that ran this omp session, if one did. */
  readonly reopenBoardChat?: (input: {
    readonly nativeSessionId: string;
    readonly cwd: string;
    readonly prompt: string;
  }) => Promise<{ readonly folder: string; readonly sessionId: string } | undefined>;
  /** Opens an agent in a new herdr tab in `cwd`; resolves with its pane id. */
  readonly startAgent: (input: {
    readonly cwd: string;
    readonly kind: 'omp' | 'claude';
    readonly name: string;
    readonly args: readonly string[];
    readonly prompt: string;
  }) => Promise<string>;
  /** The live herdr agent under this name, if any. */
  readonly findAgent: (name: string) => { readonly paneId: string } | undefined;
  /** Whether the folder still exists. */
  readonly isDirectory: (folder: string) => boolean;
}

/** Where the woken session runs: a herdr pane, or a board chat in a board folder. */
export type SessionWakeTarget =
  | { readonly paneId: string }
  | { readonly boardSessionId: string; readonly folder: string };

/** Reopens the ended session and resolves with where it runs now. */
export async function wakeEndedSession(sessionId: string, prompt: string, deps: SessionWakeDeps): Promise<SessionWakeTarget> {
  const row = deps.sessionRows().find((candidate) => candidate.sessionId === sessionId);
  if (row === undefined) throw new LibraryUserError('Sổ hoạt động không còn ghi phiên này.');
  if (row.endedAt === null) throw new LibraryUserError('Phiên này vẫn đang chạy.');
  if (row.agentKind?.toLowerCase() === 'sub') throw new LibraryUserError('Subagent không mở lại riêng được: hãy mở lại phiên cha.');
  const engine = engineForLedger(row);
  if (engine !== 'omp' && engine !== 'claude') throw new LibraryUserError('Board chỉ mở lại được phiên omp và Claude.');
  const cwd = row.cwd;
  if (cwd === null || cwd === '' || !deps.isDirectory(cwd)) throw new LibraryUserError('Thư mục của phiên không còn nữa.');
  if (engine === 'omp' && deps.reopenBoardChat !== undefined) {
    const board = await deps.reopenBoardChat({ nativeSessionId: sessionId, cwd, prompt });
    if (board !== undefined) return { boardSessionId: board.sessionId, folder: board.folder };
  }
  // omp finds the session exactly by its file; Claude Code by its id.
  const resume = engine === 'omp' && row.sessionFile ? row.sessionFile : sessionId;
  // The id's last characters: an omp id starts with its time, so two sessions of one minute share the first ones.
  const name = `${engine}-${sessionId.toLowerCase().replace(/[^a-z0-9]/g, '').slice(-8)}`;
  const running = deps.findAgent(name);
  if (running !== undefined) return { paneId: running.paneId };
  return { paneId: await deps.startAgent({ cwd, kind: engine, name, args: ['--resume', resume], prompt }) };
}

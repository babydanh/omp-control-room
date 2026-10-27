/**
 * sessionWake: reopens a main session that exited lately, in a new herdr tab that resumes its own
 * transcript.
 *
 * The ledger keeps an ended session for a day (see withRecentlyEnded), with its folder and its
 * transcript. omp resumes from that file, Claude Code from its session id. A session already
 * reopened under the same herdr agent name is that same wake asked twice: its pane is returned and
 * no second agent starts.
 */

import type { SessionRow } from '../ledger/ledgerDb.js';
import { LibraryUserError } from '../library/libraryError.js';
import { engineForLedger } from './projectTree.js';

export interface SessionWakeDeps {
  /** The ledger's session rows, live and ended. */
  readonly sessionRows: () => readonly SessionRow[];
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

/** Reopens the ended session and resolves with the herdr pane it runs in. */
export async function wakeEndedSession(sessionId: string, prompt: string, deps: SessionWakeDeps): Promise<string> {
  const row = deps.sessionRows().find((candidate) => candidate.sessionId === sessionId);
  if (row === undefined) throw new LibraryUserError('Sổ hoạt động không còn ghi phiên này.');
  if (row.endedAt === null) throw new LibraryUserError('Phiên này vẫn đang chạy.');
  if (row.agentKind?.toLowerCase() === 'sub') throw new LibraryUserError('Subagent không mở lại riêng được: hãy mở lại phiên cha.');
  const engine = engineForLedger(row);
  if (engine !== 'omp' && engine !== 'claude') throw new LibraryUserError('Board chỉ mở lại được phiên omp và Claude.');
  const cwd = row.cwd;
  if (cwd === null || cwd === '' || !deps.isDirectory(cwd)) throw new LibraryUserError('Thư mục của phiên không còn nữa.');
  // omp finds the session exactly by its file; Claude Code by its id.
  const resume = engine === 'omp' && row.sessionFile ? row.sessionFile : sessionId;
  // The id's last characters: an omp id starts with its time, so two sessions of one minute share the first ones.
  const name = `${engine}-${sessionId.toLowerCase().replace(/[^a-z0-9]/g, '').slice(-8)}`;
  const running = deps.findAgent(name);
  if (running !== undefined) return running.paneId;
  return deps.startAgent({ cwd, kind: engine, name, args: ['--resume', resume], prompt });
}

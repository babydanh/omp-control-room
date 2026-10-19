/**
 * Links a ledger session to the board session that runs it. Both sides record the same
 * omp session id: the board's `nativeSessionId` and the ledger's `sessionId`. Only an
 * exact, unique match counts. A guess would open the wrong agent, so an ambiguous or
 * missing match returns null and the view offers no drawer link.
 */

import { sessionShortCode } from '../agentSidebarView.js';
import { ROLE_LABELS } from '../roleProfiles.js';

/** The board's sessions, keyed the way `selectSession` takes them, with the name the board shows. */
export type BoardSessionIndex = Readonly<
  Record<string, { nativeSessionId?: string | undefined; label?: string | undefined }>
>;

/** The board fields the index reads; a `SessionView` satisfies it. */
export type BoardSessionSource = Readonly<
  Record<
    string,
    { code: string; role: keyof typeof ROLE_LABELS; nativeSessionId?: string | undefined }
  >
>;

/** The board's sessions as the ledger needs them: native id, and the label "S2 · Phiên chat". */
export function boardSessionIndex(sessions: BoardSessionSource): BoardSessionIndex {
  return Object.fromEntries(
    Object.entries(sessions).map(([key, session]) => [
      key,
      {
        nativeSessionId: session.nativeSessionId,
        label: `${sessionShortCode(session.code)} · ${ROLE_LABELS[session.role]}`,
      },
    ]),
  );
}

export function boardSessionFor(sessionId: string, sessions: BoardSessionIndex): string | null {
  const matches = Object.keys(sessions).filter(
    (key) => sessions[key]?.nativeSessionId === sessionId,
  );
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

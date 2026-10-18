/**
 * Links a ledger session to the board session that runs it. Both sides record the same
 * omp session id: the board's `nativeSessionId` and the ledger's `sessionId`. Only an
 * exact, unique match counts. A guess would open the wrong agent, so an ambiguous or
 * missing match returns null and the view offers no drawer link.
 */

/** The board's sessions, keyed the way `selectSession` takes them. */
export type BoardSessionIndex = Readonly<Record<string, { nativeSessionId?: string }>>;

export function boardSessionFor(sessionId: string, sessions: BoardSessionIndex): string | null {
  const matches = Object.keys(sessions).filter(
    (key) => sessions[key].nativeSessionId === sessionId,
  );
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

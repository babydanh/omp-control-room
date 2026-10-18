import { useEffect, useRef } from 'react';

import { sessionIdsNeedingLog } from './agentSidebarView.js';
import type { CompanyClient } from './companyClient.js';
import type { CompanyViewState } from './companyState.js';

/**
 * Asks the server once for the log of every live session the board has none
 * for. A log otherwise arrives only as new entries happen or when a drawer opens,
 * so after a reload the sidebar would have no line to show for a quiet agent.
 */
export function useSessionLogBackfill(client: CompanyClient, state: CompanyViewState): void {
  const requested = useRef(new Set<string>());
  useEffect(() => {
    for (const sessionId of sessionIdsNeedingLog(state)) {
      if (requested.current.has(sessionId)) continue;
      if (client.requestSessionLog(sessionId).ok) requested.current.add(sessionId);
    }
  }, [client, state]);
}

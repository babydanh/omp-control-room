/**
 * useCompanyState: binds the company client to React.
 *
 * The client's state is an immutable snapshot that only changes when a server
 * message (or a local view action) replaced it, which is exactly what
 * `useSyncExternalStore` wants: no copies, no effect-driven setState, and the
 * board re-renders when the company changed rather than when a timer fired.
 *
 * There is deliberately no transport subscription here. The app has one
 * (useCompanyTransport) and it feeds the client.
 */

import { useSyncExternalStore } from 'react';

import type { CompanyClient } from './companyClient.js';
import type { CompanyViewState } from './companyState.js';

export function useCompanyState(client: CompanyClient): CompanyViewState {
  return useSyncExternalStore(client.subscribe, client.getState, client.getState);
}

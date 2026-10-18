/**
 * The ledger store, bound to the board's transport. useCompanyTransport feeds it every
 * server message and connects it on mount and on each reconnect.
 *
 * In a DEV build, `window.applyLedgerFixture()` replaces the transport with the local
 * fixture responder (see ledgerFixture.ts).
 */

import { transport } from '../../transport/index.js';
import { applyLedgerFixture } from './ledgerFixture.js';
import { createLedgerStore } from './ledgerStore.js';

export const ledgerStore = createLedgerStore({ send: (message) => transport.send(message) });

if (import.meta.env.DEV) {
  Object.assign(window, { applyLedgerFixture: () => applyLedgerFixture(ledgerStore) });
}

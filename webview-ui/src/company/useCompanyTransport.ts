/**
 * useCompanyTransport: the board's one subscription to the server.
 *
 * Company and ledger traffic is handed to the client and the ledger store; everything
 * else the server still sends (office layout, Claude agents, assets) has no reader on
 * the board and is dropped here. A connect -- first mount or a reconnect -- asks for a
 * fresh snapshot, because changes made while the socket was down were never delivered.
 */

import { useEffect } from 'react';

import { TRANSPORT_STATE_CONNECTED } from '../../../core/src/constants.js';
import type { ServerMessage } from '../../../core/src/messages.js';
import { transport } from '../transport/index.js';
import type { CompanyClient } from './companyClient.js';
import { isCompanyServerMessage } from './companyMessages.js';
import { ledgerStore } from './ledger/ledgerClient.js';

export function useCompanyTransport(client: CompanyClient): void {
  useEffect(() => {
    const unsubscribe = transport.onMessage((message: ServerMessage) => {
      ledgerStore.accept(message);
      if (isCompanyServerMessage(message)) client.accept(message);
    });
    client.connect();
    ledgerStore.connect();
    const unsubscribeState = transport.onStateChange((state) => {
      if (state === TRANSPORT_STATE_CONNECTED) {
        client.connect();
        ledgerStore.connect();
      }
    });
    return () => {
      unsubscribe();
      unsubscribeState();
    };
  }, [client]);
}

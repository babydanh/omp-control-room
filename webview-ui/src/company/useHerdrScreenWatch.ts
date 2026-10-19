/**
 * useHerdrScreenWatch: keeps the server pushing a herdr pane's screen while `live`. The server ends
 * a watch that goes unrenewed, so this renews it on a timer, and ends it when the screen stops being
 * live: the reader looked away, or holds a selection in it.
 */

import { useEffect } from 'react';

import type { CompanyClient } from './companyClient.js';
import { HERDR_WATCH_RENEW_MS } from './constants.js';

export function useHerdrScreenWatch(client: CompanyClient, paneId: string, live: boolean): void {
  useEffect(() => {
    if (!live) return undefined;
    client.herdrWatch(paneId, true);
    const renew = window.setInterval(() => client.herdrWatch(paneId, true), HERDR_WATCH_RENEW_MS);
    return () => {
      window.clearInterval(renew);
      client.herdrWatch(paneId, false);
    };
  }, [client, paneId, live]);
}

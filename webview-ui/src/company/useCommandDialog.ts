import { useState } from 'react';

import { failureNotice } from './commandResults.js';
import type { CompanyClient, CompanyCommandHandle } from './companyClient.js';

/**
 * Sends a dialog's command and follows it to its verdict: a refusal stays in the dialog as a
 * notice, and an accepted command runs `onAccepted`. `pending` holds while the verdict is awaited.
 */
export function useCommandDialog(client: CompanyClient, onAccepted?: () => void) {
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  async function run(handle: CompanyCommandHandle, fallback: string): Promise<void> {
    const refused = failureNotice(handle, fallback);
    if (refused !== null) {
      setNotice(refused);
      return;
    }
    setPending(true);
    setNotice(null);
    const verdict = await client.waitForCommand(handle);
    setPending(false);
    if (verdict.ok) {
      onAccepted?.();
      return;
    }
    setNotice(failureNotice(verdict, fallback));
  }

  return { pending, notice, run };
}

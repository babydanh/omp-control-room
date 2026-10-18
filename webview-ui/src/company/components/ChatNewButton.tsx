/**
 * ChatNewButton: "Phiên mới". Opens a new omp chat in the folder with no prompt. The new
 * session is selected once the server names it, and its terminal is then the view to show.
 * A refusal is shown under the button, because the composer's notice is not on this screen.
 */

import { useState } from 'react';

import { failureNotice } from '../commandResults.js';
import type { CompanyClient } from '../companyClient.js';
import { startNewChat } from '../composerRouting.js';
import { CompanyButton } from './CompanyButton.js';

export interface ChatNewButtonProps {
  client: CompanyClient;
  disabled?: boolean;
}

export function ChatNewButton({ client, disabled = false }: ChatNewButtonProps) {
  const [notice, setNotice] = useState<string | null>(null);
  const onClick = () => {
    setNotice(null);
    void startNewChat(client).then((verdict) => {
      setNotice(failureNotice(verdict, 'Chưa mở được phiên mới.'));
    });
  };
  return (
    <span className="inline-flex min-w-0 flex-col items-start">
      <CompanyButton size="sm" variant="default" disabled={disabled} onClick={onClick}>
        Phiên mới
      </CompanyButton>
      {notice !== null && (
        <span className="mt-1 text-2xs text-warning" data-testid="chat-new-notice">
          {notice}
        </span>
      )}
    </span>
  );
}

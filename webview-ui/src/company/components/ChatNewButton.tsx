/**
 * ChatNewButton: "Phiên mới" opens a new omp chat in the folder with no prompt, and
 * "Chọn thư mục…" opens the folder browser to start that chat in another folder. The
 * new session is selected once the server names it, and its terminal is then the view
 * to show. A refusal is shown under the buttons, because the composer's notice is not
 * on this screen.
 */

import { useState, useSyncExternalStore } from 'react';

import { failureNotice } from '../commandResults.js';
import type { CompanyClient } from '../companyClient.js';
import { startNewChat } from '../composerRouting.js';
import { FOLDER_LIST_LOADING_MESSAGE, folderListLoading } from '../folderView.js';
import { CompanyButton } from './CompanyButton.js';
import { FolderBrowserDialog } from './FolderBrowserDialog.js';

export interface ChatNewButtonProps {
  client: CompanyClient;
  disabled?: boolean;
}

export function ChatNewButton({ client, disabled = false }: ChatNewButtonProps) {
  const state = useSyncExternalStore(client.subscribe, client.getState);
  const [notice, setNotice] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const loading = folderListLoading(state);
  const blocked = disabled || loading;
  const onClick = () => {
    setNotice(null);
    void startNewChat(client).then((verdict) => {
      setNotice(failureNotice(verdict, 'Chưa mở được phiên mới.'));
    });
  };
  return (
    <span className="inline-flex min-w-0 flex-col items-start">
      <span className="inline-flex items-center gap-1">
        <CompanyButton size="sm" variant="default" disabled={blocked} onClick={onClick}>
          Phiên mới
        </CompanyButton>
        <CompanyButton
          type="button"
          size="sm"
          variant="default"
          data-testid="chat-new-folder"
          disabled={blocked}
          onClick={() => setPickerOpen(true)}
        >
          Chọn thư mục…
        </CompanyButton>
      </span>
      {loading && (
        <span role="status" className="mt-1 text-2xs text-text-muted">
          {FOLDER_LIST_LOADING_MESSAGE}
        </span>
      )}
      {notice !== null && (
        <span className="mt-1 text-2xs text-warning" data-testid="chat-new-notice">
          {notice}
        </span>
      )}
      {pickerOpen && (
        <FolderBrowserDialog
          client={client}
          state={state}
          purpose="new-session"
          onClose={() => setPickerOpen(false)}
        />
      )}
    </span>
  );
}

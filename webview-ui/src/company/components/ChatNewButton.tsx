/**
 * ChatNewButton: "+ Phiên mới" opens a new omp chat in the folder the board shows, with
 * no prompt. With no folder open there is nowhere to start it, so the same button opens
 * the folder browser instead, and the chat starts once a folder is chosen there. The new
 * session is selected once the server names it. A refusal shows as a notice under the
 * button. On a narrow bar the button is a bare plus, named by its label.
 */

import { useState, useSyncExternalStore } from 'react';

import { failureNotice } from '../commandResults.js';
import type { CompanyClient } from '../companyClient.js';
import { startNewChat } from '../composerRouting.js';
import { focusFolder, FOLDER_LIST_LOADING_MESSAGE, folderListLoading } from '../folderView.js';
import { CompanyButton } from './CompanyButton.js';
import { FloatingNotice } from './FloatingNotice.js';
import { FolderBrowserDialog } from './FolderBrowserDialog.js';
import { Icon } from './Icon.js';

export interface ChatNewButtonProps {
  client: CompanyClient;
  disabled?: boolean;
  /** A bare plus, named by its label, for a narrow bar. */
  compact?: boolean;
}

export function ChatNewButton({ client, disabled = false, compact = false }: ChatNewButtonProps) {
  const state = useSyncExternalStore(client.subscribe, client.getState);
  const [notice, setNotice] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const loading = folderListLoading(state);
  const blocked = disabled || loading;
  /** With no folder open the new chat has nowhere to go, so the folder browser comes first. */
  const pickFolderFirst = !loading && focusFolder(state) === null;
  const label = loading ? 'Đang tải…' : 'Phiên mới';
  let title = 'Mở phiên mới trong thư mục đang xem';
  if (loading) title = FOLDER_LIST_LOADING_MESSAGE;
  else if (pickFolderFirst) title = 'Chọn thư mục để bắt đầu phiên mới';
  const onClick = () => {
    setNotice(null);
    if (pickFolderFirst) {
      setPickerOpen(true);
      return;
    }
    void startNewChat(client).then((verdict) => {
      setNotice(failureNotice(verdict, 'Chưa mở được phiên mới.'));
    });
  };
  return (
    <div className="relative flex shrink-0 items-center">
      {compact ? (
        <button
          type="button"
          aria-label={label}
          title={title}
          disabled={blocked}
          onClick={onClick}
          className="company-icon-btn touch-target shrink-0 px-2 text-sm disabled:cursor-default disabled:opacity-50"
        >
          <Icon name="plus" />
        </button>
      ) : (
        <CompanyButton
          size="sm"
          variant="default"
          title={title}
          disabled={blocked}
          onClick={onClick}
        >
          {loading ? label : '+ Phiên mới'}
        </CompanyButton>
      )}
      {notice !== null && (
        <FloatingNotice align="right" testId="chat-new-notice" onClose={() => setNotice(null)}>
          {notice}
        </FloatingNotice>
      )}
      {pickerOpen && (
        <FolderBrowserDialog
          client={client}
          state={state}
          purpose="new-session"
          onClose={() => setPickerOpen(false)}
        />
      )}
    </div>
  );
}

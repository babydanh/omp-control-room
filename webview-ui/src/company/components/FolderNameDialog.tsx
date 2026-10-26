/**
 * FolderNameDialog: renames a folder's display name. An empty name clears it, and the
 * folder then shows its own name again. The name rules are checked here only for an
 * inline hint; the server's refusal is what the dialog reports.
 */

import {
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';

import { failureNotice } from '../commandResults.js';
import type { CompanyClient } from '../companyClient.js';
import { defaultFolderName, folderNameError } from '../folderName.js';
import { CompanyButton } from './CompanyButton.js';

export interface FolderNameDialogProps {
  client: CompanyClient;
  /** The folder's canonical path, as the server sent it. */
  path: string;
  /** The display name the folder has now; null when it has none and shows its own name. */
  currentName: string | null;
  onClose: () => void;
}

const RENAME_FALLBACK = 'Chưa đổi được tên thư mục.';
const CLEAR_HINT = 'Để trống để bỏ tên hiển thị và dùng tên thư mục.';

export function FolderNameDialog({ client, path, currentName, onClose }: FolderNameDialogProps) {
  const [name, setName] = useState(currentName ?? defaultFolderName(path));
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [opener] = useState<Element | null>(() => document.activeElement);
  const inputRef = useRef<HTMLInputElement>(null);
  const problem = name.trim() === '' ? null : folderNameError(name.trim());

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  useEffect(() => {
    return () => {
      if (opener instanceof HTMLElement && opener !== document.body && opener.isConnected) {
        opener.focus();
      }
    };
  }, [opener]);

  async function save(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (pending || problem !== null) return;
    setPending(true);
    setNotice(null);
    const verdict = await client.waitForCommand(client.renameFolder(path, name.trim()));
    if (verdict.ok) {
      onClose();
      return;
    }
    setPending(false);
    setNotice(failureNotice(verdict, RENAME_FALLBACK));
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    if (event.key !== 'Escape' || event.nativeEvent.isComposing) return;
    event.preventDefault();
    event.stopPropagation();
    onClose();
  }

  const dialog = (
    // The company scale (spacing, text sizes) and reduced motion live on .company-ui.
    <div className="company-ui">
      <div className="fixed inset-0 z-40 flex items-center justify-center">
        <button
          type="button"
          aria-label="Đóng đổi tên"
          onClick={onClose}
          className="absolute inset-0 cursor-default bg-black/40"
        />
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="folder-name-title"
          onKeyDown={onKeyDown}
          className="relative flex w-[min(360px,92vw)] flex-col gap-3 overflow-hidden rounded-(--company-radius-md) bg-panel p-3 text-xs text-text max-md:w-full max-md:rounded-none"
        >
          <header className="flex flex-col gap-0.5">
            <h2 id="folder-name-title" className="text-sm text-text">
              Đổi tên thư mục
            </h2>
            <p className="truncate text-2xs text-text-muted" title={path}>
              {path}
            </p>
          </header>
          <form onSubmit={save} className="flex flex-col gap-2">
            <label className="flex flex-col gap-1 text-text-muted">
              Tên hiển thị
              <input
                ref={inputRef}
                aria-describedby="folder-name-hint"
                aria-invalid={problem !== null}
                value={name}
                disabled={pending}
                onChange={(event) => setName(event.target.value)}
                className="touch-target rounded-(--company-radius-sm) bg-well px-2 py-1 text-xs text-text disabled:text-text-muted"
              />
            </label>
            <p
              id="folder-name-hint"
              className={`text-2xs ${problem === null ? 'text-text-muted' : 'text-danger'}`}
            >
              {problem ?? CLEAR_HINT}
            </p>
            {notice !== null && (
              <p role="alert" className="text-danger">
                {notice}
              </p>
            )}
            <div className="flex justify-end gap-1">
              <CompanyButton type="button" size="sm" onClick={onClose}>
                Hủy
              </CompanyButton>
              <CompanyButton
                type="submit"
                size="sm"
                variant="accent"
                disabled={pending || problem !== null}
              >
                Lưu
              </CompanyButton>
            </div>
          </form>
        </div>
      </div>
    </div>
  );

  return createPortal(dialog, document.body);
}

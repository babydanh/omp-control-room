/**
 * RoleDescriptionDialog: the note kept on what an agent is for. The parent saves the note and
 * reads the verdict. Saving empty text clears the note, which "Xoá mô tả" does as well. Escape
 * closes the dialog; Ctrl/Cmd+Enter saves it.
 */

import { type KeyboardEvent as ReactKeyboardEvent, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import type { WorkItemAssignee } from '../../../../core/src/messages.js';
import { CompanyButton } from './CompanyButton.js';

/** The longest role note the board keeps; the field stops at this length. */
export const ROLE_DESCRIPTION_MAX_CHARS = 1000;

export interface RoleDescriptionDialogProps {
  /** The agent's name, for the title. */
  label: string;
  /** The folder the note belongs to, and the agent it describes; the parent saves it there. */
  workspacePath: string;
  agent: WorkItemAssignee;
  initialDescription: string;
  /** True while the parent waits for the server's verdict; the save is then disabled. */
  pending?: boolean;
  /** The reason the last save was refused, shown in the dialog; null when there is none. */
  notice?: string | null;
  onSave(description: string): void;
  onClose(): void;
}

export function RoleDescriptionDialog({
  label,
  initialDescription,
  pending = false,
  notice = null,
  onSave,
  onClose,
}: RoleDescriptionDialogProps) {
  const [text, setText] = useState(initialDescription);
  const [opener] = useState<Element | null>(() => document.activeElement);
  const textRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    textRef.current?.focus();
  }, []);

  // Focus goes back to the control that opened the dialog.
  useEffect(() => {
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, [opener]);

  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !pending) {
      event.preventDefault();
      onSave(text.trim());
    }
  }

  const dialog = (
    <div className="company-ui">
      <div className="fixed inset-0 z-40 flex items-center justify-center">
        <button
          type="button"
          aria-label="Đóng mô tả vai trò"
          onClick={onClose}
          className="absolute inset-0 cursor-default bg-black/40"
        />
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="role-description-title"
          tabIndex={-1}
          onKeyDown={onKeyDown}
          className="relative flex w-[min(420px,92vw)] flex-col gap-3 overflow-hidden rounded-(--company-radius-md) bg-panel p-3 text-xs text-text max-md:w-full max-md:rounded-none"
        >
          <h2 id="role-description-title" className="text-sm text-text">
            Mô tả vai trò của {label}
          </h2>
          <p className="text-text-muted">Ghi rõ agent này làm gì, để bạn nhớ khi giao việc.</p>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (!pending) onSave(text.trim());
            }}
            className="flex flex-col gap-3"
          >
            <label className="flex flex-col gap-1 text-text-muted">
              Mô tả
              <textarea
                ref={textRef}
                value={text}
                rows={5}
                maxLength={ROLE_DESCRIPTION_MAX_CHARS}
                disabled={pending}
                onChange={(event) => setText(event.target.value)}
                className="resize-y rounded-(--company-radius-sm) bg-well px-2 py-1.5 text-xs text-text disabled:text-text-muted"
              />
            </label>
            <p className="self-end text-2xs text-text-muted">
              {text.length}/{ROLE_DESCRIPTION_MAX_CHARS}
            </p>
            {notice ? (
              <p role="alert" className="text-danger">
                {notice}
              </p>
            ) : null}
            <div className="flex items-center justify-between gap-1">
              {initialDescription === '' ? null : (
                <CompanyButton
                  type="button"
                  size="sm"
                  disabled={pending}
                  onClick={() => onSave('')}
                >
                  Xoá mô tả
                </CompanyButton>
              )}
              <div className="ml-auto flex gap-1">
                <CompanyButton type="button" size="sm" onClick={onClose}>
                  Huỷ
                </CompanyButton>
                <CompanyButton type="submit" size="sm" variant="accent" disabled={pending}>
                  Lưu
                </CompanyButton>
              </div>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
  return createPortal(dialog, document.body);
}

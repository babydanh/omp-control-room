/**
 * RolesDialog: the model and thinking level each company role runs on. It opens from the
 * "⋯" menu, the command palette and the sidebar heading. "Đổi" opens the model picker in
 * place under that role; a pick saves through the same command the sidebar used to send,
 * and the server applies it at the role's next turn. Escape closes the dialog.
 */

import { useEffect, useRef, useState } from 'react';

import { COMPANY_HOST_ROLE_BY_ROLE, type CompanyRole } from '../../../../core/src/company.js';
import type { CompanyClient } from '../companyClient.js';
import type { CompanyViewState } from '../companyState.js';
import {
  COMPANY_ROLES,
  companyRoleLabel,
  ROLE_EDGE_CLASS,
  roleProfile,
  withRoleModel,
} from '../roleProfiles.js';
import { matchShortcut } from '../shortcuts.js';
import { CompanyButton } from './CompanyButton.js';
import { Icon } from './Icon.js';
import { ModelPicker } from './ModelPicker.js';

export interface RolesDialogProps {
  client: CompanyClient;
  state: CompanyViewState;
  onClose: () => void;
}

const TITLE_ID = 'roles-dialog-title';

export function RolesDialog({ client, state, onClose }: RolesDialogProps) {
  const [editingRole, setEditingRole] = useState<CompanyRole | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  // Focus the close button on open; on close, return focus to whatever held it before.
  useEffect(() => {
    const returnTo = document.activeElement;
    closeRef.current?.focus();
    return () => {
      if (returnTo instanceof HTMLElement && returnTo.isConnected) returnTo.focus();
    };
  }, []);

  // Escape closes the dialog, through the shortcut registry like the other board sheets.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (!matchShortcut('board.escape', event)) return;
      event.preventDefault();
      onClose();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  function changeRole(role: CompanyRole, modelId: string, thinking: string | undefined): void {
    const outcome = client.updateRoleProfiles(
      withRoleModel(state.settings?.roleProfiles ?? {}, role, modelId, thinking),
    );
    setEditingRole(null);
    setNotice(
      outcome.ok
        ? `${companyRoleLabel(role)} sẽ dùng ${modelId}${thinking ? ` · ${thinking}` : ''} từ lượt tới.`
        : (outcome.message ?? outcome.errorCode ?? 'Máy chủ từ chối đổi model.'),
    );
  }

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center">
      <button
        type="button"
        aria-label="Đóng vai trò & model"
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-black/40"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={TITLE_ID}
        className="relative flex max-h-[85vh] w-[min(560px,92vw)] flex-col gap-3 overflow-hidden rounded-(--company-radius-md) border border-hairline bg-panel p-3 max-md:h-full max-md:max-h-none max-md:w-full max-md:rounded-none"
      >
        <header className="flex shrink-0 items-center justify-between gap-2">
          <h2 id={TITLE_ID} className="text-sm text-text">
            Vai trò & model
          </h2>
          <button
            ref={closeRef}
            type="button"
            aria-label="Đóng"
            onClick={onClose}
            className="company-icon-btn touch-target"
          >
            <Icon name="close" />
          </button>
        </header>
        <p className="shrink-0 text-2xs text-text-muted">
          Đổi model có hiệu lực từ lượt kế tiếp của vai đó, không giữa chừng một lệnh công cụ.
        </p>
        <ul className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
          {COMPANY_ROLES.map((role) => {
            const profile = roleProfile(state, role);
            const editing = editingRole === role;
            return (
              <li key={role} className="flex flex-col gap-1.5">
                <div
                  className={`flex min-w-0 items-center gap-2 rounded-(--company-radius-sm) px-2 py-1.5 ${ROLE_EDGE_CLASS[role]}`}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-semibold text-text">
                      {companyRoleLabel(role)}
                    </span>
                    <span className="block truncate font-mono text-xs text-status-active">
                      {profile === null
                        ? 'chưa có hồ sơ'
                        : `${COMPANY_HOST_ROLE_BY_ROLE[role]} · ${profile.requestedModel}${profile.thinking ? ` · ${profile.thinking}` : ''}`}
                    </span>
                  </span>
                  <CompanyButton
                    size="sm"
                    disabled={profile === null}
                    aria-expanded={editing}
                    aria-label={`Đổi model của ${companyRoleLabel(role)}`}
                    onClick={() => setEditingRole((current) => (current === role ? null : role))}
                  >
                    Đổi
                  </CompanyButton>
                </div>
                {editing && profile !== null && (
                  <ModelPicker
                    profile={profile}
                    catalog={state.modelCatalog}
                    onPick={(modelId, thinking) => changeRole(role, modelId, thinking)}
                  />
                )}
              </li>
            );
          })}
        </ul>
        {notice !== null && (
          <p
            role="status"
            data-testid="role-notice"
            className="shrink-0 rounded-(--company-radius-md) bg-raised px-2 py-1 text-xs text-text-muted"
          >
            {notice}
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * ConfirmAction: a question with two answers, for an action that cannot be undone.
 * The action's own label confirms it; "Quay lại" backs out. Shared by the agent
 * menu, which asks inline, and the planning card.
 */

import { CompanyButton } from './CompanyButton.js';

export interface ConfirmActionProps {
  message: string;
  confirmLabel: string;
  danger?: boolean;
  disabled?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmAction({
  message,
  confirmLabel,
  danger = false,
  disabled = false,
  onConfirm,
  onCancel,
}: ConfirmActionProps) {
  return (
    <div role="group" aria-label="Xác nhận" className="flex flex-col gap-2">
      <p className="text-text">{message}</p>
      <div className="flex gap-1">
        <CompanyButton
          size="sm"
          className={danger ? 'text-danger' : undefined}
          disabled={disabled}
          onClick={onConfirm}
        >
          {confirmLabel}
        </CompanyButton>
        <CompanyButton size="sm" disabled={disabled} onClick={onCancel}>
          Quay lại
        </CompanyButton>
      </div>
    </div>
  );
}

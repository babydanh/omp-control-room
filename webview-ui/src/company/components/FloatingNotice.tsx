/**
 * FloatingNotice: a refusal or a failed action, shown in a small panel under the control
 * that caused it, so the header keeps one row. The panel stays until its close button is
 * pressed or the next attempt replaces it.
 */

import type { ReactNode } from 'react';

import { Icon } from './Icon.js';

export interface FloatingNoticeProps {
  children: ReactNode;
  onClose: () => void;
  /** Which edge of the control the panel hangs from. */
  align: 'left' | 'right';
  testId?: string;
}

export function FloatingNotice({ children, onClose, align, testId }: FloatingNoticeProps) {
  return (
    <div
      role="alert"
      data-testid={testId}
      className={`absolute top-full z-40 mt-1 flex max-w-[min(20rem,calc(100vw-1rem))] items-start gap-2 rounded-(--company-radius-md) border border-hairline bg-raised py-1.5 pr-1 pl-2.5 text-2xs text-warning ${
        align === 'left' ? 'left-0' : 'right-0'
      }`}
    >
      <span className="min-w-0 break-words">{children}</span>
      <button
        type="button"
        aria-label="Đóng thông báo"
        title="Đóng thông báo"
        onClick={onClose}
        className="company-icon-btn touch-target shrink-0 px-1.5 text-2xs"
      >
        <Icon name="close" />
      </button>
    </div>
  );
}

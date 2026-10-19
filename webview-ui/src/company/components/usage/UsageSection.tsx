/**
 * UsageSection: the frame each usage tab shares. It shows a loading note while its report is in
 * flight and a failed refresh inline. A tab that already holds data keeps showing it.
 */

import type { ReactNode } from 'react';

interface UsageSectionProps {
  hasData: boolean;
  loading: boolean;
  errorMessage: string | null;
  children: ReactNode;
}

export function UsageSection({ hasData, loading, errorMessage, children }: UsageSectionProps) {
  return (
    <div className="flex min-w-0 flex-col gap-4">
      {loading && (
        <span role="status" className="text-2xs text-text-muted">
          Đang tải…
        </span>
      )}
      {errorMessage !== null && (
        <p role="alert" className="text-2xs text-danger">
          {errorMessage}
          {hasData ? ' Đang hiện dữ liệu lần trước.' : ''}
        </p>
      )}
      {hasData ? (
        children
      ) : !loading && errorMessage === null ? (
        <p className="text-xs text-text-muted">Chưa có dữ liệu.</p>
      ) : null}
    </div>
  );
}

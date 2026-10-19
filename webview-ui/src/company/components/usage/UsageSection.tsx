/**
 * UsageSection: the frame every usage section shares. It shows a loading note while its report is
 * in flight and a failed refresh inline. A section that already holds data keeps showing it; the
 * controls stay usable even when there is no data yet.
 */

import { type ReactNode, useId } from 'react';

interface UsageSectionProps {
  title: string;
  hasData: boolean;
  loading: boolean;
  errorMessage: string | null;
  /** Controls that work without data, such as the history window toggle. */
  controls?: ReactNode;
  children: ReactNode;
}

export function UsageSection({
  title,
  hasData,
  loading,
  errorMessage,
  controls,
  children,
}: UsageSectionProps) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 id={headingId} className="text-sm font-semibold text-text">
          {title}
        </h2>
        {loading && (
          <span role="status" className="text-2xs text-text-muted">
            Đang tải…
          </span>
        )}
      </div>
      {controls}
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
    </section>
  );
}

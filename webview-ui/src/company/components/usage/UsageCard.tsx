/**
 * UsageCard: the surface a usage panel sits on, with its title and an optional note beside it. Cards
 * separate by tone, not by borders.
 */

import type { ReactNode } from 'react';

interface UsageCardProps {
  title: string;
  aside?: ReactNode;
  children: ReactNode;
}

export function UsageCard({ title, aside, children }: UsageCardProps) {
  return (
    <section className="flex min-w-0 flex-col gap-3 rounded-(--company-radius-md) bg-raised p-4">
      <header className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 className="text-sm font-semibold text-text">{title}</h2>
        {aside !== undefined && <div className="text-2xs text-text-muted">{aside}</div>}
      </header>
      {children}
    </section>
  );
}

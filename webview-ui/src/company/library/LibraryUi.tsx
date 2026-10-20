import type { ReactNode } from 'react';

export interface LibraryFilter {
  id: string;
  label: string;
  count?: number;
}

export interface LibraryCard {
  id: string;
  title: string;
  description?: string;
  detail?: string;
  tags?: readonly string[];
  action?: { label: string; onClick: () => void; disabled?: boolean };
}

export function LibraryPage({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <main className="company-library-page min-h-0 flex-1 overflow-y-auto bg-bg px-5 py-6 text-text sm:px-8 sm:py-8">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
        <header className="max-w-3xl">
          <h1 className="text-2xl font-semibold tracking-tight text-text">{title}</h1>
          <p className="mt-2 text-sm leading-relaxed text-text-secondary">{description}</p>
        </header>
        {children}
      </div>
    </main>
  );
}

export function LibraryToolbar({
  query,
  onQueryChange,
  filters,
  selectedFilter,
  onFilterChange,
  searchLabel = 'Tìm kiếm',
}: {
  query: string;
  onQueryChange: (query: string) => void;
  filters?: readonly LibraryFilter[];
  selectedFilter?: string;
  onFilterChange?: (filter: string) => void;
  searchLabel?: string;
}) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <label className="flex min-h-10 min-w-0 items-center gap-2 rounded-(--company-radius-sm) border border-hairline bg-raised px-3 text-sm focus-within:border-accent">
        <span className="shrink-0 text-text-muted">{searchLabel}</span>
        <input
          aria-label={searchLabel}
          value={query}
          onChange={(event) => onQueryChange(event.currentTarget.value)}
          className="min-w-0 flex-1 bg-transparent py-2 text-text outline-none placeholder:text-text-muted"
          placeholder="Nhập từ khóa…"
          type="search"
        />
      </label>
      {filters !== undefined && filters.length > 0 && (
        <div className="flex flex-wrap gap-2" role="group" aria-label="Bộ lọc">
          {filters.map((filter) => (
            <button
              key={filter.id}
              type="button"
              aria-pressed={selectedFilter === filter.id}
              onClick={() => onFilterChange?.(filter.id)}
              className="rounded-full border border-hairline px-3 py-1.5 text-xs text-text-secondary transition-colors duration-150 hover:bg-hover aria-pressed:border-accent aria-pressed:bg-selected aria-pressed:text-text motion-reduce:transition-none"
            >
              {filter.label}
              {filter.count !== undefined && (
                <span className="ml-1.5 text-text-muted">{filter.count}</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function LibraryCards({ cards }: { cards: readonly LibraryCard[] }) {
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
      {cards.map((card) => (
        <article
          key={card.id}
          className="rounded-(--company-radius-md) border border-hairline bg-panel p-4 transition-colors duration-150 hover:border-border hover:bg-raised motion-reduce:transition-none"
        >
          <h2 className="font-medium text-text">{card.title}</h2>
          {card.description !== undefined && (
            <p className="mt-2 text-sm leading-relaxed text-text-secondary">{card.description}</p>
          )}
          {card.detail !== undefined && <p className="mt-3 text-xs text-text-muted">{card.detail}</p>}
          {card.tags !== undefined && card.tags.length > 0 && (
            <ul className="mt-3 flex flex-wrap gap-1.5">
              {card.tags.map((tag) => (
                <li key={tag} className="rounded-full bg-well px-2 py-1 text-2xs text-text-muted">
                  {tag}
                </li>
              ))}
            </ul>
          )}
          {card.action !== undefined && (
            <button
              type="button"
              disabled={card.action.disabled}
              onClick={card.action.onClick}
              className="mt-3 rounded-(--company-radius-sm) border border-hairline px-3 py-1.5 text-sm text-text transition-colors hover:bg-raised disabled:opacity-50"
            >
              {card.action.label}
            </button>
          )}
        </article>
      ))}
    </div>
  );
}

export function LibraryLoading({ label = 'Đang tải…' }: { label?: string }) {
  return (
    <p
      role="status"
      className="rounded-(--company-radius-md) border border-hairline bg-panel px-4 py-6 text-sm text-text-muted"
    >
      {label}
    </p>
  );
}

export function LibraryEmpty({ title, description }: { title: string; description: string }) {
  return (
    <section className="rounded-(--company-radius-md) border border-dashed border-border bg-panel px-5 py-8 text-center">
      <h2 className="font-medium text-text">{title}</h2>
      <p className="mx-auto mt-2 max-w-xl text-sm leading-relaxed text-text-secondary">{description}</p>
    </section>
  );
}

export function LibraryError({ message }: { message: string }) {
  return <p role="alert" className="rounded-(--company-radius-md) border border-danger/40 bg-panel px-4 py-3 text-sm text-danger">{message}</p>;
}

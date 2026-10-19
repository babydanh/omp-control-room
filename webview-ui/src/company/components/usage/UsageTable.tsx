/**
 * UsageTable: a table whose columns sort when their header is pressed. The sort is local to the
 * table: the rows come from the server, and a sort never asks for them again. Missing values sort
 * last in both directions.
 */

import { type ReactNode, useState } from 'react';

import { type SortDirection, sortRows, type SortValue } from '../../usage/usageStats.js';

export interface UsageColumn<Row> {
  key: string;
  label: string;
  align?: 'start' | 'end';
  /** A text column sorts ascending when first pressed; a numeric one sorts descending. */
  textual?: boolean;
  sortValue: (row: Row) => SortValue;
  cell: (row: Row) => ReactNode;
}

interface UsageTableProps<Row> {
  caption: string;
  rows: readonly Row[];
  columns: readonly UsageColumn<Row>[];
  /** The column the table opens sorted by, descending. */
  defaultKey: string;
  rowKey: (row: Row) => string;
}

interface SortState {
  key: string;
  dir: SortDirection;
}

export function UsageTable<Row>({
  caption,
  rows,
  columns,
  defaultKey,
  rowKey,
}: UsageTableProps<Row>) {
  const [sort, setSort] = useState<SortState>({ key: defaultKey, dir: 'desc' });
  if (rows.length === 0) return <p className="text-xs text-text-muted">Chưa có dữ liệu.</p>;

  const sorted = sortRows(rows, sort.key, sort.dir, (row, key) => {
    const column = columns.find((candidate) => candidate.key === key);
    return column === undefined ? null : column.sortValue(row);
  });

  const pressHeader = (column: UsageColumn<Row>): void => {
    setSort((current) => {
      if (current.key !== column.key) {
        return { key: column.key, dir: column.textual ? 'asc' : 'desc' };
      }
      return { key: column.key, dir: current.dir === 'asc' ? 'desc' : 'asc' };
    });
  };

  return (
    <div className="max-h-[26rem] overflow-auto rounded-(--company-radius-sm)">
      <table className="w-full min-w-[30rem] border-collapse text-xs">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            {columns.map((column) => {
              const active = column.key === sort.key;
              const ariaSort = active
                ? sort.dir === 'asc'
                  ? 'ascending'
                  : 'descending'
                : undefined;
              const align = column.align === 'end' ? 'text-right' : 'text-left';
              return (
                <th
                  key={column.key}
                  scope="col"
                  aria-sort={ariaSort}
                  className={`sticky top-0 z-[1] bg-raised px-3 py-2 font-normal text-text-muted ${align}`}
                >
                  <button
                    type="button"
                    onClick={() => pressHeader(column)}
                    className="cursor-pointer hover:text-text"
                  >
                    {column.label}
                    {active ? (sort.dir === 'asc' ? ' ↑' : ' ↓') : ''}
                  </button>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => (
            <tr key={rowKey(row)} className="even:bg-panel hover:bg-hover">
              {columns.map((column) => {
                const align = column.align === 'end' ? 'text-right' : 'text-left';
                return (
                  <td key={column.key} className={`px-3 py-2 tabular-nums text-text ${align}`}>
                    {column.cell(row)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

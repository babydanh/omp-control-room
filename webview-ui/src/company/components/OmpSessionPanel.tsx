/**
 * OmpSessionPanel: OMP's own session listing, drawn as OMP reported it.
 *
 * This panel is a VIEW. It starts no session, sends no command, and opens no
 * terminal -- everything on screen is a field that arrived in an
 * {@link OmpSessionRecord}. What it deliberately does not draw is the important
 * half:
 *
 *  - NO running / idle / live badge. OMP's `SessionInfo`
 *    (`@oh-my-pi/pi-coding-agent` `src/session/session-listing.ts:17-39`) has
 *    no pid, no heartbeat and no start time, so "is this agent still inside its
 *    task" is not answerable from this API. OMP's `status` is a reading of the
 *    last PERSISTED MESSAGE in the session file (`deriveSessionStatus`,
 *    `:162-182`) -- `pending` in particular means "a user message with no
 *    assistant reply persisted after it" (`:215-217`), which says nothing about
 *    whether a process exists. The header states this in the panel itself so
 *    the next reader does not have to rediscover it.
 *
 *  - NO relative times. `formatOmpTimestamp` renders absolute UTC to the minute;
 *    a ticking "3m ago" invites the reader to read movement as work.
 *
 *  - `unknown` is a first-class cell, not an empty one. OMP's `status` is
 *    optional (`:38`) and `'unknown'` is itself a value it emits (`:13-14`), and
 *    both mean the same thing to a reader: we do not know. They are drawn as
 *    the word, never as a blank, a dash, or a neighbouring status.
 *
 * The data arrives as a prop. There is no fetch here, because there is no
 * in-process OMP API to fetch from: the package ships TypeScript source under
 * an `import`-only export map and refuses to load outside its own runtime. See
 * `ompSessionView.ts` for the field-by-field provenance.
 */

import type { ReactNode } from 'react';

import {
  buildOmpSessionForest,
  describeOmpStatus,
  flattenOmpSessionForest,
  formatOmpTimestamp,
  type OmpSessionRecord,
  type OmpSessionRow,
} from '../ompSessionView.js';

export interface OmpSessionPanelProps {
  readonly records: readonly OmpSessionRecord[];
  /** True while the caller is fetching. Shows a neutral line, never fake rows. */
  readonly loading?: boolean;
  /** Set when the fetch failed; shown verbatim so the failure is not disguised. */
  readonly error?: string | null;
  readonly onSelect?: (sessionId: string) => void;
}

/** One indent step per level of recorded parentage. */
const INDENT_PX = 16;

const MISSING = <span className="text-text-muted">không có dữ liệu</span>;

function Field({ label, value }: { label: string; value: ReactNode }) {
  return (
    <span className="flex gap-1">
      <span className="text-text-muted">{label}</span>
      <span className="truncate">{value}</span>
    </span>
  );
}

function StatusChip({ row }: { row: OmpSessionRow }) {
  const described = describeOmpStatus(row.status);
  return (
    <span
      // The observed/unobserved split is what stops a reader treating OMP's
      // own `unknown` as this view having failed to read the field.
      data-status={row.statusObserved ? 'observed' : 'unobserved'}
      data-omp-status={described.status}
      title={described.basis}
      className={
        row.statusObserved
          ? 'shrink-0 border-2 border-border px-1 text-2xs text-text'
          : 'shrink-0 border-2 border-border px-1 text-2xs text-text-muted'
      }
    >
      {described.label}
    </span>
  );
}

function SessionRow({ row, onSelect }: { row: OmpSessionRow; onSelect?: (id: string) => void }) {
  const created = formatOmpTimestamp(row.created);
  const modified = formatOmpTimestamp(row.modified);
  return (
    <li
      data-testid="omp-session-row"
      data-session-id={row.id}
      data-depth={row.depth}
      className="flex flex-col gap-1 border-b-2 border-border py-2 last:border-b-0"
    >
      <div className="flex items-center gap-2" style={{ paddingLeft: row.depth * INDENT_PX }}>
        <button
          type="button"
          onClick={() => onSelect?.(row.id)}
          disabled={!onSelect}
          title={onSelect ? `Chọn ${row.id}` : undefined}
          className="min-w-0 flex-1 cursor-pointer text-left text-sm text-text disabled:cursor-default"
        >
          {row.title ?? <span className="text-text-muted">{row.id}</span>}
        </button>
        <StatusChip row={row} />
      </div>
      <div
        className="flex flex-wrap gap-x-4 gap-y-1 text-2xs"
        style={{ paddingLeft: row.depth * INDENT_PX }}
      >
        <Field label="id" value={row.id} />
        <Field label="thư mục" value={row.cwd ?? MISSING} />
        <Field
          label="tin nhắn"
          value={row.messageCount === null ? MISSING : `${row.messageCount} đã ghi nhận`}
        />
        <Field label="đã sửa" value={modified ?? MISSING} />
        <Field label="đã tạo" value={created ?? MISSING} />
        {row.parentReferenced && row.parentId === null && (
          // OMP recorded a parent path that is not in this listing. Saying so is
          // a fact; saying "root session" would be a guess about lineage.
          <Field
            label="phiên cha"
            value={<span className="text-text-muted">nằm ngoài danh sách này</span>}
          />
        )}
      </div>
    </li>
  );
}

export function OmpSessionPanel({
  records,
  loading = false,
  error = null,
  onSelect,
}: OmpSessionPanelProps) {
  const rows = flattenOmpSessionForest(buildOmpSessionForest(records));

  return (
    <section className="pixel-panel flex min-h-0 flex-col" data-testid="omp-session-panel">
      <header className="border-b-2 border-border p-2">
        <div className="flex items-baseline justify-between gap-2">
          <h3 className="text-sm text-text">Các phiên OMP</h3>
          <span className="text-2xs text-text-muted">
            {loading ? 'đang đọc' : `đã liệt kê ${rows.length}`}
          </span>
        </div>
        <p className="text-2xs text-text-muted">
          Trạng thái là cách OMP đọc tin nhắn cuối cùng được lưu trong tệp của từng phiên. Nó không
          cho biết một phiên có đang chạy hay không.
        </p>
      </header>

      {error !== null && (
        <p
          className="border-b-2 border-border p-2 text-2xs text-danger"
          data-testid="omp-session-error"
        >
          {error}
        </p>
      )}

      {loading && rows.length === 0 && (
        <p className="p-2 text-2xs text-text-muted" data-testid="omp-session-loading">
          Đang đọc danh sách phiên của OMP.
        </p>
      )}

      {!loading && error === null && rows.length === 0 && (
        <p className="p-2 text-2xs text-text-muted" data-testid="omp-session-empty">
          OMP không báo phiên nào.
        </p>
      )}

      {rows.length > 0 && (
        <ul className="min-h-0 flex-1 overflow-y-auto p-2">
          {rows.map((row) => (
            <SessionRow key={row.id} row={row} onSelect={onSelect} />
          ))}
        </ul>
      )}
    </section>
  );
}

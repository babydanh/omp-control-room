/**
 * OmpSessionPicker: the list `/resume` opens over the composer.
 *
 * It shows the omp sessions saved in the folder the board points at. Choosing a
 * row resumes that session on the board. `resumeListView` has already decided
 * which of the three states this is, so the component only draws it.
 */

import type { OmpSessionEntry } from '../../../../core/src/messages.js';
import {
  formatSessionSize,
  formatUpdatedAt,
  type ResumeListView,
  resumeRowTitle,
} from '../composerRouting.js';

export interface OmpSessionPickerProps {
  view: ResumeListView;
  onChoose: (entry: OmpSessionEntry) => void;
}

export function OmpSessionPicker({ view, onChoose }: OmpSessionPickerProps) {
  return (
    <ul
      className="mb-1 max-h-40 overflow-auto rounded-(--company-radius-md) border border-hairline bg-raised p-1"
      data-testid="resume-picker"
    >
      {view.kind === 'loading' && (
        <li className="px-2 py-1 text-2xs text-text-muted">Đang tải danh sách phiên…</li>
      )}
      {view.kind === 'failed' && (
        <li className="rounded-(--company-radius-sm) bg-warning/12 px-2 py-1 text-2xs text-warning">
          {view.message}
        </li>
      )}
      {view.kind === 'ready' && view.entries.length === 0 && (
        <li className="px-2 py-1 text-2xs text-text-muted">
          Thư mục này chưa có phiên omp nào đã lưu.
        </li>
      )}
      {view.kind === 'ready' &&
        view.entries.map((entry) => (
          <li key={entry.file}>
            <button
              type="button"
              onClick={() => onChoose(entry)}
              className="flex w-full cursor-pointer items-baseline gap-2 rounded-(--company-radius-sm) px-2 py-1 text-left text-2xs text-text-muted hover:bg-hover hover:text-text"
            >
              <span className="min-w-0 flex-1 truncate text-text">{resumeRowTitle(entry)}</span>
              <span className="shrink-0">{formatUpdatedAt(entry.updatedAt)}</span>
              <span className="shrink-0">{formatSessionSize(entry.sizeBytes)}</span>
              {entry.boardSessionId !== undefined && (
                <span className="shrink-0 text-accent-bright">đang mở</span>
              )}
            </button>
          </li>
        ))}
    </ul>
  );
}

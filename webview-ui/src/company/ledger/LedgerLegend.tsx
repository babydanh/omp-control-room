/**
 * LedgerLegend: what each colour, icon, dot and line on the git tree means, in words.
 * Collapsed by default so the cards get the room; it reads the same maps the tree draws with.
 */

import { Icon } from '../components/Icon.js';
import { type NodeTone, TONE_LABEL } from './ledgerHealth.js';
import type { ManagerDot } from './ledgerManagers.js';
import { DOT_CLASS, TONE_BADGE, TONE_ICON } from './ledgerTreeStyle.js';

const TONE_MEANING: Readonly<Record<NodeTone, string>> = {
  ok: 'không có việc cần làm',
  attention:
    'có việc nên làm: rebase, đẩy lên GitHub, commit file sửa dở, quét xong, dọn nhánh bỏ quên',
  conflict: 'sẽ đụng code của nhánh khác hoặc của main',
  merged: 'đã vào main; sạch và không ai dùng thì được gập lại',
};

const TONES: readonly NodeTone[] = ['ok', 'attention', 'conflict', 'merged'];

const DOT_MEANING: Readonly<Record<ManagerDot, string>> = {
  waiting: 'cần bạn quyết định, hoặc đang spam',
  active: 'đang chạy',
  idle: 'đang mở, đang rảnh',
  ended: 'đã đóng hoặc đang ngủ',
};

const DOTS: readonly ManagerDot[] = ['waiting', 'active', 'idle', 'ended'];

export function LedgerLegend() {
  return (
    <details className="rounded-(--company-radius-md) bg-panel px-3 py-2">
      <summary className="cursor-pointer text-xs text-text-secondary">Chú giải</summary>
      <div className="mt-3 grid gap-4 text-xs text-text-secondary md:grid-cols-3">
        <section aria-label="Trạng thái của thẻ" className="flex flex-col gap-1.5">
          <h4 className="text-2xs text-text-muted">Trạng thái của thẻ</h4>
          {TONES.map((tone) => (
            <p key={tone} className="flex items-start gap-2">
              <span
                className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-2xs ${TONE_BADGE[tone]}`}
              >
                <Icon name={TONE_ICON[tone]} />
                {TONE_LABEL[tone]}
              </span>
              <span>{TONE_MEANING[tone]}</span>
            </p>
          ))}
        </section>
        <section aria-label="Đường nối" className="flex flex-col gap-1.5">
          <h4 className="text-2xs text-text-muted">Đường nối</h4>
          <p className="flex items-center gap-2">
            <svg aria-hidden="true" focusable="false" width="28" height="10" className="shrink-0">
              <line x1="0" y1="5" x2="28" y2="5" stroke="var(--color-text-muted)" strokeWidth={2} />
            </svg>
            <span>Thân cây là checkout chính (main). Mỗi nhánh rẽ ra từ thân.</span>
          </p>
          <p className="flex items-center gap-2">
            <svg aria-hidden="true" focusable="false" width="28" height="10" className="shrink-0">
              <line
                x1="0"
                y1="5"
                x2="28"
                y2="5"
                strokeWidth={1.5}
                className="stroke-danger"
                strokeDasharray="5 4"
              />
            </svg>
            <span>
              Nét đỏ đứt: hai nhánh (hoặc nhánh với main) sẽ xung đột. Số là số tệp đụng nhau.
            </span>
          </p>
          <p>Bấm nhãn đỏ để xem tệp đụng nhau.</p>
        </section>
        <section aria-label="Phiên và pane đang quản lý" className="flex flex-col gap-1.5">
          <h4 className="text-2xs text-text-muted">Ai đang quản lý</h4>
          {DOTS.map((dot) => (
            <p key={dot} className="flex items-center gap-2">
              <span
                aria-hidden="true"
                className={`size-2 shrink-0 rounded-full ${DOT_CLASS[dot]}`}
              />
              <span>{DOT_MEANING[dot]}</span>
            </p>
          ))}
          <p>
            Bấm một phiên hoặc pane để mở nó. Phiên và pane là hai nguồn khác nhau, nên có thể hiện
            cả hai.
          </p>
        </section>
      </div>
    </details>
  );
}

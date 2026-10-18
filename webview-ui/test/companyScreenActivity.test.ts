import { describe, expect, it } from 'vitest';

import { screenActivityLine, stripPrivateUse } from '../src/company/screenActivity.js';

// Fixtures use explicit escapes for omp's private-use glyphs and box drawing, so the
// file stays ASCII-safe. All prose here is synthetic.

/** omp's in-progress todo marker: opens the working row. */
const WORKING = '\u{F12B7}';
/** A row marker close to the working one, but a write row: chrome. */
const WRITE = '\u{F12A}';
/** Tool-row and notice glyphs: private-use, so a row that opens with one is chrome. */
const GREP = '\u{F002}';
const READ = '\u{F111}';
const EDIT = '\u{EA73}';
const NOTICE = '\u{F086}';
/** A braille spinner glyph: with a space and text, it opens a working row. */
const SPINNER = '\u280B';
const DASH = '\u2500';
const RULE = DASH.repeat(48);
/** omp's status bar: model, usage and cost, with private-use glyphs and middle dots. */
const STATUS_BAR =
  ' \u{F0AA3} Opus 5.5 \u{EA70}   \u{F017} 5h 46% (2h 6m) \u00B7 \u{F1C0} 99.13% ' +
  '\u00B7 \u{E70F} 72.6%/1M \u{F0068} \u00B7 \u{F08B} 2.6M';
/** The status bar's wrapped line. */
const STATUS_WRAP = 'việc dở: 1 repo';
/** A box frame: top edge with a tool title, body row, bottom edge. */
const FRAME_TOP = `\u256D${DASH.repeat(3)} ${EDIT} Edit: sample/config.txt ${DASH.repeat(3)}\u256E`;
const FRAME_BODY = '\u2502   5\u2502value = 1  \u2502';
const FRAME_BOTTOM = `\u2570${DASH.repeat(3)}\u256F`;
/** Subagent tree rows. */
const TREE_BULLET = `   \u251C${DASH} \u2022 Sub: đối chiếu bảng giả lập`;
const TREE_LAST = `   \u2514${DASH} Chờ kết quả từ bảng mẫu`;
/** The in-progress todo text used across the tests. */
const WORKING_TODO = 'Đối chiếu bảng giả lập với mẫu tổng hợp';

describe('screenActivityLine', () => {
  it('prefers the in-progress todo row over the prose above it', () => {
    const lines = [
      'Dựng bản tổng hợp giả lập, không gọi model.',
      `  ${WORKING} ${WORKING_TODO}`,
      '',
      RULE,
      '',
      RULE,
      STATUS_BAR,
      STATUS_WRAP,
    ];

    expect(screenActivityLine(lines)).toBe(WORKING_TODO);
  });

  it('takes the newest working row when several are on screen', () => {
    const lines = [
      `  ${WORKING} Bước cũ đã xong`,
      'Đoạn văn giữa.',
      `  ${WORKING} ${WORKING_TODO}`,
      RULE,
      STATUS_BAR,
    ];

    expect(screenActivityLine(lines)).toBe(WORKING_TODO);
  });

  it('strips private-use glyphs from the working text', () => {
    expect(screenActivityLine([`  ${WORKING} Viết ${NOTICE} tiếp  `])).toBe('Viết tiếp');
  });

  it('reads a braille spinner row as working, even above newer prose', () => {
    const lines = ['Ghi chú trước đó.', `${SPINNER} Đang soạn bảng mẫu`, 'Ghi chú sau cùng.'];

    expect(screenActivityLine(lines)).toBe('Đang soạn bảng mẫu');
  });

  it('falls back to the last prose line when the tail is only the status bar', () => {
    const lines = ['Bản nháp đã sẵn sàng để duyệt.', '', RULE, '', RULE, STATUS_BAR, STATUS_WRAP];

    expect(screenActivityLine(lines)).toBe('Bản nháp đã sẵn sàng để duyệt.');
  });

  it('ignores the wrapped unfinished-work line under prose', () => {
    expect(screenActivityLine(['Đã ghi xong phần đầu.', STATUS_WRAP])).toBe(
      'Đã ghi xong phần đầu.',
    );
  });

  it('treats a ※ recap line as ordinary prose', () => {
    const recap = '\u203B recap: đã chạy xong bước so khớp';

    expect(screenActivityLine(['Kết quả cũ.', recap, '', RULE, STATUS_BAR])).toBe(recap);
  });

  it('skips box frames and tree rows', () => {
    const lines = [
      'Ghi chú: kiểm tra mẫu.',
      FRAME_TOP,
      FRAME_BODY,
      FRAME_BOTTOM,
      TREE_BULLET,
      TREE_LAST,
    ];

    expect(screenActivityLine(lines)).toBe('Ghi chú: kiểm tra mẫu.');
  });

  it('skips private-use tool and notice rows and collapse markers', () => {
    const lines = [
      'Mẫu đã đối chiếu xong.',
      `  ${GREP} Grep: "placeholder" in sample/`,
      `  ${READ} Read sample/notes.txt`,
      `  ${WRITE} Write sample/out.txt`,
      `  ${NOTICE} Đã lưu ý với người dùng`,
      '… 8 more lines (Ctrl+O to expand)',
      '… 3 more matches',
      '… (24 earlier lines, showing 10 of 34) ·Ctrl+O: Expand·',
    ];

    expect(screenActivityLine(lines)).toBe('Mẫu đã đối chiếu xong.');
  });

  it('collapses whitespace and caps the line at 240 characters', () => {
    expect(screenActivityLine(['  Bản   tóm\t\ttắt  '])).toBe('Bản tóm tắt');
    expect(screenActivityLine(['x'.repeat(300)])).toBe('x'.repeat(240));
  });

  it('returns null when every row is chrome', () => {
    const lines = [
      '',
      '   ',
      RULE,
      FRAME_TOP,
      FRAME_BODY,
      FRAME_BOTTOM,
      TREE_BULLET,
      TREE_LAST,
      `  ${GREP} Grep: "placeholder"`,
      '… 8 more lines (Ctrl+O to expand)',
      '… 3 more matches',
      '\u276F ',
      '\u276F gõ tiếp',
      '\u203A gõ tiếp',
      '> ',
      STATUS_BAR,
      STATUS_WRAP,
      `${NOTICE}`,
      '\u2022 thông báo',
    ];

    expect(screenActivityLine(lines)).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(screenActivityLine([])).toBeNull();
  });

  it('reads the in-progress todo from a realistic 12-line tail', () => {
    const tail = [
      TREE_BULLET,
      TREE_LAST,
      `  ${GREP} Grep: "placeholder" in sample/`,
      '… 8 more lines (Ctrl+O to expand)',
      'Đã đọc xong ghi chú mẫu, chuẩn bị so khớp.',
      `  ${WORKING} ${WORKING_TODO}`,
      '',
      RULE,
      '',
      RULE,
      STATUS_BAR,
      STATUS_WRAP,
    ];

    expect(tail).toHaveLength(12);
    expect(screenActivityLine(tail)).toBe(WORKING_TODO);
  });
});

describe('stripPrivateUse', () => {
  it('replaces private-use code points with spaces and collapses whitespace', () => {
    expect(stripPrivateUse('a\u{E000}b\u{F0000}c\u{100000}d')).toBe('a b c d');
    expect(stripPrivateUse(`  ${GREP}  Grep:${NOTICE}   x  `)).toBe('Grep: x');
  });

  it('leaves code points outside the private-use ranges alone', () => {
    expect(stripPrivateUse('\u{F900}\u203B')).toBe('\u{F900}\u203B');
  });
});

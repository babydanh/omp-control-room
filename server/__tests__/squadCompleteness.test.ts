import { describe, expect, it } from 'vitest';

import {
  type CompletenessRow,
  planCompleteness,
  SQUAD_WARNINGS_MAX,
} from '../../core/src/squadCompleteness.js';

const READ_ONLY: ReadonlySet<string> = new Set(['scout', 'reviewer', 'security-reviewer']);

describe('planCompleteness', () => {
  it('flags a code change with no reviewer and no done-when line', () => {
    const rows: CompletenessRow[] = [{ text: 'Viết trang', dependsOn: [] }];
    expect(planCompleteness(rows, READ_ONLY)).toEqual([
      'Thiếu bước review cho #1',
      'Thiếu tiêu chí nghiệm thu cho #1',
    ]);
  });

  it('accepts a reviewer that waits for the row, and exempts sonic from review', () => {
    const rows: CompletenessRow[] = [
      { text: 'Viết trang', acceptance: 'Có test', dependsOn: [] },
      {
        text: 'Review',
        agent: 'reviewer',
        acceptance: 'Không lỗi',
        dependsOn: [{ kind: 'row', row: 0 }],
      },
      { text: 'Đổi tên biến', agent: 'sonic', acceptance: 'Biên dịch', dependsOn: [] },
    ];
    expect(planCompleteness(rows, READ_ONLY)).toEqual([]);
  });

  it('names a risky row with no security reviewer, and a herdr row that names a subagent', () => {
    const rows: CompletenessRow[] = [
      {
        text: 'Sửa form đăng nhập',
        agent: 'scout',
        acceptance: 'Có test',
        assigneeKind: 'herdr',
        dependsOn: [],
      },
    ];
    expect(planCompleteness(rows, READ_ONLY)).toEqual([
      'Nên có review bảo mật cho #1 (đụng auth)',
      'Agent herdr: subagent chỉ là gợi ý (#1)',
    ]);
  });

  it('caps the warnings at the limit', () => {
    const rows: CompletenessRow[] = Array.from({ length: SQUAD_WARNINGS_MAX }, () => ({
      text: 'Việc',
      dependsOn: [],
    }));
    expect(planCompleteness(rows, READ_ONLY)).toHaveLength(SQUAD_WARNINGS_MAX);
  });
});

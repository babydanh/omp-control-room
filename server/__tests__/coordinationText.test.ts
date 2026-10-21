import { describe, expect, it } from 'vitest';

import { coordinationMessageContent, handoffSection } from '../src/ledger/coordinationText.js';

describe('coordination message text', () => {
  it.each([
    ['[Tin từ claude …e85aceed (cwd); trả lời: lane send e85aceed "…"] nội dung', 'nội dung'],
    ['[Tin từ omp …e73e90a0 (cwd …)] nội dung\n(Trả lời nếu cần: …)', 'nội dung'],
    ['[Tin từ người dùng qua lane] nội dung', 'nội dung'],
  ])('extracts content without the sender wrapper', (input, expected) => {
    expect(coordinationMessageContent(input)).toBe(expected);
  });
});

describe('handoff sections', () => {
  it('extracts a heading body and limits it to 300 characters', () => {
    expect(
      handoffSection('## Mục tiêu\n' + 'a'.repeat(350) + '\n## Trạng thái\nDone', 'Mục tiêu'),
    ).toHaveLength(300);
  });
});

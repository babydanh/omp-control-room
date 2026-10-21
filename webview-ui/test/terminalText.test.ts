import { describe, expect, it } from 'vitest';

import { withoutTerminalEscapes } from '../../core/src/terminalText.js';

describe('withoutTerminalEscapes', () => {
  it('drops colour, cursor and title sequences and keeps the words, Vietnamese included', () => {
    const screen = '\u001b[0m\u001b[1mĐã kiểm lại trạng thái:\u001b[0m \u001b[38;2;177;185;249mgit status\u001b[0m\u001b[2K\u001b]0;claude\u0007 xong';
    expect(withoutTerminalEscapes(screen)).toBe('Đã kiểm lại trạng thái: git status xong');
  });

  it('leaves plain text, brackets and a lone ESC-free "[0m" alone', () => {
    expect(withoutTerminalEscapes('mảng [0m] và a[1]')).toBe('mảng [0m] và a[1]');
  });
});

import { describe, expect, it } from 'vitest';

import { screenPlainText, stripPrivateUse } from '../src/company/screenText.js';

describe('screen text', () => {
  it('removes private-use glyphs but keeps ordinary and Vietnamese text', () => {
    expect(stripPrivateUse('\uE0B0 ready \uF09F\u{F0001} tiếng Việt')).toBe(' ready  tiếng Việt');
  });

  it('copies the screen as plain text: colour dropped, trailing blanks trimmed, inner blanks kept', () => {
    const text = '\x1b[31mred\x1b[0m line   \n\n\x1b[1mbold\x1b[0m\n\n';
    expect(screenPlainText(text)).toBe('red line\n\nbold');
  });

  it('copies nothing from a blank screen', () => {
    expect(screenPlainText('\n  \n')).toBe('');
  });
});

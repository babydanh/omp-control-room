import { describe, expect, it } from 'vitest';

import { screenPlainText, splitLinks, stripPrivateUse } from '../src/company/screenText.js';

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

describe('screen links', () => {
  it('splits a row into plain text and http(s) links', () => {
    expect(splitLinks('see https://example.com/a?b=1 now')).toEqual([
      { text: 'see ' },
      { text: 'https://example.com/a?b=1', href: 'https://example.com/a?b=1' },
      { text: ' now' },
    ]);
  });

  it('leaves sentence punctuation and an unmatched bracket out of the link', () => {
    expect(splitLinks('(open http://localhost:3197/x).')).toEqual([
      { text: '(open ' },
      { text: 'http://localhost:3197/x', href: 'http://localhost:3197/x' },
      { text: ').' },
    ]);
    expect(splitLinks('go to https://a.dev/p, then')[1]).toEqual({ text: 'https://a.dev/p', href: 'https://a.dev/p' });
  });

  it('keeps a balanced bracket inside the link and returns text without links untouched', () => {
    expect(splitLinks('https://en.wikipedia.org/wiki/A_(b)')).toEqual([
      { text: 'https://en.wikipedia.org/wiki/A_(b)', href: 'https://en.wikipedia.org/wiki/A_(b)' },
    ]);
    expect(splitLinks('no link here')).toEqual([{ text: 'no link here' }]);
    expect(splitLinks('')).toEqual([]);
  });

  it('does not link other schemes', () => {
    expect(splitLinks('javascript:alert(1) file:///c:/x ftp://h/x')).toEqual([{ text: 'javascript:alert(1) file:///c:/x ftp://h/x' }]);
  });
});

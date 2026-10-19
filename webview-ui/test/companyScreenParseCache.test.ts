import { describe, expect, it } from 'vitest';

import { parseAnsiScreen, parseAnsiScreenCached } from '../src/company/terminalScreen.js';

describe('parseAnsiScreenCached', () => {
  it('parses the same rows as parseAnsiScreen', () => {
    const text = '\x1b[31mred\x1b[0m\nplain\n\x1b[1mbold\x1b[0m';
    expect(parseAnsiScreenCached(text, null).lines).toEqual(parseAnsiScreen(text));
  });

  it('reuses the parsed object for every row whose text did not change', () => {
    const first = parseAnsiScreenCached('a\nb\nc', null);
    const second = parseAnsiScreenCached('a\nB\nc', first.cache);

    expect(second.lines[0]).toBe(first.lines[0]);
    expect(second.lines[2]).toBe(first.lines[2]);
    expect(second.lines[1]).not.toBe(first.lines[1]);
    expect(second.lines).toEqual(parseAnsiScreen('a\nB\nc'));
  });

  it('keeps the cache to the rows of the latest screen', () => {
    const first = parseAnsiScreenCached('a\nb\nc', null);
    const second = parseAnsiScreenCached('a', first.cache);

    expect(second.cache.rows.size).toBe(1);
  });
});

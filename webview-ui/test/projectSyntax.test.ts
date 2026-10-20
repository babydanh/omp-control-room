import { describe, expect, it } from 'vitest';

import { highlightLine } from '../src/company/projects/projectSyntax.js';

const kinds = (text: string, file: string) =>
  highlightLine(text, file).filter((token) => token.kind !== 'plain').map((token) => [token.kind, token.text]);

describe('highlightLine', () => {
  it('colours keywords, strings, numbers, types and trailing comments in TypeScript', () => {
    expect(kinds("const url: Route = 'http://x'; // note", 'src/a.ts')).toEqual([
      ['keyword', 'const'],
      ['type', 'Route'],
      ['string', "'http://x'"],
      ['comment', '// note'],
    ]);
    expect(kinds('return items.length > 10;', 'lib/b.dart')).toEqual([['keyword', 'return'], ['number', '10']]);
  });

  it('keeps every character: the tokens join back to the line', () => {
    const line = '  if (a === "b") { call(`x ${y}`); } /* c */';
    expect(highlightLine(line, 'x.tsx').map((token) => token.text).join('')).toBe(line);
  });

  it('uses # comments for Python and YAML, and leaves unknown file types plain', () => {
    expect(kinds('def run(): # go', 'tool.py')).toEqual([['keyword', 'def'], ['comment', '# go']]);
    expect(kinds('enabled: true # on', 'ci.yml')).toEqual([['keyword', 'true'], ['comment', '# on']]);
    expect(highlightLine('const x = 1', 'notes.txt')).toEqual([{ text: 'const x = 1', kind: 'plain' }]);
  });
});

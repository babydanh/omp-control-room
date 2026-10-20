import { describe, expect, it } from 'vitest';

import { highlightLine } from '../src/company/projects/projectSyntax.js';

const kinds = (text: string, file: string) =>
  highlightLine(text, file).filter((token) => token.kind !== 'plain').map((token) => [token.kind, token.text]);

describe('highlightLine', () => {
  it('colours a TypeScript line the way VS Code does: declaration, variable, type, call, string, comment', () => {
    expect(kinds("const url: Route = build('http://x'); // note", 'src/a.ts')).toEqual([
      ['storage', 'const'],
      ['variable', 'url'],
      ['punctuation', ':'],
      ['type', 'Route'],
      ['punctuation', '='],
      ['function', 'build'],
      ['punctuation', '('],
      ['string', "'http://x'"],
      ['punctuation', ');'],
      ['comment', '// note'],
    ]);
  });

  it('separates control keywords from declarations and numbers', () => {
    expect(kinds('return items.length > 10;', 'lib/b.dart')).toEqual([
      ['keyword', 'return'],
      ['variable', 'items'],
      ['punctuation', '.'],
      ['variable', 'length'],
      ['punctuation', '>'],
      ['number', '10'],
      ['punctuation', ';'],
    ]);
  });

  it('keeps every character: the tokens join back to the line', () => {
    const line = '  if (a === "b") { call(`x ${y}`); } /* c */';
    expect(highlightLine(line, 'x.tsx').map((token) => token.text).join('')).toBe(line);
  });

  it('uses # comments for Python and YAML, and leaves unknown file types plain', () => {
    expect(kinds('def run(): # go', 'tool.py')).toEqual([
      ['storage', 'def'],
      ['function', 'run'],
      ['punctuation', '():'],
      ['comment', '# go'],
    ]);
    expect(kinds('enabled: true # on', 'ci.yml')).toEqual([
      ['variable', 'enabled'],
      ['punctuation', ':'],
      ['storage', 'true'],
      ['comment', '# on'],
    ]);
    expect(highlightLine('const x = 1', 'notes.txt')).toEqual([{ text: 'const x = 1', kind: 'plain' }]);
  });
});

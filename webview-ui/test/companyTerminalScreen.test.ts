/* eslint-disable pixel-agents/no-inline-colors -- asserts computed rgb() colour strings */
import type { IBufferCell, IBufferLine } from '@xterm/xterm';
import { describe, expect, it } from 'vitest';

import {
  type BufferCellLike,
  type BufferLineLike,
  bufferLineSegments,
  paletteColor,
  parseAnsiScreen,
  plainScreen,
  screenFitPx,
  type ScreenLine,
  type ScreenStyle,
  tailScreen,
} from '../src/company/terminalScreen.js';
import { TERMINAL_ANSI_COLORS } from '../src/constants.js';

const ESC = '\u001b';
const sgr = (params: string): string => `${ESC}[${params}m`;

/** The expected result for a single line holding a single segment. */
const oneLine = (text: string, style: ScreenStyle = {}): ScreenLine[] => [[{ text, style }]];

/** The expected result for one buffer row: a single line of segments. */
const segmentLine = (text: string, style: ScreenStyle = {}): ScreenLine => [{ text, style }];

type FlagName = 'bold' | 'dim' | 'italic' | 'underline' | 'strike' | 'inverse';

interface ColorSpec {
  readonly mode: 'default' | 'palette' | 'rgb';
  readonly value?: number;
}

interface FakeCellSpec {
  readonly chars?: string;
  readonly width?: number;
  readonly fg?: ColorSpec;
  readonly bg?: ColorSpec;
  readonly flags?: readonly FlagName[];
}

/** A cell with xterm's semantics: colour-mode predicates and bitmask attribute flags. */
function fakeCell(spec: FakeCellSpec = {}): BufferCellLike {
  const fg = spec.fg ?? { mode: 'default' };
  const bg = spec.bg ?? { mode: 'default' };
  const flag = (name: FlagName): number => (spec.flags?.includes(name) ? 0x100 : 0);
  return {
    getChars: () => spec.chars ?? 'a',
    getWidth: () => spec.width ?? 1,
    getFgColor: () => fg.value ?? 0,
    getBgColor: () => bg.value ?? 0,
    isFgRGB: () => fg.mode === 'rgb',
    isBgRGB: () => bg.mode === 'rgb',
    isFgPalette: () => fg.mode === 'palette',
    isBgPalette: () => bg.mode === 'palette',
    isFgDefault: () => fg.mode === 'default',
    isBgDefault: () => bg.mode === 'default',
    isBold: () => flag('bold'),
    isDim: () => flag('dim'),
    isItalic: () => flag('italic'),
    isUnderline: () => flag('underline'),
    isStrikethrough: () => flag('strike'),
    isInverse: () => flag('inverse'),
  };
}

/** A buffer line; an undefined entry mimics a missing cell. */
function fakeLine(cells: readonly (BufferCellLike | undefined)[]): BufferLineLike {
  return { length: cells.length, getCell: (x) => cells[x] };
}

describe('xterm compatibility', () => {
  it('accepts xterm buffer types structurally', () => {
    // Compile-time guard: type-checking fails here if xterm's typings stop matching the subset.
    const toCell = (cell: IBufferCell): BufferCellLike => cell;
    const toLine = (line: IBufferLine): BufferLineLike => line;
    expect(toCell).toBeTypeOf('function');
    expect(toLine).toBeTypeOf('function');
  });
});

describe('paletteColor', () => {
  it('returns the theme colours for indexes 0-15', () => {
    for (let index = 0; index < 16; index += 1) {
      expect(paletteColor(index)).toBe(TERMINAL_ANSI_COLORS[index]);
    }
  });

  it('maps the 6x6x6 cube and the grey ramp', () => {
    expect(paletteColor(16)).toBe('rgb(0, 0, 0)');
    expect(paletteColor(21)).toBe('rgb(0, 0, 255)');
    expect(paletteColor(196)).toBe('rgb(255, 0, 0)');
    expect(paletteColor(231)).toBe('rgb(255, 255, 255)');
    expect(paletteColor(232)).toBe('rgb(8, 8, 8)');
    expect(paletteColor(255)).toBe('rgb(238, 238, 238)');
  });
});

describe('parseAnsiScreen colours', () => {
  it('maps the eight base and eight bright colours to the theme palette', () => {
    for (let index = 0; index < 8; index += 1) {
      expect(parseAnsiScreen(`${sgr(String(30 + index))}x`)).toStrictEqual(
        oneLine('x', { fg: TERMINAL_ANSI_COLORS[index] }),
      );
      expect(parseAnsiScreen(`${sgr(String(90 + index))}x`)).toStrictEqual(
        oneLine('x', { fg: TERMINAL_ANSI_COLORS[index + 8] }),
      );
      expect(parseAnsiScreen(`${sgr(String(40 + index))}x`)).toStrictEqual(
        oneLine('x', { bg: TERMINAL_ANSI_COLORS[index] }),
      );
      expect(parseAnsiScreen(`${sgr(String(100 + index))}x`)).toStrictEqual(
        oneLine('x', { bg: TERMINAL_ANSI_COLORS[index + 8] }),
      );
    }
  });

  it('resets the foreground with 39 and the background with 49', () => {
    expect(parseAnsiScreen(`${sgr('31')}a${sgr('39')}b`)).toStrictEqual([
      [
        { text: 'a', style: { fg: TERMINAL_ANSI_COLORS[1] } },
        { text: 'b', style: {} },
      ],
    ]);
    expect(parseAnsiScreen(`${sgr('44')}a${sgr('49')}b`)).toStrictEqual([
      [
        { text: 'a', style: { bg: TERMINAL_ANSI_COLORS[4] } },
        { text: 'b', style: {} },
      ],
    ]);
  });

  it('reads the 256-colour palette through 38;5 and 48;5, with colon forms', () => {
    expect(parseAnsiScreen(`${sgr('38;5;196')}a`)).toStrictEqual(
      oneLine('a', { fg: 'rgb(255, 0, 0)' }),
    );
    expect(parseAnsiScreen(`${sgr('48;5;232')}a`)).toStrictEqual(
      oneLine('a', { bg: 'rgb(8, 8, 8)' }),
    );
    expect(parseAnsiScreen(`${sgr('38;5;9')}a`)).toStrictEqual(
      oneLine('a', { fg: TERMINAL_ANSI_COLORS[9] }),
    );
    expect(parseAnsiScreen(`${sgr('38:5:21')}a`)).toStrictEqual(
      oneLine('a', { fg: 'rgb(0, 0, 255)' }),
    );
  });

  it('reads truecolour through 38;2 and 48;2, with every colon form', () => {
    expect(parseAnsiScreen(`${sgr('38;2;10;20;30')}a`)).toStrictEqual(
      oneLine('a', { fg: 'rgb(10, 20, 30)' }),
    );
    expect(parseAnsiScreen(`${sgr('48;2;1;2;3')}a`)).toStrictEqual(
      oneLine('a', { bg: 'rgb(1, 2, 3)' }),
    );
    expect(parseAnsiScreen(`${sgr('38:2:10:20:30')}a`)).toStrictEqual(
      oneLine('a', { fg: 'rgb(10, 20, 30)' }),
    );
    expect(parseAnsiScreen(`${sgr('38:2::10:20:30')}a`)).toStrictEqual(
      oneLine('a', { fg: 'rgb(10, 20, 30)' }),
    );
    expect(parseAnsiScreen(`${sgr('38:2:0:10:20:30')}a`)).toStrictEqual(
      oneLine('a', { fg: 'rgb(10, 20, 30)' }),
    );
  });

  it('ignores invalid extended colours but still consumes their fields', () => {
    // 256 is out of range, so the colour is dropped; its four fields are consumed, leaving 1 = bold.
    expect(parseAnsiScreen(`${sgr('38;2;256;0;0;1')}a`)).toStrictEqual(
      oneLine('a', { bold: true }),
    );
    expect(parseAnsiScreen(`${sgr('38;5;256')}a`)).toStrictEqual(oneLine('a'));
    expect(parseAnsiScreen(`${sgr('38;5;999;1')}a`)).toStrictEqual(oneLine('a', { bold: true }));
  });

  it('ignores unknown SGR codes', () => {
    expect(parseAnsiScreen(`${sgr('5;25;53;999')}a`)).toStrictEqual(oneLine('a'));
  });
});

describe('parseAnsiScreen attributes', () => {
  const flagCases: readonly [on: string, off: string, key: keyof ScreenStyle][] = [
    ['1', '22', 'bold'],
    ['2', '22', 'dim'],
    ['3', '23', 'italic'],
    ['4', '24', 'underline'],
    ['7', '27', 'inverse'],
    ['9', '29', 'strike'],
  ];

  it.each(flagCases)('turns the attribute on with %s and off with %s', (on, off, key) => {
    expect(parseAnsiScreen(`${sgr(on)}a${sgr(off)}b`)).toStrictEqual([
      [
        { text: 'a', style: { [key]: true } },
        { text: 'b', style: {} },
      ],
    ]);
  });

  it('clears bold and dim together with 21 and 22', () => {
    expect(parseAnsiScreen(`${sgr('1;2')}a${sgr('21')}b`)).toStrictEqual([
      [
        { text: 'a', style: { bold: true, dim: true } },
        { text: 'b', style: {} },
      ],
    ]);
    expect(parseAnsiScreen(`${sgr('1;2')}a${sgr('22')}b`)).toStrictEqual([
      [
        { text: 'a', style: { bold: true, dim: true } },
        { text: 'b', style: {} },
      ],
    ]);
  });

  it('sets all six attributes at once and clears them with their off codes', () => {
    expect(parseAnsiScreen(`${sgr('1;2;3;4;7;9')}a${sgr('22;23;24;27;29')}b`)).toStrictEqual([
      [
        {
          text: 'a',
          style: {
            bold: true,
            dim: true,
            italic: true,
            underline: true,
            inverse: true,
            strike: true,
          },
        },
        { text: 'b', style: {} },
      ],
    ]);
  });

  it('reads 4:x underline variants, with 4:0 turning underline off', () => {
    expect(parseAnsiScreen(`${ESC}[4:3ma`)).toStrictEqual(oneLine('a', { underline: true }));
    expect(parseAnsiScreen(`${sgr('4')}a${ESC}[4:0mb`)).toStrictEqual([
      [
        { text: 'a', style: { underline: true } },
        { text: 'b', style: {} },
      ],
    ]);
  });

  it('resets every attribute with an empty parameter or code 0', () => {
    expect(parseAnsiScreen(`${sgr('1;31')}a${ESC}[mb${sgr('2;32')}c${sgr('0')}d`)).toStrictEqual([
      [
        { text: 'a', style: { bold: true, fg: TERMINAL_ANSI_COLORS[1] } },
        { text: 'b', style: {} },
        { text: 'c', style: { dim: true, fg: TERMINAL_ANSI_COLORS[2] } },
        { text: 'd', style: {} },
      ],
    ]);
  });
});

describe('parseAnsiScreen text handling', () => {
  it('returns one unstyled segment per line when there are no escapes', () => {
    expect(parseAnsiScreen('hello\nworld')).toStrictEqual([
      [{ text: 'hello', style: {} }],
      [{ text: 'world', style: {} }],
    ]);
  });

  it('handles CRLF line endings', () => {
    expect(parseAnsiScreen('one\r\ntwo\r\n')).toStrictEqual([
      [{ text: 'one', style: {} }],
      [{ text: 'two', style: {} }],
      [],
    ]);
  });

  it('drops a lone CR elsewhere in a line', () => {
    expect(parseAnsiScreen('ab\rcd')).toStrictEqual(oneLine('abcd'));
  });

  it('skips unknown CSI, OSC and two-byte escapes', () => {
    const text = `a${ESC}[2Kb${ESC}[?25lc${ESC}]0;title\u0007d` + `${ESC}]8;;x${ESC}\\e${ESC}cf`;
    expect(parseAnsiScreen(text)).toStrictEqual(oneLine('abcdef'));
  });

  it('skips an unterminated escape to the end of its line', () => {
    expect(parseAnsiScreen(`a${ESC}[31`)).toStrictEqual(oneLine('a'));
    expect(parseAnsiScreen(`b${ESC}]0;title`)).toStrictEqual(oneLine('b'));
  });

  it('keeps tabs and drops other control characters', () => {
    expect(parseAnsiScreen('a\tb\u0001c')).toStrictEqual(oneLine('a\tbc'));
  });

  it('merges adjacent characters that share a style', () => {
    expect(parseAnsiScreen(`${sgr('31')}a${sgr('31')}b`)).toStrictEqual(
      oneLine('ab', { fg: TERMINAL_ANSI_COLORS[1] }),
    );
  });

  it('yields an empty line for a line that holds only escapes', () => {
    expect(parseAnsiScreen(sgr('31'))).toStrictEqual([[]]);
  });
});

describe('plainScreen', () => {
  it('leaves escape sequences in the text untouched', () => {
    const text = `${sgr('31')}red${sgr('0')}`;
    expect(plainScreen(text)).toStrictEqual([[{ text, style: {} }]]);
  });

  it('keeps one line per row and leaves empty rows empty', () => {
    expect(plainScreen('a\r\n\r\nb')).toStrictEqual([
      [{ text: 'a', style: {} }],
      [],
      [{ text: 'b', style: {} }],
    ]);
  });
});

describe('tailScreen', () => {
  it('drops trailing blank lines and keeps the last N lines', () => {
    const lines = plainScreen('a\nb\n\n   \nc\n\n');
    expect(tailScreen(lines, 2)).toStrictEqual([
      [{ text: '   ', style: {} }],
      [{ text: 'c', style: {} }],
    ]);
    expect(tailScreen(lines, 100)).toHaveLength(5);
  });

  it('returns nothing when every line is blank or the count is not positive', () => {
    expect(tailScreen(plainScreen('  \n\n'), 3)).toStrictEqual([]);
    const lines = plainScreen('a\nb');
    expect(tailScreen(lines, 0)).toStrictEqual([]);
    expect(tailScreen(lines, -1)).toStrictEqual([]);
  });
});

describe('bufferLineSegments', () => {
  it('skips wide-character continuation cells and undefined cells', () => {
    const line = fakeLine([
      fakeCell({ chars: '漢', width: 2 }),
      fakeCell({ chars: '', width: 0 }),
      undefined,
      fakeCell({ chars: 'a' }),
    ]);
    expect(bufferLineSegments(line)).toStrictEqual(segmentLine('漢a'));
  });

  it('paints an empty cell as a space', () => {
    expect(bufferLineSegments(fakeLine([fakeCell({ chars: '' })]))).toStrictEqual(segmentLine(' '));
  });

  it('omits colour keys for default colours', () => {
    expect(bufferLineSegments(fakeLine([fakeCell({ chars: 'a' })]))).toStrictEqual(
      segmentLine('a'),
    );
  });

  it('decodes packed 0xRRGGBB truecolour', () => {
    const cell = fakeCell({
      chars: 'x',
      fg: { mode: 'rgb', value: 0x102030 },
      bg: { mode: 'rgb', value: 0xff8000 },
    });
    expect(bufferLineSegments(fakeLine([cell]))).toStrictEqual(
      segmentLine('x', { fg: 'rgb(16, 32, 48)', bg: 'rgb(255, 128, 0)' }),
    );
  });

  it('maps palette colours through the 256-colour table', () => {
    const cell = fakeCell({
      chars: 'x',
      fg: { mode: 'palette', value: 196 },
      bg: { mode: 'palette', value: 4 },
    });
    expect(bufferLineSegments(fakeLine([cell]))).toStrictEqual(
      segmentLine('x', { fg: 'rgb(255, 0, 0)', bg: TERMINAL_ANSI_COLORS[4] }),
    );
  });

  it('maps every attribute flag', () => {
    const cell = fakeCell({
      chars: 'a',
      flags: ['bold', 'dim', 'italic', 'underline', 'strike', 'inverse'],
    });
    expect(bufferLineSegments(fakeLine([cell]))).toStrictEqual(
      segmentLine('a', {
        bold: true,
        dim: true,
        italic: true,
        underline: true,
        strike: true,
        inverse: true,
      }),
    );
  });

  it('merges neighbours with equal style and splits on a change', () => {
    const line = fakeLine([
      fakeCell({ chars: 'a', flags: ['bold', 'inverse'] }),
      fakeCell({ chars: 'b', flags: ['bold', 'inverse'] }),
      fakeCell({ chars: 'c' }),
    ]);
    expect(bufferLineSegments(line)).toStrictEqual([
      { text: 'ab', style: { bold: true, inverse: true } },
      { text: 'c', style: {} },
    ]);
  });
});

describe('screenFitPx', () => {
  const row = (columns: number): ScreenLine => [{ text: 'x'.repeat(columns), style: {} }];
  const rule = (columns: number): ScreenLine => [{ text: '─'.repeat(columns), style: {} }];

  it('shrinks the font so the widest row fits, within the readable 10-12 px bounds', () => {
    // 100 columns at 0.6 em a glyph fit 600 px at 10 px.
    expect(screenFitPx([row(40), row(100)], 600)).toBe(10);
    expect(screenFitPx([row(20)], 600)).toBe(12);
    expect(screenFitPx([row(300)], 600)).toBe(10);
  });

  it('sizes by the text, not by full-width divider rows or trailing spaces', () => {
    expect(screenFitPx([rule(200), row(20)], 600)).toBe(12);
    expect(screenFitPx([[{ text: `${'x'.repeat(20)}${' '.repeat(180)}`, style: {} }]], 600)).toBe(12);
  });

  it('has no size before the frame is measured or when the screen is empty', () => {
    expect(screenFitPx([row(80)], 0)).toBeUndefined();
    expect(screenFitPx([], 600)).toBeUndefined();
  });
});

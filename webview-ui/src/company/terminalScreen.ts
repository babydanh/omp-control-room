import { TERMINAL_ANSI_COLORS } from '../constants.js';

/**
 * Screen model for terminal previews. Pane text (ANSI) and xterm buffer lines
 * both become styled segments, so a view can paint them without touching the
 * DOM or xterm at runtime.
 */

export interface ScreenStyle {
  readonly fg?: string;
  readonly bg?: string;
  readonly bold?: boolean;
  readonly dim?: boolean;
  readonly italic?: boolean;
  readonly underline?: boolean;
  readonly strike?: boolean;
  readonly inverse?: boolean;
}

export interface ScreenSegment {
  readonly text: string;
  readonly style: ScreenStyle;
}

export type ScreenLine = readonly ScreenSegment[];

/**
 * Structural subset of xterm's IBufferCell; keep every member name exactly as xterm names it.
 * xterm's attribute predicates return a bitmask (non-zero when set), so they are typed as numbers.
 */
export interface BufferCellLike {
  getChars(): string;
  getWidth(): number;
  getFgColor(): number;
  getBgColor(): number;
  isFgRGB(): boolean;
  isBgRGB(): boolean;
  isFgPalette(): boolean;
  isBgPalette(): boolean;
  isFgDefault(): boolean;
  isBgDefault(): boolean;
  isBold(): number;
  isDim(): number;
  isItalic(): number;
  isUnderline(): number;
  isStrikethrough(): number;
  isInverse(): number;
}

/** Structural subset of xterm's IBufferLine. */
export interface BufferLineLike {
  readonly length: number;
  getCell(x: number): BufferCellLike | undefined;
}

const ESC = 0x1b;
const BEL = 0x07;
const TAB = 0x09;
const CUBE_LEVELS: readonly number[] = [0, 95, 135, 175, 215, 255];
const DIGITS = /^\d+$/;
const SGR_PARAMS = /^[0-9:;]*$/;
const STYLE_KEYS: readonly (keyof ScreenStyle)[] = [
  'fg',
  'bg',
  'bold',
  'dim',
  'italic',
  'underline',
  'strike',
  'inverse',
];

/** A style under construction: fields are present only when set. */
type MutableStyle = { -readonly [K in keyof ScreenStyle]?: ScreenStyle[K] };

/** CSS `rgb()` colour from 8-bit channels. */
function rgbColor(red: number, green: number, blue: number): string {
  // The colour is computed from channel values, so it is not a theme literal.
  // eslint-disable-next-line pixel-agents/no-inline-colors -- computed, not a theme literal
  return `rgb(${red}, ${green}, ${blue})`;
}

/** CSS colour for a 256-colour palette index (0-255). */
export function paletteColor(index: number): string {
  if (index < 16) return TERMINAL_ANSI_COLORS[index];
  if (index < 232) {
    const cube = index - 16;
    return rgbColor(
      CUBE_LEVELS[Math.floor(cube / 36)],
      CUBE_LEVELS[Math.floor((cube % 36) / 6)],
      CUBE_LEVELS[cube % 6],
    );
  }
  const grey = 8 + 10 * (index - 232);
  return rgbColor(grey, grey, grey);
}

/** Split text into lines on `\n`, dropping one trailing `\r` from each line. */
function splitLines(text: string): string[] {
  return text.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
}

function between(code: number, low: number, high: number): boolean {
  return code >= low && code <= high;
}

/** Append text, merging it into the previous segment when the style matches. */
function pushSegment(segments: ScreenSegment[], text: string, style: ScreenStyle): void {
  if (text === '') return;
  const last = segments.at(-1);
  if (last !== undefined && STYLE_KEYS.every((key) => last.style[key] === style[key])) {
    segments[segments.length - 1] = { text: last.text + text, style: last.style };
  } else {
    segments.push({ text, style });
  }
}

/** An SGR code: an empty parameter means 0. Null when the parameter is not a number. */
function sgrCode(value: string): number | null {
  if (value === '') return 0;
  return DIGITS.test(value) ? Number(value) : null;
}

/** An 8-bit value (palette index or channel), or null when absent or above 255. */
function byteValue(value: string | undefined): number | null {
  if (value === undefined || !DIGITS.test(value)) return null;
  const parsed = Number(value);
  return parsed <= 255 ? parsed : null;
}

function paletteFromParam(value: string | undefined): string | null {
  const index = byteValue(value);
  return index === null ? null : paletteColor(index);
}

function rgbFromChannels(
  red: string | undefined,
  green: string | undefined,
  blue: string | undefined,
): string | null {
  const r = byteValue(red);
  const g = byteValue(green);
  const b = byteValue(blue);
  return r === null || g === null || b === null ? null : rgbColor(r, g, b);
}

interface ExtendedColor {
  /** The colour, or null when its parameters are invalid. */
  readonly color: string | null;
  /** How many `;`-separated fields after the 38/48 were consumed. */
  readonly consumed: number;
}

/** 38/48 written with colons, e.g. `38:5:196`, `38:2:r:g:b` or `38:2::r:g:b`. */
function colonColor(subs: readonly string[]): string | null {
  if (subs[0] === '5') return paletteFromParam(subs[1]);
  if (subs[0] === '2') {
    // The colour space id is optional; when present it precedes the channels.
    const rest = subs.slice(1);
    const channels = rest.length >= 4 ? rest.slice(1, 4) : rest.slice(0, 3);
    return rgbFromChannels(channels[0], channels[1], channels[2]);
  }
  return null;
}

/** 38/48 written with semicolons, e.g. `38;5;196` or `38;2;r;g;b`. */
function semicolonColor(fields: readonly string[], index: number): ExtendedColor {
  const mode = fields[index + 1];
  if (mode === '5') return { color: paletteFromParam(fields[index + 2]), consumed: 2 };
  if (mode === '2') {
    const color = rgbFromChannels(fields[index + 2], fields[index + 3], fields[index + 4]);
    return { color, consumed: 4 };
  }
  return { color: null, consumed: 0 };
}

function applyColorCode(style: MutableStyle, code: number): void {
  if (code >= 30 && code <= 37) style.fg = paletteColor(code - 30);
  else if (code >= 40 && code <= 47) style.bg = paletteColor(code - 40);
  else if (code >= 90 && code <= 97) style.fg = paletteColor(code - 90 + 8);
  else if (code >= 100 && code <= 107) style.bg = paletteColor(code - 100 + 8);
}

/** Apply one SGR code that is not 38/48, given its colon-separated parts. */
function applyCode(style: MutableStyle, code: number, parts: readonly string[]): void {
  switch (code) {
    case 0:
      for (const key of STYLE_KEYS) delete style[key];
      return;
    case 1:
      style.bold = true;
      return;
    case 2:
      style.dim = true;
      return;
    case 3:
      style.italic = true;
      return;
    case 4: {
      // `4` is a single underline; `4:x` picks a variant, and `4:0` turns it off.
      const variant = parts.length > 1 ? sgrCode(parts[1]) : 1;
      if (variant === 0) delete style.underline;
      else if (variant !== null) style.underline = true;
      return;
    }
    case 7:
      style.inverse = true;
      return;
    case 9:
      style.strike = true;
      return;
    case 21:
    case 22:
      delete style.bold;
      delete style.dim;
      return;
    case 23:
      delete style.italic;
      return;
    case 24:
      delete style.underline;
      return;
    case 27:
      delete style.inverse;
      return;
    case 29:
      delete style.strike;
      return;
    case 39:
      delete style.fg;
      return;
    case 49:
      delete style.bg;
      return;
    default:
      applyColorCode(style, code);
  }
}

/** Apply an SGR parameter string (the part between `ESC [` and `m`) to a style. */
function applySgr(current: ScreenStyle, params: string): ScreenStyle {
  const style: MutableStyle = { ...current };
  const fields = params.split(';');
  for (let index = 0; index < fields.length; index += 1) {
    const parts = fields[index].split(':');
    const code = sgrCode(parts[0]);
    if (code === null) continue;
    if (code === 38 || code === 48) {
      const extended =
        parts.length > 1
          ? { color: colonColor(parts.slice(1)), consumed: 0 }
          : semicolonColor(fields, index);
      index += extended.consumed;
      if (extended.color !== null) style[code === 38 ? 'fg' : 'bg'] = extended.color;
    } else {
      applyCode(style, code, parts);
    }
  }
  return style;
}

interface EscapeRead {
  /** Index just past the escape sequence. */
  readonly end: number;
  /** The parameter string when this is a plain SGR (`ESC [ params m`), else null. */
  readonly sgr: string | null;
}

/** Index just past an OSC string whose body starts at `start`, ended by BEL or `ESC \`. */
function skipOsc(line: string, start: number): number {
  for (let index = start; index < line.length; index += 1) {
    const code = line.charCodeAt(index);
    if (code === BEL) return index + 1;
    if (code === ESC && line.charAt(index + 1) === '\\') return index + 2;
  }
  return line.length;
}

/** Read a CSI sequence whose parameters start at `start` (just after `ESC [`). */
function readCsi(line: string, start: number): EscapeRead {
  let end = start;
  while (end < line.length && between(line.charCodeAt(end), 0x30, 0x3f)) end += 1;
  const paramsEnd = end;
  while (end < line.length && between(line.charCodeAt(end), 0x20, 0x2f)) end += 1;
  if (end >= line.length) return { end: line.length, sgr: null };
  const final = line.charCodeAt(end);
  // A byte that cannot end a CSI means the sequence is malformed: resume at that byte.
  if (!between(final, 0x40, 0x7e)) return { end, sgr: null };
  const params = line.slice(start, paramsEnd);
  const plainSgr = final === 0x6d && end === paramsEnd && SGR_PARAMS.test(params);
  return { end: end + 1, sgr: plainSgr ? params : null };
}

/** Read the escape sequence that starts with the ESC at `start`. */
function readEscape(line: string, start: number): EscapeRead {
  const introducer = line.charAt(start + 1);
  if (introducer === '[') return readCsi(line, start + 2);
  if (introducer === ']') return { end: skipOsc(line, start + 2), sgr: null };
  // Two-byte `ESC x`, or ESC with intermediate bytes ending in a final byte (`ESC ( B`).
  let end = start + 1;
  while (end < line.length && between(line.charCodeAt(end), 0x20, 0x2f)) end += 1;
  if (end < line.length && between(line.charCodeAt(end), 0x30, 0x7e)) end += 1;
  return { end, sgr: null };
}

function parseAnsiLine(line: string): ScreenLine {
  const segments: ScreenSegment[] = [];
  let style: ScreenStyle = {};
  let run = '';
  let index = 0;
  while (index < line.length) {
    const code = line.charCodeAt(index);
    if (code === ESC) {
      const escape = readEscape(line, index);
      if (escape.sgr !== null) {
        pushSegment(segments, run, style);
        run = '';
        style = applySgr(style, escape.sgr);
      }
      index = escape.end;
      continue;
    }
    // Other C0 controls (a lone CR, BEL, ...) are dropped; tab is kept.
    if (code === TAB || code >= 0x20) run += line.charAt(index);
    index += 1;
  }
  pushSegment(segments, run, style);
  return segments;
}

/** Parse pane text that may carry SGR colour escapes. Other escapes are skipped. */
export function parseAnsiScreen(text: string): ScreenLine[] {
  return splitLines(text).map(parseAnsiLine);
}

/** The parsed rows of one screen, keyed by each row's raw text, so the next read can reuse them. */
export interface ScreenParseCache {
  readonly rows: ReadonlyMap<string, ScreenLine>;
}

/**
 * parseAnsiScreen with reuse: a row whose raw text was in `previous` keeps its parsed segments,
 * so a read that changed one row parses one row. Unchanged rows come back as the same objects,
 * which lets memoised rows skip re-rendering.
 */
export function parseAnsiScreenCached(
  text: string,
  previous: ScreenParseCache | null,
): { readonly lines: ScreenLine[]; readonly cache: ScreenParseCache } {
  const rows = new Map<string, ScreenLine>();
  const lines = splitLines(text).map((raw) => {
    const line = previous?.rows.get(raw) ?? rows.get(raw) ?? parseAnsiLine(raw);
    rows.set(raw, line);
    return line;
  });
  return { lines, cache: { rows } };
}

/** Split text into lines with no escape processing: each non-empty line is one unstyled segment. */
export function plainScreen(text: string): ScreenLine[] {
  return splitLines(text).map((line) => (line === '' ? [] : [{ text: line, style: {} }]));
}

/** A monospace glyph's width as a share of the font size, used until the real font is measured. */
export const MONO_CHAR_EM = 0.6;
/**
 * The smallest and largest font a fitted screen uses; below the floor it scrolls sideways. The floor
 * stays readable: a 200-column agent screen in a side drawer otherwise shrinks to unreadable dots.
 */
const FIT_MIN_PX = 14;
const FIT_MAX_PX = 16;
/** A row drawn only with rules and spaces: a TUI divider stretched to the terminal's full width. */
const RULE_ROW = /^[\s─━═│┃║┄┅┈┉╌╍-]*$/;

/**
 * The font size, in pixels, at which the widest row of content fits `widthPx`, so a terminal screen
 * keeps its columns instead of wrapping. Divider rows and trailing spaces do not count: they span
 * the whole terminal however little text it shows. `charEm` is the font's glyph width per pixel of
 * font size. Undefined before the frame has a width or when there are no rows.
 */
export function screenFitPx(
  lines: readonly ScreenLine[],
  widthPx: number,
  charEm: number = MONO_CHAR_EM,
): number | undefined {
  const columns = lines.reduce((widest, line) => {
    const text = line.map((segment) => segment.text).join('').trimEnd();
    return RULE_ROW.test(text) ? widest : Math.max(widest, text.length);
  }, 0);
  if (widthPx <= 0 || columns === 0 || charEm <= 0) return undefined;
  const fit = Math.floor((widthPx / (columns * charEm)) * 10) / 10;
  return Math.min(FIT_MAX_PX, Math.max(FIT_MIN_PX, fit));
}

/** The last `count` lines after dropping trailing lines that hold no visible character. */
export function tailScreen(lines: readonly ScreenLine[], count: number): ScreenLine[] {
  if (count <= 0) return [];
  let end = lines.length;
  while (end > 0 && !lines[end - 1].some((segment) => /\S/.test(segment.text))) end -= 1;
  return lines.slice(Math.max(0, end - count), end);
}

/** Colour of one cell channel; undefined for the terminal default. */
function cellColor(
  value: number,
  isDefault: boolean,
  isRgb: boolean,
  isPalette: boolean,
): string | undefined {
  if (isDefault) return undefined;
  // Truecolour packs 0xRRGGBB into the value.
  if (isRgb) return rgbColor((value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff);
  if (isPalette) return paletteColor(value);
  return undefined;
}

function cellStyle(cell: BufferCellLike): ScreenStyle {
  const style: MutableStyle = {};
  const fg = cellColor(cell.getFgColor(), cell.isFgDefault(), cell.isFgRGB(), cell.isFgPalette());
  if (fg !== undefined) style.fg = fg;
  const bg = cellColor(cell.getBgColor(), cell.isBgDefault(), cell.isBgRGB(), cell.isBgPalette());
  if (bg !== undefined) style.bg = bg;
  if (cell.isBold() !== 0) style.bold = true;
  if (cell.isDim() !== 0) style.dim = true;
  if (cell.isItalic() !== 0) style.italic = true;
  if (cell.isUnderline() !== 0) style.underline = true;
  if (cell.isStrikethrough() !== 0) style.strike = true;
  if (cell.isInverse() !== 0) style.inverse = true;
  return style;
}

/** Convert one xterm buffer line into styled segments. */
export function bufferLineSegments(line: BufferLineLike): ScreenLine {
  const segments: ScreenSegment[] = [];
  for (let x = 0; x < line.length; x += 1) {
    const cell = line.getCell(x);
    // Width 0 marks the trailing half of a wide character, whose glyph is already emitted.
    if (cell === undefined || cell.getWidth() === 0) continue;
    pushSegment(segments, cell.getChars() || ' ', cellStyle(cell));
  }
  return segments;
}

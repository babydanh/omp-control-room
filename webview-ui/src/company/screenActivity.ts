/**
 * The activity line of an agent card: one line that says what the agent is doing
 * now, read from the tail of its terminal screen.
 *
 * Pure and DOM-free. Input is plain-text screen lines, ANSI already stripped,
 * oldest first. omp's own chrome (status bar, tool rows, box frames, prompt rows,
 * collapse markers) is skipped, so a card shows the agent's work, not the footer.
 */

/** Private-use code points: omp draws its icons from these, so they are not text. */
const PRIVATE_USE = /[\u{E000}-\u{F8FF}\u{F0000}-\u{FFFFD}\u{100000}-\u{10FFFD}]/gu;

/** A private-use code point first in a trimmed line. */
const LEADING_PRIVATE_USE = /^[\u{E000}-\u{F8FF}\u{F0000}-\u{FFFFD}\u{100000}-\u{10FFFD}]/u;

/** omp's in-progress todo marker: a private-use glyph that opens a working row. */
const WORKING_MARKER = '\u{F12B7}';

/** A braille spinner glyph and its space: the other way a working row opens. */
const SPINNER = /^[\u2800-\u28FF] /;

/** A letter or digit. Rules, glyph-only and blank rows have neither. */
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

/** First characters of box and tree frames, and of bullet notifications. */
const FRAME_START = /^[│╭╰├└┌┐┘┤┬┴┼┃•]/;

/** A separator: a run of box-drawing dashes, possibly with spaces. */
const RULE = /^\s*─[\s─]*$/;

/** A prompt or input row: the marker, then a space or the end of the line. */
const PROMPT = /^[❯›>](\s|$)/;

/** The model name in omp's status bar, such as "Opus 5.5". */
const MODEL_NAME = /\b(Opus|Sonnet|Haiku)\s*\d/;

/** The status bar's wrapped line about unfinished work. */
const UNFINISHED_WORK = 'việc dở:';

/** Collapse markers such as "8 more lines" or "3 more matches". */
const COLLAPSE_WORDS = /\b(more lines|earlier lines|more matches)\b/;

/** The longest line a card shows. */
const MAX_CHARS = 240;

/** Replace each private-use code point with a space, then collapse whitespace and trim. */
export function stripPrivateUse(text: string): string {
  return text.replace(PRIVATE_USE, ' ').replace(/\s+/g, ' ').trim();
}

/** The status bar and its wrapped line. `text` has no private-use glyphs. */
function isStatusBar(text: string): boolean {
  if (text.includes('%') && text.includes('·')) return true;
  return MODEL_NAME.test(text) || text.normalize('NFC').startsWith(UNFINISHED_WORK);
}

/**
 * True for rows that are never the agent's own words: omp chrome and screen
 * furniture. The working marker is the one private-use glyph allowed to open a row.
 */
function isChrome(line: string): boolean {
  const trimmed = line.trimStart();
  const text = stripPrivateUse(line);
  if (!LETTER_OR_DIGIT.test(text)) return true;
  if (LEADING_PRIVATE_USE.test(trimmed) && !trimmed.startsWith(WORKING_MARKER)) return true;
  if (FRAME_START.test(trimmed) || RULE.test(line) || PROMPT.test(trimmed)) return true;
  if (isStatusBar(text) || text.includes('Ctrl+O')) return true;
  return COLLAPSE_WORDS.test(text) || text.startsWith('…');
}

/**
 * The text of a working row: one that opens with the in-progress marker or a spinner.
 * Null for any other row, and for chrome that only looks like a working row.
 */
function workingBody(line: string): string | null {
  const trimmed = line.trimStart();
  let body: string;
  if (trimmed.startsWith(WORKING_MARKER)) {
    body = trimmed.slice(WORKING_MARKER.length);
  } else if (SPINNER.test(trimmed)) {
    body = trimmed.replace(SPINNER, '');
  } else {
    return null;
  }
  return isChrome(line) ? null : body;
}

/** The newest working row's text, else the newest prose row's raw text, else null. */
function activityText(lines: readonly string[]): string | null {
  for (let index = lines.length - 1; index >= 0; index--) {
    const body = workingBody(lines[index] ?? '');
    if (body !== null) return body;
  }
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index] ?? '';
    if (!isChrome(line)) return line;
  }
  return null;
}

/**
 * One line of what the agent is doing, from the screen tail (oldest line first):
 * private-use glyphs stripped, whitespace collapsed, at most 240 characters.
 * The newest working row wins; otherwise the newest prose row; otherwise null.
 */
export function screenActivityLine(lines: readonly string[]): string | null {
  const text = activityText(lines);
  return text === null ? null : stripPrivateUse(text).slice(0, MAX_CHARS).trimEnd();
}

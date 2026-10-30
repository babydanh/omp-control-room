/**
 * Plain text for a herdr screen: the text a reader copies. Colour escapes are dropped,
 * private-use glyphs (Nerd Font icons and the like) are removed because a terminal draws
 * them and the clipboard cannot use them, and trailing spaces and blank rows are trimmed.
 */

import { parseAnsiScreen } from './terminalScreen.js';

/** The Basic Multilingual Plane private-use area, and planes 15 and 16 (supplementary). */
const PRIVATE_USE = /[\uE000-\uF8FF]|[\u{F0000}-\u{FFFFD}\u{100000}-\u{10FFFD}]/gu;

export function stripPrivateUse(text: string): string {
  return text.replace(PRIVATE_USE, '');
}

export function screenPlainText(text: string): string {
  const rows = parseAnsiScreen(text).map((line) =>
    stripPrivateUse(line.map((segment) => segment.text).join('')).trimEnd(),
  );
  let end = rows.length;
  while (end > 0 && rows[end - 1] === '') end -= 1;
  return rows.slice(0, end).join('\n');
}

/** A piece of a screen row: plain text, or an http(s) link the reader can open. */
export interface LinkPiece {
  readonly text: string;
  readonly href?: string;
}

const URL_PATTERN = /https?:\/\/[^\s<>"'`]+/g;
const TRAILING_PUNCTUATION = /[.,;:!?]$/;

/** The URL without the punctuation a sentence puts after it, and without a closing bracket it never opened. */
function trimUrl(url: string): string {
  let end = url;
  for (;;) {
    if (TRAILING_PUNCTUATION.test(end)) end = end.slice(0, -1);
    else if (/[)\]}]$/.test(end) && !hasOpenFor(end)) end = end.slice(0, -1);
    else return end;
  }
}

function hasOpenFor(url: string): boolean {
  const closer = url[url.length - 1] ?? '';
  const opener = closer === ')' ? '(' : closer === ']' ? '[' : '{';
  return url.split(opener).length >= url.split(closer).length;
}

/** Splits one screen row into text and http(s) links; other schemes stay text. */
export function splitLinks(row: string): LinkPiece[] {
  const pieces: LinkPiece[] = [];
  let from = 0;
  for (const match of row.matchAll(URL_PATTERN)) {
    const url = trimUrl(match[0]);
    if (url === 'http://' || url === 'https://') continue;
    if (match.index > from) pieces.push({ text: row.slice(from, match.index) });
    pieces.push({ text: url, href: url });
    from = match.index + url.length;
  }
  if (from < row.length) pieces.push({ text: row.slice(from) });
  return pieces;
}

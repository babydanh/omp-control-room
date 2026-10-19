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

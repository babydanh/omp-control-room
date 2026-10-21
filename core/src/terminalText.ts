/**
 * Terminal text as a person reads it: the escape sequences a terminal screen carries (colours,
 * cursor moves, window titles) are dropped. A pane's last screen becomes a work item's result, so
 * without this the board would print `ESC[38;2;177;185;249m` among the words.
 */

const ESC = '\u001b';
const BEL = '\u0007';

/** CSI (`ESC [ … final`), OSC (`ESC ] … BEL` or `ESC ] … ESC \`), and two-byte `ESC x` sequences. */
const TERMINAL_ESCAPE = new RegExp(
  `${ESC}\\[[0-?]*[ -/]*[@-~]|${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)|${ESC}[@-Z\\\\-_]`,
  'g',
);

export function withoutTerminalEscapes(text: string): string {
  return text.replace(TERMINAL_ESCAPE, '');
}

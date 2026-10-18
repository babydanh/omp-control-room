/**
 * Locate a submitted command inside captured terminal lines. The command and
 * the lines are compared after the same whitespace collapse, so wrapping or
 * padding in the captured output does not hide the match.
 */

/** Longest prefix of a command matched against lines, in code points. */
export const COMMAND_NEEDLE_MAX_CHARS = 80;

/** Collapse whitespace runs to one space and trim both ends, for needle and lines alike. */
function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** The text searched for in terminal output; null when the command is blank. */
export function commandNeedle(command: string): string | null {
  const collapsed = collapseWhitespace(command);
  if (collapsed === '') return null;
  return Array.from(collapsed).slice(0, COMMAND_NEEDLE_MAX_CHARS).join('');
}

/** Index of the newest line that contains the command, or null when none does. */
export function findCommandLine(lines: readonly string[], command: string): number | null {
  const needle = commandNeedle(command);
  if (needle === null) return null;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (collapseWhitespace(lines[index]).includes(needle)) return index;
  }
  return null;
}

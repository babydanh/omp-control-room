/** Lines of the dead session's last screen worth keeping (ssh's own error text, tmux's "[exited]"). */
const EXIT_KEEP_LINES = 6;

/**
 * What a cloud terminal shows once its SSH session is over. tmux leaves a coloured background active when it quits,
 * and xterm paints every erased cell with it: the whole pane turned theme-green. The screen is reset and only the
 * last few non-empty lines are written back, with the reason in dim text.
 */
export function exitScreen(lines: readonly string[], reason: string): string {
  const kept = lines.map((line) => line.trimEnd()).filter((line) => line !== '').slice(-EXIT_KEEP_LINES);
  const body = kept.length > 0 ? `${kept.join('\r\n')}\r\n\r\n` : '';
  return `\x1b[0m${body}\x1b[2m${reason}\x1b[0m`;
}

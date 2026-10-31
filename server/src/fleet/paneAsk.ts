import { FLEET_PEEK_DUMP_LINES, FLEET_PEEK_MARKER, FLEET_PEEK_TAIL_LINES } from './constants.js';

/**
 * Reading what a Claude Code pane asks of the user. Claude cloud sessions have no board-side channel for a question or a
 * permission prompt (omp has one), so the board reads the bottom of the tmux pane: a numbered menu with its footer hint.
 */

const MENU_OPTION = /^\s*(?:[❯>]\s*)?1\.\s+\S/;
const MENU_FOOTER = /Esc to cancel|Enter to select|to navigate/;

/** True when the bottom of the screen is a Claude Code menu waiting for a choice (a numbered list alone is not one). */
export function screenAsksUser(screen: string): boolean {
  // The rows under the last text are an empty screen, not content: a fresh pane has its menu near the top.
  const bottom = screen.trimEnd().split('\n').slice(-FLEET_PEEK_TAIL_LINES);
  return bottom.some((line) => MENU_OPTION.test(line)) && bottom.some((line) => MENU_FOOTER.test(line));
}

/** One remote shell line: the bottom of every tmux session's active pane, each under a marker line. Names never reach it. */
export const PANE_PEEK_SCRIPT =
  `tmux list-sessions -F '#{session_name}' 2>/dev/null | while IFS= read -r s; do ` +
  `echo "${FLEET_PEEK_MARKER} $s"; tmux capture-pane -p -t "=$s:" 2>/dev/null | tail -n ${FLEET_PEEK_DUMP_LINES}; done`;

/** The sessions of a peek dump whose screen asks the user something. */
export function parsePanePeek(dump: string): Set<string> {
  const asking = new Set<string>();
  let session: string | null = null;
  let screen: string[] = [];
  const close = (): void => {
    if (session !== null && screenAsksUser(screen.join('\n'))) asking.add(session);
  };
  for (const line of dump.split('\n')) {
    if (line.startsWith(`${FLEET_PEEK_MARKER} `)) {
      close();
      session = line.slice(FLEET_PEEK_MARKER.length + 1).trim();
      screen = [];
    } else if (session !== null) {
      screen.push(line);
    }
  }
  close();
  return asking;
}

// ── Company Terminal (xterm) ─────────────────────────────────
/**
 * xterm needs concrete color strings, not CSS vars, so they live here. The
 * sixteen ANSI colors are shared with the herdr screen renderer, so a terminal
 * and a herdr pane read the same way on the board.
 */
export const TERMINAL_THEME = {
  background: '#1e1e2e',
  foreground: '#cdd6f4',
  cursor: '#cdd6f4',
  selectionBackground: '#45475a',
  black: '#45475a',
  red: '#f38ba8',
  green: '#a6e3a1',
  yellow: '#f9e2af',
  blue: '#89b4fa',
  magenta: '#f5c2e7',
  cyan: '#94e2d5',
  white: '#bac2de',
  brightBlack: '#585b70',
  brightRed: '#f38ba8',
  brightGreen: '#a6e3a1',
  brightYellow: '#f9e2af',
  brightBlue: '#89b4fa',
  brightMagenta: '#f5c2e7',
  brightCyan: '#94e2d5',
  brightWhite: '#a6adc8',
} as const;

/** The sixteen ANSI colors in SGR order: 30-37 then 90-97, indexed 0-15. */
export const TERMINAL_ANSI_COLORS: readonly string[] = [
  TERMINAL_THEME.black,
  TERMINAL_THEME.red,
  TERMINAL_THEME.green,
  TERMINAL_THEME.yellow,
  TERMINAL_THEME.blue,
  TERMINAL_THEME.magenta,
  TERMINAL_THEME.cyan,
  TERMINAL_THEME.white,
  TERMINAL_THEME.brightBlack,
  TERMINAL_THEME.brightRed,
  TERMINAL_THEME.brightGreen,
  TERMINAL_THEME.brightYellow,
  TERMINAL_THEME.brightBlue,
  TERMINAL_THEME.brightMagenta,
  TERMINAL_THEME.brightCyan,
  TERMINAL_THEME.brightWhite,
];
export const TERMINAL_FONT_SIZE_PX = 13;
export const TERMINAL_SCROLLBACK_LINES = 5000;
/** Largest single input chunk, matching COMPANY_TERMINAL_INPUT_MAX_BYTES. */
export const TERMINAL_INPUT_CHUNK_MAX_BYTES = 8 * 1024;

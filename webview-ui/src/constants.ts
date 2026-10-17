// ── Company Terminal (xterm) ─────────────────────────────────
/** xterm needs concrete color strings, not CSS vars, so they live here. */
export const TERMINAL_THEME = {
  background: '#1e1e2e',
  foreground: '#cdd6f4',
  cursor: '#cdd6f4',
  selectionBackground: '#45475a',
} as const;
export const TERMINAL_FONT_SIZE_PX = 13;
export const TERMINAL_SCROLLBACK_LINES = 5000;
/** Largest single input chunk, matching COMPANY_TERMINAL_INPUT_MAX_BYTES. */
export const TERMINAL_INPUT_CHUNK_MAX_BYTES = 8 * 1024;

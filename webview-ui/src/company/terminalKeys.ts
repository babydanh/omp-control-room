/**
 * terminalClipboardKey: what Ctrl+C and Ctrl+V do inside the board's terminal. A terminal sends
 * Ctrl+C to the program as an interrupt, so it copies only while text is selected; with nothing
 * selected it still interrupts. Ctrl+V is left to the browser's paste, which xterm turns into
 * input, instead of sending a literal ^V.
 */

export interface TerminalKeyEvent {
  readonly type: string;
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
}

export type TerminalClipboardAction = 'copy' | 'paste';

export function terminalClipboardKey(event: TerminalKeyEvent, hasSelection: boolean): TerminalClipboardAction | null {
  if (event.type !== 'keydown' || !event.ctrlKey || event.altKey || event.metaKey) return null;
  const key = event.key.toLowerCase();
  if (key === 'c') return hasSelection ? 'copy' : null;
  if (key === 'v') return 'paste';
  return null;
}

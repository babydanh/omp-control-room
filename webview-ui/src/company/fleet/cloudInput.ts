/**
 * Typing into a cloud session from outside its terminal pane (the composer). The terminal component owns the socket;
 * it registers a writer here while it is mounted, so the composer needs no server command of its own.
 */
type Writer = (data: string) => boolean;

const writers = new Map<number, Writer>();

/** Pause between the paste and the Enter, so the agent's input box has taken the text before it is submitted. */
export const CLOUD_ENTER_DELAY_MS = 150;

const PASTE_START = '\u001b[200~';
const PASTE_END = '\u001b[201~';

/** Registers the writer of a connected terminal; the returned function removes only this registration. */
export function registerCloudInput(terminalId: number, write: Writer): () => void {
  writers.set(terminalId, write);
  return () => {
    if (writers.get(terminalId) === write) writers.delete(terminalId);
  };
}

/**
 * Types `text` into the terminal as one bracketed paste (a line break stays a line break, not a submit), then Enter.
 * False when the terminal is not connected, the line is empty or the write was refused: nothing was sent.
 */
export function sendCloudLine(terminalId: number, text: string): boolean {
  const write = writers.get(terminalId);
  const line = text.trim();
  if (write === undefined || line === '') return false;
  if (!write(`${PASTE_START}${line}${PASTE_END}`)) return false;
  setTimeout(() => write('\r'), CLOUD_ENTER_DELAY_MS);
  return true;
}

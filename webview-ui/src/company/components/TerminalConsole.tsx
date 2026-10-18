import '@xterm/xterm/css/xterm.css';

import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import { useEffect, useRef } from 'react';

import {
  TERMINAL_FONT_SIZE_PX,
  TERMINAL_SCROLLBACK_LINES,
  TERMINAL_THEME,
} from '../../constants.js';
import type { TerminalFrame } from '../companyState.js';

/**
 * TerminalConsole: the faithful view of one managed PTY.
 *
 * This component is PRESENTATION ONLY. It holds no transport subscription, no
 * attach protocol and no input queue: the company client owns all of that, and
 * this paints the frames it was handed. That split is deliberate -- the app has
 * exactly one place that talks to the server, and a terminal is not a second
 * one.
 *
 * The rules that keep it faithful:
 *  - Frames are matched on (sessionId, runEpoch) and de-duplicated by `seq`, so
 *    output from a restarted session can never be painted into a live one.
 *  - Bytes arrive base64-encoded and are handed to xterm as raw bytes, so a
 *    UTF-8 sequence split across two frames is not mangled by a lossy string
 *    decode.
 *  - A `snapshot` frame RESETS the screen: the server's framebuffer replaces
 *    whatever was painted, instead of an ANSI ring being replayed on top of it.
 *  - Keystrokes are handed to `onInput` once; the client sends them (or refuses
 *    to, when the socket is down) and never queues them for a later reconnect.
 */

export interface TerminalConsoleProps {
  sessionId: string;
  runEpoch: number;
  attached: boolean;
  /** Frames received for this session and epoch, in order. */
  frames: readonly TerminalFrame[];
  /** Set when the client fell behind and needs a fresh screen. */
  overflow: boolean;
  closedReason: string | null;
  /** Keep these stable (useCallback): the terminal is rebuilt when they change. */
  onInput: (data: string) => void;
  onResize: (cols: number, rows: number) => void;
  onOverflow: () => void;
}

/** Decode base64 transport payloads into the bytes xterm expects. */
function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export function TerminalConsole({
  sessionId,
  runEpoch,
  attached,
  frames,
  overflow,
  closedReason,
  onInput,
  onResize,
  onOverflow,
}: TerminalConsoleProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const lastSeqRef = useRef(0);
  /** Writes after unmount would leak; this guards the async paths. */
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    lastSeqRef.current = 0;
    const container = containerRef.current;
    if (!container) return undefined;

    const terminal = new Terminal({
      convertEol: false,
      cursorBlink: true,
      // No fontFamily override: xterm's default monospace stack is what a
      // terminal needs for column alignment, and the pixel UI font is not
      // monospaced.
      fontSize: TERMINAL_FONT_SIZE_PX,
      scrollback: TERMINAL_SCROLLBACK_LINES,
      theme: TERMINAL_THEME,
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(container);
    terminalRef.current = terminal;
    fit.fit();

    const inputSubscription = terminal.onData((data) => {
      if (aliveRef.current) onInput(data);
    });

    const observer = new ResizeObserver(() => {
      fit.fit();
      if (aliveRef.current) onResize(terminal.cols, terminal.rows);
    });
    observer.observe(container);

    return () => {
      aliveRef.current = false;
      observer.disconnect();
      inputSubscription.dispose();
      terminalRef.current = null;
      terminal.dispose();
    };
    // A new epoch is a new process: remount rather than reuse the view.
  }, [sessionId, runEpoch, onInput, onResize]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (attached && terminal && aliveRef.current) onResize(terminal.cols, terminal.rows);
  }, [attached, onResize]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal || !aliveRef.current) return;
    for (const frame of frames) {
      if (frame.seq <= lastSeqRef.current) continue;
      lastSeqRef.current = frame.seq;
      if (frame.kind === 'snapshot') terminal.reset();
      terminal.write(decodeBase64(frame.data));
    }
  }, [frames]);

  useEffect(() => {
    if (overflow && aliveRef.current) onOverflow();
  }, [overflow, onOverflow]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between border-b border-border px-3 py-1 text-xs">
        <span className="text-text-muted">
          {sessionId.slice(0, 8)} &middot; kỳ {runEpoch}
        </span>
        <span className={closedReason ? 'text-warning' : 'text-text-muted'}>
          {closedReason ? `đã kết thúc: ${closedReason}` : 'đang chạy'}
        </span>
      </div>
      <div ref={containerRef} className="min-h-0 flex-1" data-testid="terminal-console" />
    </div>
  );
}

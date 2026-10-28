import '@xterm/xterm/css/xterm.css';

import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import { useEffect, useRef } from 'react';

import {
  TERMINAL_FONT_SIZE_PX,
  TERMINAL_SCROLLBACK_LINES,
  TERMINAL_THEME,
} from '../../constants.js';
import { copyText } from '../clipboard.js';
import { findCommandLine } from '../commandLine.js';
import type { TerminalFrame } from '../companyState.js';
import { frameWrites } from '../terminalFrames.js';
import { terminalClipboardKey } from '../terminalKeys.js';

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

/** A command the Hoạt động tab asked this terminal to find. */
export interface TerminalJump {
  /** Bumped per request, so a second click on the same row still jumps. */
  seq: number;
  command: string;
  /** The command's own output from the log, shown when it is gone from the buffer. */
  output: string | null;
}

export interface TerminalConsoleProps {
  sessionId: string;
  runEpoch: number;
  attached: boolean;
  /** Frames received for this session and epoch, in order. */
  frames: readonly TerminalFrame[];
  closedReason: string | null;
  /** Keep these stable (useCallback): the terminal is rebuilt when they change. */
  onInput: (data: string) => void;
  onResize: (cols: number, rows: number) => void;
  /** Output this view never painted was dropped; asks once for a fresh screen. */
  onFellBehind: () => void;
  /** A command the Hoạt động tab asked to find; answered once per seq. */
  jump: TerminalJump | null;
  /** Called with the seq of a jump whose command is not in the buffer. */
  onJumpMissed: (seq: number) => void;
}

export function TerminalConsole({
  sessionId,
  runEpoch,
  attached,
  frames,
  closedReason,
  onInput,
  onResize,
  onFellBehind,
  jump,
  onJumpMissed,
}: TerminalConsoleProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const lastSeqRef = useRef(0);
  /** Writes after unmount would leak; this guards the async paths. */
  const aliveRef = useRef(true);
  /** True once a snapshot has been painted into the current xterm. */
  const writtenSnapshotRef = useRef(false);
  /** True after asking for a fresh screen, until a snapshot is painted. */
  const awaitingSnapshotRef = useRef(false);
  /** The jump request this xterm has already answered. */
  const handledJumpRef = useRef<number | null>(null);

  useEffect(() => {
    aliveRef.current = true;
    lastSeqRef.current = 0;
    writtenSnapshotRef.current = false;
    awaitingSnapshotRef.current = false;
    handledJumpRef.current = null;
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

    // Ctrl+C copies a selection (else it interrupts); Ctrl+V pastes. Returning false keeps xterm
    // from also sending the key to the program.
    terminal.attachCustomKeyEventHandler((event) => {
      const action = terminalClipboardKey(event, terminal.hasSelection());
      if (action === 'copy') void copyText(terminal.getSelection());
      return action === null;
    });
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
    const batch = frameWrites(frames, lastSeqRef.current);
    if (batch.missed) {
      // Painting past a gap would garble the screen and its scrollback.
      if (!awaitingSnapshotRef.current) onFellBehind();
      awaitingSnapshotRef.current = true;
      return;
    }
    lastSeqRef.current = batch.lastSeq;
    if (batch.sawSnapshot) {
      writtenSnapshotRef.current = true;
      awaitingSnapshotRef.current = false;
    }
    for (const write of batch.writes) {
      if (write.reset) terminal.reset();
      terminal.write(write.bytes);
    }
  }, [frames, onFellBehind]);

  // A command the Hoạt động tab jumped to: once the snapshot is painted, find its line
  // in the buffer, select it and scroll there. A miss is reported, never guessed.
  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal || !aliveRef.current || jump === null) return;
    if (!writtenSnapshotRef.current || handledJumpRef.current === jump.seq) return;
    handledJumpRef.current = jump.seq;
    const { seq, command } = jump;
    // xterm parses queued writes in order, so this callback runs after them.
    terminal.write('', () => {
      if (!aliveRef.current) return;
      const buffer = terminal.buffer.active;
      const lines: string[] = [];
      for (let row = 0; row < buffer.length; row += 1) {
        lines.push(buffer.getLine(row)?.translateToString(true) ?? '');
      }
      const row = findCommandLine(lines, command);
      if (row === null) {
        onJumpMissed(seq);
        return;
      }
      terminal.select(0, row, Math.max(1, (lines[row] ?? '').length));
      terminal.scrollToLine(row);
    });
  }, [frames, jump, onJumpMissed]);

  return (
    <div className="flex h-full min-h-0 flex-col rounded-(--company-radius-md) bg-well p-3">
      <div className="flex items-center justify-between pb-2 text-xs">
        <span className="text-text-muted">
          {sessionId.slice(0, 8)} &middot; kỳ {runEpoch}
        </span>
        <span className={closedReason ? 'text-warning' : 'text-text-muted'}>
          {closedReason ? `đã kết thúc: ${closedReason}` : 'đang chạy'}
        </span>
      </div>
      <div
        ref={containerRef}
        className="min-h-0 min-w-0 flex-1 overflow-hidden"
        data-testid="terminal-console"
      />
    </div>
  );
}

/**
 * TerminalMirror: a live terminal painted into a preview, with no console of its
 * own. It keeps an unopened xterm fed with the same frames the drawer's console
 * gets, and paints the last rows of its screen as coloured text. The lease it
 * needs is held as the 'preview' holder, so closing the preview releases it unless
 * the drawer still holds the same terminal.
 */

import { Terminal } from '@xterm/xterm';
import { useEffect, useRef, useState } from 'react';

import {
  TERMINAL_FONT_SIZE_PX,
  TERMINAL_SCROLLBACK_LINES,
  TERMINAL_THEME,
} from '../../constants.js';
import type { CompanyClient } from '../companyClient.js';
import type { TerminalFrame, TerminalView } from '../companyState.js';
import { frameWrites } from '../terminalFrames.js';
import { bufferLineSegments, type ScreenLine, tailScreen } from '../terminalScreen.js';
import { ScreenView } from './ScreenView.js';

/** Used until the lease reports the shared PTY size. */
const MIRROR_DEFAULT_COLS = 120;
const MIRROR_DEFAULT_ROWS = 40;
const NO_FRAMES: readonly TerminalFrame[] = [];

export interface TerminalMirrorProps {
  client: CompanyClient;
  sessionId: string;
  runEpoch: number;
  terminal: TerminalView | undefined;
  /** How many rows of the screen to paint, counted from the last used row. */
  rows: number;
}

export function TerminalMirror({
  client,
  sessionId,
  runEpoch,
  terminal,
  rows,
}: TerminalMirrorProps) {
  const [screen, setScreen] = useState<readonly ScreenLine[]>([]);
  const xtermRef = useRef<Terminal | null>(null);
  const lastSeqRef = useRef(0);
  const frames = terminal?.frames ?? NO_FRAMES;
  const overflow = terminal?.overflow ?? false;
  const cols = terminal?.cols ?? MIRROR_DEFAULT_COLS;
  const termRows = terminal?.rows ?? MIRROR_DEFAULT_ROWS;

  // The lease is held for as long as this mirror is mounted.
  useEffect(() => client.holdTerminal(sessionId, 'preview'), [client, sessionId, runEpoch]);

  // A fresh xterm per run. It is never opened on the page, only read.
  useEffect(() => {
    const xterm = new Terminal({
      cols: MIRROR_DEFAULT_COLS,
      rows: MIRROR_DEFAULT_ROWS,
      convertEol: false,
      disableStdin: true,
      fontSize: TERMINAL_FONT_SIZE_PX,
      scrollback: TERMINAL_SCROLLBACK_LINES,
      theme: TERMINAL_THEME,
    });
    xtermRef.current = xterm;
    lastSeqRef.current = 0;
    return () => {
      xtermRef.current = null;
      xterm.dispose();
    };
  }, [sessionId, runEpoch]);

  useEffect(() => {
    xtermRef.current?.resize(cols, termRows);
  }, [cols, termRows, runEpoch]);

  useEffect(() => {
    const xterm = xtermRef.current;
    if (!xterm) return;
    const batch = frameWrites(frames, lastSeqRef.current);
    if (batch.writes.length === 0) return;
    lastSeqRef.current = batch.lastSeq;
    for (const write of batch.writes) {
      if (write.reset) xterm.reset();
      xterm.write(write.bytes);
    }
    // xterm parses queued writes in order, so this callback sees the whole batch.
    xterm.write('', () => {
      if (xtermRef.current === xterm) setScreen(tailScreen(screenRows(xterm), rows));
    });
  }, [frames, rows, runEpoch]);

  // A parked terminal that fell behind asks for a fresh screen, as the drawer does.
  useEffect(() => {
    if (overflow) client.attachTerminal(sessionId);
  }, [client, overflow, sessionId]);

  if (screen.length === 0) {
    return <p className="p-2 text-2xs text-text-muted">Đang chờ màn hình…</p>;
  }
  return <ScreenView lines={screen} className="min-h-0 flex-1 overflow-hidden p-2" />;
}

/** The viewport's rows as segments, top to bottom. */
function screenRows(xterm: Terminal): ScreenLine[] {
  const buffer = xterm.buffer.active;
  const lines: ScreenLine[] = [];
  for (let row = 0; row < xterm.rows; row += 1) {
    const line = buffer.getLine(buffer.baseY + row);
    lines.push(line ? bufferLineSegments(line) : []);
  }
  return lines;
}

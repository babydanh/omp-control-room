import { decodeBase64ToBytes } from './base64.js';
import type { TerminalFrame } from './companyState.js';

/**
 * Which terminal frames still need writing, and which of them reset the screen
 * first. Pure: the console applies the result to xterm.
 */

export interface FrameWrite {
  readonly reset: boolean;
  readonly bytes: Uint8Array;
}

export interface FrameWrites {
  readonly writes: readonly FrameWrite[];
  readonly lastSeq: number;
  readonly sawSnapshot: boolean;
  /**
   * Output this view never painted was dropped: a newer frame skips past the one
   * before it and no snapshot follows to replace the screen. Nothing is written;
   * the view needs a fresh screen.
   */
  readonly missed: boolean;
}

/** Decode a frame's base64 payload into the raw PTY bytes xterm expects. */
export function decodeFrameBytes(base64: string): Uint8Array {
  return decodeBase64ToBytes(base64);
}

/**
 * Plan the writes for frames newer than `afterSeq`, in order. Frames whose seq is
 * not beyond the running sequence are skipped; a snapshot frame resets the screen.
 */
export function frameWrites(frames: readonly TerminalFrame[], afterSeq: number): FrameWrites {
  const writes: FrameWrite[] = [];
  let lastSeq = afterSeq;
  let sawSnapshot = false;
  let missed = false;
  for (const frame of frames) {
    if (frame.seq <= lastSeq) continue;
    const reset = frame.kind === 'snapshot';
    // A snapshot replaces whatever a gap before it lost; a gap after it is new loss.
    if (reset) missed = false;
    else if (frame.seq !== lastSeq + 1) missed = true;
    lastSeq = frame.seq;
    if (reset) sawSnapshot = true;
    writes.push({ reset, bytes: decodeFrameBytes(frame.data) });
  }
  if (missed) return { writes: [], lastSeq: afterSeq, sawSnapshot: false, missed };
  return { writes, lastSeq, sawSnapshot, missed };
}

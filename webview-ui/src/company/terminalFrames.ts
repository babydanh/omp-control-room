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
  for (const frame of frames) {
    if (frame.seq <= lastSeq) continue;
    lastSeq = frame.seq;
    const reset = frame.kind === 'snapshot';
    if (reset) sawSnapshot = true;
    writes.push({ reset, bytes: decodeFrameBytes(frame.data) });
  }
  return { writes, lastSeq, sawSnapshot };
}

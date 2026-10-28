import { describe, expect, it } from 'vitest';

import type { TerminalFrame, TerminalFrameKind } from '../src/company/companyState.js';
import { decodeFrameBytes, frameWrites } from '../src/company/terminalFrames.js';

const frame = (seq: number, kind: TerminalFrameKind, text: string): TerminalFrame => ({
  seq,
  kind,
  data: btoa(text),
});

const decodeText = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

describe('decodeFrameBytes', () => {
  it('decodes base64 into raw bytes', () => {
    expect(Array.from(decodeFrameBytes(btoa('hi')))).toStrictEqual([104, 105]);
  });

  it('round-trips multi-byte UTF-8 without mangling it', () => {
    const utf8 = new TextEncoder().encode('é→漢');
    const base64 = btoa(String.fromCharCode(...utf8));
    expect(decodeFrameBytes(base64)).toStrictEqual(utf8);
  });
});

describe('frameWrites', () => {
  it('skips frames at or below afterSeq', () => {
    const result = frameWrites(
      [frame(1, 'data', 'a'), frame(2, 'data', 'b'), frame(3, 'data', 'c'), frame(4, 'data', 'd')],
      2,
    );
    expect(result.writes.map((write) => decodeText(write.bytes))).toStrictEqual(['c', 'd']);
    expect(result.lastSeq).toBe(4);
  });

  it('sets reset and sawSnapshot for a snapshot frame', () => {
    const result = frameWrites([frame(1, 'snapshot', 's'), frame(2, 'data', 'd')], 0);
    expect(result.writes.map((write) => write.reset)).toStrictEqual([true, false]);
    expect(result.writes.map((write) => decodeText(write.bytes))).toStrictEqual(['s', 'd']);
    expect(result.sawSnapshot).toBe(true);
  });

  it('does not reset for data frames', () => {
    const result = frameWrites([frame(1, 'data', 'x')], 0);
    const written = result.writes.map((write) => ({
      reset: write.reset,
      text: decodeText(write.bytes),
    }));
    expect(written).toStrictEqual([{ reset: false, text: 'x' }]);
    expect(result.sawSnapshot).toBe(false);
  });

  it('reports a gap instead of writing past output it never painted', () => {
    const result = frameWrites([frame(3, 'data', 'a'), frame(4, 'data', 'b')], 1);
    expect(result).toStrictEqual({ writes: [], lastSeq: 1, sawSnapshot: false, missed: true });
  });

  it('paints past a gap when the first newer frame is a snapshot', () => {
    const result = frameWrites([frame(7, 'snapshot', 's'), frame(8, 'data', 'd')], 2);
    expect(result.missed).toBe(false);
    expect(result.writes.map((write) => write.reset)).toStrictEqual([true, false]);
    expect(result.lastSeq).toBe(8);
  });

  it('writes nothing and keeps lastSeq when no frame is newer', () => {
    const result = frameWrites([frame(1, 'snapshot', 's')], 4);
    expect(result).toStrictEqual({ writes: [], lastSeq: 4, sawSnapshot: false, missed: false });
  });

  it('does not count a skipped snapshot toward sawSnapshot', () => {
    const result = frameWrites([frame(1, 'snapshot', 's')], 1);
    expect(result.sawSnapshot).toBe(false);
  });
});

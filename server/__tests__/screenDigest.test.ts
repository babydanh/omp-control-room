import { describe, expect, it } from 'vitest';

import { screenDigest } from '../src/herdr/screenDigest.js';

describe('screenDigest', () => {
  it('is the sha256 hex digest of the text', () => {
    expect(screenDigest('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('is deterministic for the same text, colour escapes and Vietnamese included', () => {
    const screen = '\u001b[31mđỏ\u001b[0m\r\ndòng hai';

    expect(screenDigest(screen)).toBe(screenDigest(screen));
  });

  it('differs when the text differs in any character', () => {
    expect(screenDigest('T0')).not.toBe(screenDigest('T1'));
    expect(screenDigest('dòng')).not.toBe(screenDigest('dòng '));
    expect(screenDigest('')).not.toBe(screenDigest(' '));
  });

  it('is 64 lowercase hex characters', () => {
    expect(screenDigest('màn hình')).toMatch(/^[0-9a-f]{64}$/);
  });
});

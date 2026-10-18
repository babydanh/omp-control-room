import { describe, expect, it } from 'vitest';

import { paneShortCode, sessionShortCode } from '../src/company/agentSidebarView.js';

describe('sessionShortCode', () => {
  it('reads a session code as its letter and its number, without padding', () => {
    expect(sessionShortCode('PA-S0002')).toBe('S2');
    expect(sessionShortCode('PA-S0010')).toBe('S10');
    expect(sessionShortCode('PA-S0000')).toBe('S0');
  });

  it('falls back to the first characters of a code with no number', () => {
    expect(sessionShortCode('ALPHABET')).toBe('ALPH');
  });
});

describe('paneShortCode', () => {
  it('reads a pane as its number', () => {
    expect(paneShortCode('pane-3')).toBe('3');
    expect(paneShortCode('w1-p012')).toBe('12');
  });

  it('falls back to the first characters of a pane id with no number', () => {
    expect(paneShortCode('abcdef')).toBe('abcd');
  });
});

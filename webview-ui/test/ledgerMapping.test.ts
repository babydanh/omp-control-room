import { describe, expect, it } from 'vitest';

import { boardSessionFor, type BoardSessionIndex } from '../src/company/ledger/ledgerMapping.js';

describe('boardSessionFor', () => {
  it('finds the board session whose native session is the ledger session', () => {
    const sessions: BoardSessionIndex = {
      'board-1': { nativeSessionId: 'abc' },
      'board-2': { nativeSessionId: 'def' },
      'board-3': {},
    };
    expect(boardSessionFor('abc', sessions)).toBe('board-1');
  });

  it('returns null when no board session has that native session', () => {
    const sessions: BoardSessionIndex = { 'board-1': { nativeSessionId: 'abc' } };
    expect(boardSessionFor('zzz', sessions)).toBeNull();
  });

  it('returns null when more than one board session claims the same native session', () => {
    const sessions: BoardSessionIndex = {
      'board-1': { nativeSessionId: 'abc' },
      'board-2': { nativeSessionId: 'abc' },
    };
    expect(boardSessionFor('abc', sessions)).toBeNull();
  });
});

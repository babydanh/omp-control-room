import { describe, expect, it } from 'vitest';

import { stopLedgerSession } from '../src/projects/sessionStop.js';
import { sessionRow } from './ledgerFixtures.js';

describe('stopLedgerSession', () => {
  const rows = [
    sessionRow('omp-1', { pid: 40 }),
    sessionRow('sub-1', { pid: 40, agentKind: 'sub' }),
    sessionRow('gone', { pid: 41, endedAt: '2026-10-21' }),
    sessionRow('dead', { pid: 42 }),
    sessionRow('board', { pid: 7 }),
    sessionRow('no-pid'),
  ];
  const run = (sessionId: string) => {
    const killed: number[] = [];
    stopLedgerSession(sessionId, {
      sessionRows: () => rows,
      isAlive: (pid) => pid !== 42,
      killTree: (pid) => killed.push(pid),
      selfPid: 7,
    });
    return killed;
  };

  it('ends the process tree of a live session', () => {
    expect(run('omp-1')).toEqual([40]);
  });

  it('refuses what it must not or cannot stop, killing nothing', () => {
    // A subagent shares its parent's process; the board never stops itself.
    for (const id of ['sub-1', 'gone', 'dead', 'board', 'no-pid', 'unknown']) {
      expect(() => run(id), id).toThrow();
    }
  });
});

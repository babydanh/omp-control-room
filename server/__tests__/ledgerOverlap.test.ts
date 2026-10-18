import { describe, expect, it } from 'vitest';

import {
  LEDGER_OVERLAP_INTERVAL_MS,
  LEDGER_REASON_OVERLAP_FAILED,
  LEDGER_REASON_OVERLAP_FORMAT,
  LEDGER_REASON_OVERLAP_TIMEOUT,
  LEDGER_REASON_OVERLAP_TOO_LARGE,
  LEDGER_REASON_OVERLAP_UNREADABLE,
} from '../src/ledger/constants.js';
import { OverlapScanner, parseOverlapResult } from '../src/ledger/overlap.js';
import type { ProcessResult } from '../src/ledger/processRunner.js';
import { LEDGER_NOW_MS, type ProcessReply, replyResult } from './ledgerFixtures.js';

const OK_CODES = [0, 1, 2];

const OVERLAP_JSON = JSON.stringify({
  repo: 'C:/Repo',
  base: 'origin/main@abcd1234',
  lanes: 2,
  pairs: [
    {
      a: 'C:/Repo-wt/a',
      b: 'C:/Repo-wt/b',
      a_label: 'feat/a',
      b_label: 'feat/b',
      conflicts: [
        { file: 'src/x.ts', hunks: [{ line: 10, symbol: 'f', ours: ['1'], theirs: ['2'] }] },
      ],
      auto: ['y.ts'],
    },
  ],
  main: [{ lane: 'C:/Repo', label: 'main', conflicts: [] }],
  pending: ['feat/c'],
  complete: true,
  budget: 60,
});

function parse(reply: ProcessReply) {
  return parseOverlapResult(replyResult(reply, OK_CODES));
}

describe('parseOverlapResult', () => {
  it('reads a clean finish into pairs, main lanes, and pending branches', () => {
    expect(parse({ code: 0, stdout: OVERLAP_JSON })).toEqual({
      ok: true,
      complete: true,
      base: 'origin/main@abcd1234',
      lanes: 2,
      pairs: [
        {
          a: 'C:/Repo-wt/a',
          b: 'C:/Repo-wt/b',
          aLabel: 'feat/a',
          bLabel: 'feat/b',
          conflicts: [
            {
              file: 'src/x.ts',
              hunks: [{ line: 10, symbol: 'f', ours: ['1'], theirs: ['2'] }],
            },
          ],
          auto: ['y.ts'],
        },
      ],
      main: [{ lane: 'C:/Repo', label: 'main', conflicts: [] }],
      pending: ['feat/c'],
    });
  });

  it('treats exit 1 (overlap found) as a complete finish', () => {
    expect(parse({ code: 1, stdout: OVERLAP_JSON })).toMatchObject({ ok: true, complete: true });
  });

  it('treats exit 2 (budget ran out) as incomplete, whatever the JSON says', () => {
    expect(parse({ code: 2, stdout: OVERLAP_JSON })).toMatchObject({ ok: true, complete: false });
  });

  it('treats a JSON complete:false as incomplete', () => {
    const json = JSON.stringify({ pairs: [], main: [], pending: [], complete: false });
    expect(parse({ code: 0, stdout: json })).toMatchObject({ ok: true, complete: false });
  });

  it('reports exit 3 with its stderr as the error', () => {
    expect(parse({ code: 3, stderr: '  boom \n' })).toEqual({ ok: false, error: 'boom' });
  });

  it('falls back to the generic error when exit 3 has no stderr', () => {
    expect(parse({ code: 3, stderr: '' })).toEqual({
      ok: false,
      error: LEDGER_REASON_OVERLAP_FAILED,
    });
  });

  it('reports a timeout as a timeout error', () => {
    expect(parse({ timedOut: true })).toEqual({ ok: false, error: LEDGER_REASON_OVERLAP_TIMEOUT });
  });

  it('reports truncated output as too large', () => {
    expect(parse({ code: 0, stdout: OVERLAP_JSON, truncated: true })).toEqual({
      ok: false,
      error: LEDGER_REASON_OVERLAP_TOO_LARGE,
    });
  });

  it('reports output that is not JSON as unreadable', () => {
    expect(parse({ code: 0, stdout: 'not json' })).toEqual({
      ok: false,
      error: LEDGER_REASON_OVERLAP_UNREADABLE,
    });
  });

  it('reports JSON without the expected arrays, or a scalar, as a format error', () => {
    expect(parse({ code: 0, stdout: '{"complete":true}' })).toEqual({
      ok: false,
      error: LEDGER_REASON_OVERLAP_FORMAT,
    });
    expect(parse({ code: 0, stdout: '5' })).toEqual({
      ok: false,
      error: LEDGER_REASON_OVERLAP_FORMAT,
    });
  });
});

describe('OverlapScanner', () => {
  it('starts a scan with the exact argv and never passes --notify', () => {
    const seen: string[][] = [];
    const scanner = new OverlapScanner({
      run: (argv) => {
        seen.push([...argv]);
        return new Promise<ProcessResult>(() => {});
      },
      now: () => LEDGER_NOW_MS,
      onSettled: () => {},
    });

    scanner.enqueueIfDue('C:/Repo', 2);

    expect(seen).toEqual([['C:/Repo', '--json', '--base', 'origin/main', '--budget', '60']]);
    expect(seen[0]).not.toContain('--notify');
  });

  it('does not scan a repo with fewer than two checkouts', () => {
    let runs = 0;
    const scanner = new OverlapScanner({
      run: () => {
        runs += 1;
        return new Promise<ProcessResult>(() => {});
      },
      now: () => LEDGER_NOW_MS,
      onSettled: () => {},
    });
    scanner.enqueueIfDue('C:/Repo', 1);
    expect(runs).toBe(0);
  });

  it('settles a finished scan, then waits the full interval before scanning again', async () => {
    let nowMs = LEDGER_NOW_MS;
    let runs = 0;
    const settled: string[] = [];
    const scanner = new OverlapScanner({
      run: () => {
        runs += 1;
        return Promise.resolve(replyResult({ code: 0, stdout: OVERLAP_JSON }, OK_CODES));
      },
      now: () => nowMs,
      onSettled: (repo) => settled.push(repo),
    });

    scanner.enqueueIfDue('C:/Repo', 2);
    await scanner.idle();
    expect(scanner.snapshot('C:/Repo')).toMatchObject({
      state: 'done',
      complete: true,
      lanes: 2,
      error: null,
    });
    expect(settled).toEqual(['C:/Repo']);

    nowMs += LEDGER_OVERLAP_INTERVAL_MS - 1;
    scanner.enqueueIfDue('C:/Repo', 2);
    expect(runs).toBe(1);

    nowMs += 1;
    scanner.enqueueIfDue('C:/Repo', 2);
    await scanner.idle();
    expect(runs).toBe(2);
  });

  it('marks a scan that ran out of budget as partial', async () => {
    const scanner = new OverlapScanner({
      run: () => Promise.resolve(replyResult({ code: 2, stdout: OVERLAP_JSON }, OK_CODES)),
      now: () => LEDGER_NOW_MS,
      onSettled: () => {},
    });
    scanner.enqueueIfDue('C:/Repo', 2);
    await scanner.idle();
    expect(scanner.snapshot('C:/Repo')).toMatchObject({ state: 'partial', complete: false });
  });

  it('marks a failed scan as error with its message and clears the results', async () => {
    const scanner = new OverlapScanner({
      run: () => Promise.resolve(replyResult({ code: 3, stderr: 'boom' }, OK_CODES)),
      now: () => LEDGER_NOW_MS,
      onSettled: () => {},
    });
    scanner.enqueueIfDue('C:/Repo', 2);
    await scanner.idle();
    expect(scanner.snapshot('C:/Repo')).toMatchObject({
      state: 'error',
      error: 'boom',
      lanes: 0,
      pairs: [],
    });
  });

  it('turns a runner that throws into an error state', async () => {
    const scanner = new OverlapScanner({
      run: () => Promise.reject(new Error('spawn failed')),
      now: () => LEDGER_NOW_MS,
      onSettled: () => {},
    });
    scanner.enqueueIfDue('C:/Repo', 2);
    await scanner.idle();
    expect(scanner.snapshot('C:/Repo')).toMatchObject({ state: 'error', error: 'spawn failed' });
  });
});

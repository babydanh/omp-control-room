import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { CompanySessionLogEntry } from '../../core/src/company.js';
import type { ServerMessage } from '../../core/src/messages.js';
import { applyCompanyMessage, mergeSessionLog } from '../src/company/companyState.js';
import { COMPANY_SESSION_LOG_MAX_ENTRIES } from '../src/company/constants.js';
import {
  commandExitLabel,
  commandTone,
  formatLogTime,
  LOG_KIND_LABELS,
  logEntriesFor,
  logIsReplaying,
  logTone,
  splitCommandText,
} from '../src/company/sessionLogView.js';
import { session, snapshot, stateFrom, task } from './companyFixtures.js';

function entry(overrides: Partial<CompanySessionLogEntry> = {}): CompanySessionLogEntry {
  return {
    seq: 1,
    at: '2026-10-02T10:00:00.000Z',
    kind: 'text',
    runEpoch: 1,
    text: 'hello',
    ...overrides,
  };
}

function logMessage(
  sessionId: string,
  entries: CompanySessionLogEntry[],
  replay: boolean,
): ServerMessage {
  return { type: 'companySessionLog', sessionId, replay, entries };
}

describe('mergeSessionLog', () => {
  it('keeps one entry per seq, ascending, and the newer delivery of a seq wins', () => {
    const first = mergeSessionLog(
      undefined,
      'session-1',
      [entry({ seq: 2, text: 'two' }), entry({ seq: 1, text: 'one' })],
      true,
    );
    expect(first.entries.map((item) => item.seq)).toEqual([1, 2]);

    const second = mergeSessionLog(
      first,
      'session-1',
      [entry({ seq: 2, text: 'two, revised' }), entry({ seq: 3, text: 'three' })],
      false,
    );
    expect(second.entries.map((item) => item.seq)).toEqual([1, 2, 3]);
    expect(second.entries[1]?.text).toBe('two, revised');
  });

  it('is replayed once a replay has finished, and stays so', () => {
    const replayed = mergeSessionLog(undefined, 'session-1', [], true);
    expect(replayed.replayed).toBe(true);
    expect(mergeSessionLog(replayed, 'session-1', [], false).replayed).toBe(true);
    expect(mergeSessionLog(undefined, 'session-1', [], false).replayed).toBe(false);
  });

  it('drops the oldest entries once the cap is passed', () => {
    const incoming = Array.from({ length: COMPANY_SESSION_LOG_MAX_ENTRIES + 5 }, (_, index) =>
      entry({ seq: index + 1 }),
    );

    const merged = mergeSessionLog(undefined, 'session-1', incoming, false);

    expect(merged.entries).toHaveLength(COMPANY_SESSION_LOG_MAX_ENTRIES);
    expect(merged.entries[0]?.seq).toBe(6);
    expect(merged.entries.at(-1)?.seq).toBe(COMPANY_SESSION_LOG_MAX_ENTRIES + 5);
  });
});

describe('companySessionLog reducer', () => {
  it('stores the entries under their session and records whether the replay finished', () => {
    const worker = session();
    const result = applyCompanyMessage(
      stateFrom({ sessions: [worker] }),
      logMessage(worker.id, [entry({ seq: 1 })], true),
    );

    expect(result.state.sessionLogs[worker.id]).toEqual({
      sessionId: worker.id,
      entries: [entry({ seq: 1 })],
      replayed: true,
    });
  });

  it("drops a removed session's log along with the session", () => {
    const worker = session();
    const logged = applyCompanyMessage(
      stateFrom({ revision: 4, sessions: [worker] }),
      logMessage(worker.id, [entry()], true),
    ).state;

    const removed = applyCompanyMessage(logged, {
      type: 'companyStateChanged',
      revision: 5,
      changes: [{ entity: 'session', op: 'remove', id: worker.id }],
    }).state;

    expect(removed.sessions[worker.id]).toBeUndefined();
    expect(removed.sessionLogs[worker.id]).toBeUndefined();
  });

  it('drops logs of sessions a snapshot no longer lists, and keeps the rest', () => {
    const kept = session();
    const gone = session();
    const logged = applyCompanyMessage(
      stateFrom({ revision: 4, sessions: [kept, gone] }),
      logMessage(kept.id, [entry()], true),
    ).state;
    const withGone = applyCompanyMessage(logged, logMessage(gone.id, [entry()], true)).state;

    const resynced = applyCompanyMessage(withGone, {
      type: 'companySnapshot',
      requestId: randomUUID(),
      snapshot: snapshot({ revision: 9, sessions: [kept] }),
    }).state;

    expect(resynced.sessionLogs[kept.id]).toBeDefined();
    expect(resynced.sessionLogs[gone.id]).toBeUndefined();
  });
});

describe('sessionLogView', () => {
  it('narrows a session log to one task when a task is the subject', () => {
    const worker = session();
    const first = task({ code: 'PA-T0001' });
    const second = task({ code: 'PA-T0002' });
    const state = applyCompanyMessage(
      stateFrom({ sessions: [worker], tasks: [first, second] }),
      logMessage(
        worker.id,
        [
          entry({ seq: 1, taskId: first.id }),
          entry({ seq: 2, taskId: second.id }),
          entry({ seq: 3 }),
        ],
        true,
      ),
    ).state;

    expect(logEntriesFor(state, worker.id, first.id).map((item) => item.seq)).toEqual([1]);
    expect(logEntriesFor(state, worker.id, null).map((item) => item.seq)).toEqual([1, 2, 3]);
    expect(logEntriesFor(state, 'unknown-session', null)).toEqual([]);
  });

  it('reports a log as replaying until the server finishes its replay', () => {
    const worker = session();
    const base = stateFrom({ sessions: [worker] });
    const live = applyCompanyMessage(base, logMessage(worker.id, [entry()], false)).state;
    const replayed = applyCompanyMessage(base, logMessage(worker.id, [entry()], true)).state;

    expect(logIsReplaying(live, worker.id)).toBe(true);
    expect(logIsReplaying(replayed, worker.id)).toBe(false);
    expect(logIsReplaying(base, worker.id)).toBe(false);
  });

  it('colours verdicts by their outcome and keeps unknown outcomes neutral', () => {
    expect(logTone(entry({ kind: 'verdict', ok: true }))).toBe('ok');
    expect(logTone(entry({ kind: 'verdict', ok: false }))).toBe('fail');
    expect(logTone(entry({ kind: 'verdict' }))).toBe('text');
    expect(logTone(entry({ kind: 'question' }))).toBe('ask');
    expect(logTone(entry({ kind: 'error' }))).toBe('fail');
    expect(logTone(entry({ kind: 'state' }))).toBe('state');
    expect(LOG_KIND_LABELS.command).toBe('lệnh');
  });

  it('splits a command entry into its command line and its output tail', () => {
    expect(splitCommandText('npm test')).toEqual({ command: 'npm test', output: null });
    expect(splitCommandText('npm test\nline 1\nline 2\n\n')).toEqual({
      command: 'npm test',
      output: 'line 1\nline 2',
    });
    expect(splitCommandText('npm test\n   \n')).toEqual({ command: 'npm test', output: null });
  });

  it('calls a command passed only with exit 0 and no ok:false, and running while it has no exit code', () => {
    expect(commandTone(entry({ kind: 'command' }))).toBe('running');
    expect(commandTone(entry({ kind: 'command', exitCode: 0 }))).toBe('passed');
    expect(commandTone(entry({ kind: 'command', exitCode: 0, ok: false }))).toBe('failed');
    expect(commandTone(entry({ kind: 'command', exitCode: 2 }))).toBe('failed');
    expect(commandExitLabel(entry({ kind: 'command' }))).toBe('đang chạy');
    expect(commandExitLabel(entry({ kind: 'command', exitCode: 2 }))).toBe('exit 2');
  });

  it('shows an unreadable timestamp as dashes and a readable one as HH:MM:SS', () => {
    expect(formatLogTime('not a date')).toBe('--:--:--');
    expect(formatLogTime('2026-10-02T10:00:00.000Z')).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });
});

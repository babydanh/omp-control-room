import { describe, expect, it } from 'vitest';

import type { CompanySessionLogEntry } from '../../core/src/messages.js';
import {
  activityCounts,
  buildAgentGroups,
  companySummary,
  herdrGroup,
  herdrSummary,
  latestLogLine,
  relativeTimeVi,
  sessionIdsNeedingLog,
} from '../src/company/agentSidebarView.js';
import {
  applyCompanyMessage,
  type CompanyViewState,
  emptyHerdrView,
} from '../src/company/companyState.js';
import { session, stateFrom, task } from './companyFixtures.js';

/** A fixed clock for the relative times: the view never reads the real one. */
const NOW = Date.parse('2026-05-01T10:30:00.000Z');

function logEntry(overrides: Partial<CompanySessionLogEntry> = {}): CompanySessionLogEntry {
  return {
    seq: 1,
    at: '2026-05-01T10:20:00.000Z',
    kind: 'text',
    runEpoch: 1,
    text: 'hello',
    ...overrides,
  };
}

function withLog(
  state: CompanyViewState,
  sessionId: string,
  entries: CompanySessionLogEntry[],
): CompanyViewState {
  return applyCompanyMessage(state, {
    type: 'companySessionLog',
    sessionId,
    replay: false,
    entries,
  }).state;
}

function withDelta(
  state: CompanyViewState,
  sessionId: string,
  runEpoch: number,
  text: string,
): CompanyViewState {
  return applyCompanyMessage(state, {
    type: 'companyTextDelta',
    sessionId,
    runEpoch,
    seq: 1,
    text,
  }).state;
}

function workerRow(state: CompanyViewState) {
  return buildAgentGroups(state, NOW).find((group) => group.role === 'worker')?.active[0];
}

describe('relativeTimeVi', () => {
  it('reads a moment under a minute, or one not yet past, as just now', () => {
    expect(relativeTimeVi('2026-05-01T10:29:30.000Z', NOW)).toBe('vừa xong');
    expect(relativeTimeVi('2026-05-01T10:45:00.000Z', NOW)).toBe('vừa xong');
  });

  it('counts minutes, then hours, then days', () => {
    expect(relativeTimeVi('2026-05-01T10:27:00.000Z', NOW)).toBe('3 phút trước');
    expect(relativeTimeVi('2026-05-01T05:30:00.000Z', NOW)).toBe('5 giờ trước');
    expect(relativeTimeVi('2026-04-28T10:30:00.000Z', NOW)).toBe('3 ngày trước');
  });

  it('reads a value that is not a time as no time', () => {
    expect(relativeTimeVi('not-a-time', NOW)).toBeNull();
  });
});

describe('latestLogLine', () => {
  it('picks the newest entry that has text, skipping blank ones, with its glyph and age', () => {
    const line = latestLogLine(
      [
        logEntry({ seq: 1, at: '2026-05-01T10:00:00.000Z', text: 'cũ' }),
        logEntry({ seq: 2, at: '2026-05-01T10:20:00.000Z', text: 'mới' }),
        logEntry({ seq: 3, at: '2026-05-01T10:25:00.000Z', text: '   ' }),
      ],
      NOW,
    );

    expect(line).toEqual({ glyph: '›', text: 'mới', age: '10 phút trước' });
  });

  it('shows a command as its command line, not its output', () => {
    const line = latestLogLine(
      [
        logEntry({
          kind: 'command',
          at: '2026-05-01T10:29:30.000Z',
          text: 'npm test\nPASS 12 tests',
        }),
      ],
      NOW,
    );

    expect(line).toEqual({ glyph: '$', text: 'npm test', age: 'vừa xong' });
  });

  it('draws each kind with its own glyph', () => {
    const glyphs = [
      ['tool', '◦'],
      ['question', '?'],
      ['error', '✗'],
    ] as const;
    for (const [kind, glyph] of glyphs) {
      expect(latestLogLine([logEntry({ kind })], NOW)?.glyph).toBe(glyph);
    }
  });

  it('collapses a multi-line text to one line', () => {
    expect(latestLogLine([logEntry({ text: 'một\n\n  hai' })], NOW)?.text).toBe('một hai');
  });

  it('finds no line when no entry has text', () => {
    expect(latestLogLine([logEntry({ text: '  ' })], NOW)).toBeNull();
    expect(latestLogLine([], NOW)).toBeNull();
  });
});

describe('companySummary', () => {
  it('prefers the latest log line over a live excerpt and the task', () => {
    const summary = companySummary({
      entries: [logEntry({ text: 'Đã sửa tệp' })],
      excerpt: 'đang viết',
      streaming: true,
      taskLine: 'PA-T0001 · Wire',
      now: NOW,
    });

    expect(summary?.text).toBe('Đã sửa tệp');
  });

  it('falls back to the live excerpt only while streaming', () => {
    const streaming = companySummary({
      entries: [],
      excerpt: 'đang viết',
      streaming: true,
      taskLine: 'PA-T0001 · Wire',
      now: NOW,
    });
    const idle = companySummary({
      entries: [],
      excerpt: 'đang viết',
      streaming: false,
      taskLine: 'PA-T0001 · Wire',
      now: NOW,
    });

    expect(streaming).toEqual({ glyph: '›', text: 'đang viết', age: null });
    expect(idle).toEqual({ glyph: '', text: 'PA-T0001 · Wire', age: null });
  });

  it('falls back to the task, and to nothing when there is neither log, excerpt nor task', () => {
    expect(
      companySummary({ entries: [], excerpt: '  ', streaming: true, taskLine: 'T', now: NOW }),
    ).toEqual({ glyph: '', text: 'T', age: null });
    expect(
      companySummary({ entries: [], excerpt: null, streaming: false, taskLine: null, now: NOW }),
    ).toBeNull();
  });
});

describe('company rows read the live state', () => {
  it('shows the latest log line of a session, with its age', () => {
    const worker = session({ role: 'worker', status: 'idle' });
    const state = withLog(stateFrom({ sessions: [worker] }), worker.id, [
      logEntry({ at: '2026-05-01T10:28:00.000Z', text: 'Đang đọc tệp' }),
    ]);

    expect(workerRow(state)?.summary).toEqual({
      glyph: '›',
      text: 'Đang đọc tệp',
      age: '2 phút trước',
    });
  });

  it('shows the live excerpt of a busy session in its current run', () => {
    const worker = session({ role: 'worker', status: 'busy', runEpoch: 2 });
    const state = withDelta(stateFrom({ sessions: [worker] }), worker.id, 2, 'đang viết');

    expect(workerRow(state)?.summary).toEqual({ glyph: '›', text: 'đang viết', age: null });
  });

  it('ignores an excerpt from an older run of the session', () => {
    const worker = session({ role: 'worker', status: 'busy', runEpoch: 2 });
    const state = withDelta(stateFrom({ sessions: [worker] }), worker.id, 1, 'run cũ');

    expect(workerRow(state)?.summary).toBeNull();
  });

  it('does not show an excerpt once the session is no longer working', () => {
    const worker = session({ role: 'worker', status: 'idle', runEpoch: 2 });
    const state = withDelta(stateFrom({ sessions: [worker] }), worker.id, 2, 'đã xong');

    expect(workerRow(state)?.summary).toBeNull();
  });
});

describe('herdrSummary', () => {
  it('shows the terminal title, else the working directory', () => {
    expect(herdrSummary('LEDGER: wire rail', 'C:/repo')).toEqual({
      glyph: '',
      text: 'LEDGER: wire rail',
      age: null,
    });
    expect(herdrSummary(undefined, 'C:/repo')).toEqual({ glyph: '', text: 'C:/repo', age: null });
  });

  it('drops braille spinner frames from a title and collapses the spaces they leave', () => {
    expect(herdrSummary('π ⠹ … LEDGER:   wire ⠋ rail', undefined)?.text).toBe(
      'π … LEDGER: wire rail',
    );
  });

  it('falls back to the working directory when the title is only a spinner frame', () => {
    expect(herdrSummary('⠋', 'C:/repo')?.text).toBe('C:/repo');
  });

  it('reads a blank title and a blank folder as nothing', () => {
    expect(herdrSummary(undefined, undefined)).toBeNull();
    expect(herdrSummary('  ', '')).toBeNull();
  });
});

describe('activityCounts', () => {
  it('counts the live states of companies and herdr, and leaves parked agents out', () => {
    const interrupted = task({ code: 'PA-T0001' });
    const state = stateFrom({
      tasks: [interrupted],
      sessions: [
        session({ role: 'worker', status: 'busy' }),
        session({ role: 'worker', status: 'waiting_input' }),
        session({ role: 'qa', status: 'idle' }),
        // A crash that interrupted a task counts; a leftover crash from a restart does not.
        session({ role: 'judge', status: 'crashed', activeTaskId: interrupted.id }),
        session({ role: 'judge', status: 'crashed' }),
        session({ role: 'worker', status: 'paused' }),
      ],
    });
    const herdr = herdrGroup({
      ...emptyHerdrView(),
      loaded: true,
      available: true,
      agents: [
        { paneId: 'a', kind: 'claude', status: 'working', workspaceId: 'ws' },
        { paneId: 'b', kind: 'claude', status: 'blocked', workspaceId: 'ws' },
        { paneId: 'c', kind: 'claude', status: 'done', workspaceId: 'ws' },
      ],
    });

    expect(activityCounts(buildAgentGroups(state, NOW), herdr)).toEqual({
      working: 2,
      needs: 2,
      idle: 1,
      error: 1,
    });
  });
});

describe('sessionIdsNeedingLog', () => {
  it('asks for the log of each live session that has none, and no other', () => {
    const quiet = session({ status: 'idle' });
    const logged = session({ status: 'busy' });
    const parked = session({ status: 'paused' });
    const state = withLog(stateFrom({ sessions: [quiet, logged, parked] }), logged.id, [
      logEntry(),
    ]);

    expect(sessionIdsNeedingLog(state)).toEqual([quiet.id]);
  });
});

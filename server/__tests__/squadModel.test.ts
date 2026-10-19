import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  appendEvent,
  buildLeaderPrompt,
  emptySquadFile,
  parseLeaderReply,
  parseSquadFile,
  parseSquadRows,
  SQUAD_HISTORY_MAX,
  SQUAD_MAX_ROWS,
  squadEvent,
  type SquadMember,
  squadProgress,
  type StoredSquadRun,
  toWireRun,
} from '../src/company/squad/squadModel.js';

const AT = '2026-05-01T08:00:00.000Z';

const HERDR_MEMBER: SquadMember = {
  ref: 'herdr:wA:p1',
  kind: 'herdr',
  assignee: { kind: 'herdr', paneId: 'wA:p1' },
  label: 'Pane 1',
  status: 'idle',
  role: '',
  queued: 0,
};
const SESSION_MEMBER: SquadMember = {
  ref: 'session:s1',
  kind: 'session',
  assignee: { kind: 'session', sessionId: 's1' },
  label: 'Session 1',
  status: 'idle',
  role: 'Dev',
  queued: 1,
};
const MEMBERS: SquadMember[] = [HERDR_MEMBER, SESSION_MEMBER];

function reply(value: unknown): string {
  return JSON.stringify(value);
}

function storedRun(overrides: Partial<StoredSquadRun> = {}): StoredSquadRun {
  return {
    id: randomUUID(),
    request: 'Làm trang đăng nhập',
    status: 'planning',
    turns: 0,
    proposals: [],
    pendingReviews: [],
    history: [],
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  };
}

describe('parseLeaderReply', () => {
  it('accepts a proposal to herdr and a new session, trimming text and keeping reasons', () => {
    const checked = parseLeaderReply(
      reply({
        assignments: [
          {
            assignee: 'herdr:wA:p1',
            text: '  Viết form đăng nhập  ',
            reason: 'Pane này đang rảnh',
          },
          { assignee: 'new-session', text: 'Viết test cho form' },
        ],
        note: 'Chia hai việc.',
        done: false,
      }),
      MEMBERS,
    );
    expect(checked).toEqual({
      ok: true,
      value: {
        assignments: [
          {
            assignee: { kind: 'herdr', paneId: 'wA:p1' },
            text: 'Viết form đăng nhập',
            reason: 'Pane này đang rảnh',
          },
          { assignee: { kind: 'new-session' }, text: 'Viết test cho form' },
        ],
        note: 'Chia hai việc.',
        done: false,
      },
    });
  });

  it('accepts one reply wrapped in a code fence', () => {
    const body = reply({
      assignments: [{ assignee: 'session:s1', text: 'Làm' }],
      note: '',
      done: false,
    });
    const checked = parseLeaderReply('```json\n' + body + '\n```', MEMBERS);
    expect(checked.ok).toBe(true);
  });

  it('accepts a finished request with no assignments', () => {
    const checked = parseLeaderReply(
      reply({ assignments: [], note: 'Xong.', done: true }),
      MEMBERS,
    );
    expect(checked).toEqual({ ok: true, value: { assignments: [], note: 'Xong.', done: true } });
  });

  it('refuses text that is not JSON', () => {
    const checked = parseLeaderReply('Tôi nghĩ nên làm vậy', MEMBERS);
    expect(checked).toMatchObject({ ok: false });
    if (!checked.ok) expect(checked.message).toContain('JSON');
  });

  it('refuses unknown keys at the top level and inside an assignment', () => {
    const top = parseLeaderReply(
      reply({ assignments: [], note: '', done: true, extra: 1 }),
      MEMBERS,
    );
    expect(top.ok).toBe(false);
    const inner = parseLeaderReply(
      reply({
        assignments: [{ assignee: 'session:s1', text: 'x', priority: 1 }],
        note: '',
        done: false,
      }),
      MEMBERS,
    );
    expect(inner.ok).toBe(false);
  });

  it('refuses an assignee that is not a listed member', () => {
    const checked = parseLeaderReply(
      reply({ assignments: [{ assignee: 'herdr:wZ:p9', text: 'Làm' }], note: '', done: false }),
      MEMBERS,
    );
    expect(checked.ok).toBe(false);
    if (!checked.ok) expect(checked.message).toContain('không có trong danh sách');
  });

  it('refuses more rows than the limit', () => {
    const assignments = Array.from({ length: SQUAD_MAX_ROWS + 1 }, (_, index) => ({
      assignee: 'session:s1',
      text: `Việc ${index + 1}`,
    }));
    const checked = parseLeaderReply(reply({ assignments, note: '', done: false }), MEMBERS);
    expect(checked.ok).toBe(false);
    if (!checked.ok) expect(checked.message).toContain(`tối đa ${SQUAD_MAX_ROWS}`);
  });

  it('refuses empty text', () => {
    const checked = parseLeaderReply(
      reply({ assignments: [{ assignee: 'session:s1', text: '   ' }], note: '', done: false }),
      MEMBERS,
    );
    expect(checked.ok).toBe(false);
  });

  it('refuses a finished reply that still assigns, and an unfinished one that assigns nothing', () => {
    const both = parseLeaderReply(
      reply({ assignments: [{ assignee: 'session:s1', text: 'Làm' }], note: '', done: true }),
      MEMBERS,
    );
    expect(both.ok).toBe(false);
    const neither = parseLeaderReply(reply({ assignments: [], note: '', done: false }), MEMBERS);
    expect(neither.ok).toBe(false);
  });

  it('refuses a reply missing its done flag', () => {
    const checked = parseLeaderReply(reply({ assignments: [], note: '' }), MEMBERS);
    expect(checked.ok).toBe(false);
  });
});

describe('parseSquadRows', () => {
  it('returns trimmed drafts for valid rows', () => {
    const checked = parseSquadRows([
      { text: '  Việc một ', assignee: { kind: 'herdr', paneId: 'wA:p1' } },
      { text: 'Việc hai', assignee: { kind: 'new-session' } },
    ]);
    expect(checked).toEqual({
      ok: true,
      value: [
        { text: 'Việc một', assignee: { kind: 'herdr', paneId: 'wA:p1' } },
        { text: 'Việc hai', assignee: { kind: 'new-session' } },
      ],
    });
  });

  it('refuses an empty list, a list over the limit, a bad assignee, and empty text', () => {
    expect(parseSquadRows([]).ok).toBe(false);
    const tooMany = Array.from({ length: SQUAD_MAX_ROWS + 1 }, () => ({
      text: 'x',
      assignee: { kind: 'new-session' },
    }));
    expect(parseSquadRows(tooMany).ok).toBe(false);
    expect(parseSquadRows([{ text: 'x', assignee: { kind: 'herdr' } }]).ok).toBe(false);
    expect(parseSquadRows([{ text: ' ', assignee: { kind: 'new-session' } }]).ok).toBe(false);
  });
});

describe('parseSquadFile', () => {
  it('reads a missing file as empty and not corrupt', () => {
    expect(parseSquadFile(null)).toEqual({ file: emptySquadFile(), dropped: 0, corrupt: false });
  });

  it('marks a value that is not a squad file as corrupt', () => {
    expect(parseSquadFile({ version: 2, revision: 1, runs: [] }).corrupt).toBe(true);
  });

  it('keeps valid runs and counts the dropped ones', () => {
    const valid = storedRun();
    const parsed = parseSquadFile({ version: 1, revision: 4, runs: [valid, { id: 'not-a-uuid' }] });
    expect(parsed.corrupt).toBe(false);
    expect(parsed.dropped).toBe(1);
    expect(parsed.file.revision).toBe(4);
    expect(parsed.file.runs.map((run) => run.id)).toEqual([valid.id]);
  });
});

describe('squadProgress', () => {
  it('counts only items of approved proposals, and how many are done', () => {
    const approved = {
      id: randomUUID(),
      turn: 1,
      note: '',
      rows: [],
      status: 'approved' as const,
      createdAt: AT,
    };
    const pending = {
      id: randomUUID(),
      turn: 2,
      note: '',
      rows: [],
      status: 'pending' as const,
      createdAt: AT,
    };
    const run = storedRun({ proposals: [approved, pending] });
    const progress = squadProgress(run, [
      { squadRunId: approved.id, status: 'done' },
      { squadRunId: approved.id, status: 'queued' },
      { squadRunId: pending.id, status: 'done' },
      { status: 'done' },
    ]);
    expect(progress).toEqual({ done: 1, total: 2 });
  });
});

describe('buildLeaderPrompt', () => {
  it('states the request, lists the team with ids, and asks for the reply shape', () => {
    const prompt = buildLeaderPrompt({
      folderName: 'app',
      request: 'Làm trang đăng nhập',
      members: MEMBERS,
      items: [],
      reviews: [],
      history: [],
      turn: 2,
    });
    expect(prompt).toContain('Làm trang đăng nhập');
    expect(prompt).toContain('- herdr:wA:p1');
    expect(prompt).toContain('- session:s1');
    expect(prompt).toContain('new-session');
    expect(prompt).toContain('"assignments"');
    expect(prompt).toContain('This is turn 2 of 10.');
  });
});

describe('appendEvent and toWireRun', () => {
  it('keeps only the newest events', () => {
    const run = storedRun();
    for (let index = 0; index < SQUAD_HISTORY_MAX + 5; index += 1) {
      appendEvent(run, squadEvent(AT, 'turn', `lượt ${index}`));
    }
    expect(run.history).toHaveLength(SQUAD_HISTORY_MAX);
    expect(run.history[0]?.message).toBe('lượt 5');
  });

  it('shows the newest proposal and the progress on the wire', () => {
    const older = {
      id: randomUUID(),
      turn: 1,
      note: 'cũ',
      rows: [],
      status: 'approved' as const,
      createdAt: AT,
    };
    const newer = {
      id: randomUUID(),
      turn: 2,
      note: 'mới',
      rows: [],
      status: 'pending' as const,
      createdAt: AT,
    };
    const wire = toWireRun(storedRun({ status: 'proposed', proposals: [older, newer] }), {
      done: 0,
      total: 0,
    });
    expect(wire.proposal?.id).toBe(newer.id);
    expect(wire.maxTurns).toBe(10);
    expect(wire.progress).toEqual({ done: 0, total: 0 });
  });
});

import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  WORK_ITEM_ACCEPTANCE_MAX_CHARS,
  WORK_ITEM_DEPENDS_MAX,
  WORK_ITEM_PRIORITY_DEFAULT,
} from '../../core/src/workItemGraph.js';
import {
  appendEvent,
  buildLeaderPrompt,
  emptySquadFile,
  type LeaderAssignment,
  type LeaderItemView,
  parseLeaderReply,
  parseSquadFile,
  parseSquadRows,
  requestFromItem,
  rowsOf,
  SQUAD_CONTEXT_RESULT_MAX_CHARS,
  SQUAD_HISTORY_MAX,
  SQUAD_MAX_ROWS,
  squadEvent,
  type SquadMember,
  squadProgress,
  type StoredSquadRun,
  toWireRun,
} from '../src/company/squad/squadModel.js';

const AT = '2026-05-01T08:00:00.000Z';
const ITEM_ID = '3f2b8c1e-1d4a-4b7e-9a0f-2c5d6e7f8a9b';

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

/** No open work items: the leader may not wait for any `#n`. */
const NO_OPEN: ReadonlySet<number> = new Set<number>();
/** Work item #1 is open. */
const OPEN_ONE: ReadonlySet<number> = new Set([1]);
/** The board's view of open items with no item open. */
const NO_OPEN_ITEM = (): undefined => undefined;
/** The board's view of open items where only #3 is open, with id {@link ITEM_ID}. */
const ONE_OPEN_ITEM = (sequence: number): string | undefined =>
  sequence === 3 ? ITEM_ID : undefined;

function reply(value: unknown): string {
  return JSON.stringify(value);
}

function parseReply(value: unknown, open: ReadonlySet<number> = NO_OPEN) {
  return parseLeaderReply(reply(value), MEMBERS, open);
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
    const checked = parseReply({
      assignments: [
        { assignee: 'herdr:wA:p1', text: '  Viết form đăng nhập  ', reason: 'Pane này đang rảnh' },
        { assignee: 'new-session', text: 'Viết test cho form' },
      ],
      note: 'Chia hai việc.',
      done: false,
    });
    expect(checked).toEqual({
      ok: true,
      value: {
        assignments: [
          {
            assignee: { kind: 'herdr', paneId: 'wA:p1' },
            text: 'Viết form đăng nhập',
            reason: 'Pane này đang rảnh',
            priority: WORK_ITEM_PRIORITY_DEFAULT,
            dependsOn: [],
          },
          {
            assignee: { kind: 'new-session' },
            text: 'Viết test cho form',
            priority: WORK_ITEM_PRIORITY_DEFAULT,
            dependsOn: [],
          },
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
    const checked = parseLeaderReply('```json\n' + body + '\n```', MEMBERS, NO_OPEN);
    expect(checked.ok).toBe(true);
  });

  it('accepts a finished request with no assignments', () => {
    const checked = parseReply({ assignments: [], note: 'Xong.', done: true });
    expect(checked).toEqual({ ok: true, value: { assignments: [], note: 'Xong.', done: true } });
  });

  it('refuses text that is not JSON', () => {
    const checked = parseLeaderReply('Tôi nghĩ nên làm vậy', MEMBERS, NO_OPEN);
    expect(checked).toMatchObject({ ok: false });
    if (!checked.ok) expect(checked.message).toContain('JSON');
  });

  it('refuses unknown keys at the top level and inside an assignment', () => {
    const top = parseReply({ assignments: [], note: '', done: true, extra: 1 });
    expect(top.ok).toBe(false);
    const inner = parseReply({
      assignments: [{ assignee: 'session:s1', text: 'x', owner: 'me' }],
      note: '',
      done: false,
    });
    expect(inner.ok).toBe(false);
  });

  it('refuses an assignee that is not a listed member', () => {
    const checked = parseReply({
      assignments: [{ assignee: 'herdr:wZ:p9', text: 'Làm' }],
      note: '',
      done: false,
    });
    expect(checked.ok).toBe(false);
    if (!checked.ok) expect(checked.message).toContain('không có trong danh sách');
  });

  it('refuses more rows than the limit', () => {
    const assignments = Array.from({ length: SQUAD_MAX_ROWS + 1 }, (_, index) => ({
      assignee: 'session:s1',
      text: `Việc ${index + 1}`,
    }));
    const checked = parseReply({ assignments, note: '', done: false });
    expect(checked.ok).toBe(false);
    if (!checked.ok) expect(checked.message).toContain(`tối đa ${SQUAD_MAX_ROWS}`);
  });

  it('refuses empty text', () => {
    const checked = parseReply({
      assignments: [{ assignee: 'session:s1', text: '   ' }],
      note: '',
      done: false,
    });
    expect(checked.ok).toBe(false);
  });

  it('refuses a finished reply that still assigns, and an unfinished one that assigns nothing', () => {
    const both = parseReply({
      assignments: [{ assignee: 'session:s1', text: 'Làm' }],
      note: '',
      done: true,
    });
    expect(both.ok).toBe(false);
    const neither = parseReply({ assignments: [], note: '', done: false });
    expect(neither.ok).toBe(false);
  });

  it('refuses a reply missing its done flag', () => {
    const checked = parseReply({ assignments: [], note: '' });
    expect(checked.ok).toBe(false);
  });

  it('keeps priority, done-when text, and waits for a row and an open item', () => {
    const checked = parseReply(
      {
        assignments: [
          { assignee: 'herdr:wA:p1', text: 'Làm A', priority: 0, acceptance: '  Có test  ' },
          { assignee: 'session:s1', text: 'Làm B', dependsOn: [0, '#1'] },
        ],
        note: '',
        done: false,
      },
      OPEN_ONE,
    );
    expect(checked).toEqual({
      ok: true,
      value: {
        assignments: [
          {
            assignee: { kind: 'herdr', paneId: 'wA:p1' },
            text: 'Làm A',
            priority: 0,
            acceptance: 'Có test',
            dependsOn: [],
          },
          {
            assignee: { kind: 'session', sessionId: 's1' },
            text: 'Làm B',
            priority: WORK_ITEM_PRIORITY_DEFAULT,
            dependsOn: [
              { kind: 'row', row: 0 },
              { kind: 'item', sequence: 1 },
            ],
          },
        ],
        note: '',
        done: false,
      },
    });
  });

  it('refuses a priority that is not a whole number from 0 to 3', () => {
    for (const priority of [4, -1, 1.5, '1', null]) {
      const checked = parseReply({
        assignments: [{ assignee: 'session:s1', text: 'Làm', priority }],
        note: '',
        done: false,
      });
      expect(checked.ok, String(priority)).toBe(false);
      if (!checked.ok) expect(checked.message).toContain('độ ưu tiên');
    }
  });

  it('accepts a done-when text up to the limit, drops a blank one, and refuses one past it', () => {
    const atLimit = 'x'.repeat(WORK_ITEM_ACCEPTANCE_MAX_CHARS);
    const accepted = parseReply({
      assignments: [{ assignee: 'session:s1', text: 'Làm', acceptance: atLimit }],
      note: '',
      done: false,
    });
    expect(accepted).toMatchObject({
      ok: true,
      value: { assignments: [{ acceptance: atLimit }] },
    });

    const blank = parseReply({
      assignments: [{ assignee: 'session:s1', text: 'Làm', acceptance: '   ' }],
      note: '',
      done: false,
    });
    expect(blank.ok).toBe(true);
    if (blank.ok) expect(blank.value.assignments[0]).not.toHaveProperty('acceptance');

    const refused = parseReply({
      assignments: [{ assignee: 'session:s1', text: 'Làm', acceptance: `${atLimit}x` }],
      note: '',
      done: false,
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.message).toContain(`${WORK_ITEM_ACCEPTANCE_MAX_CHARS} ký tự`);
  });

  it('refuses a wait that points outside the reply or at an item that is not open', () => {
    const cases: { dependsOn: unknown; open: ReadonlySet<number>; reason: string }[] = [
      { dependsOn: [1], open: NO_OPEN, reason: 'chỉ có 1 việc' },
      { dependsOn: [-1], open: NO_OPEN, reason: 'chỉ có 1 việc' },
      { dependsOn: [0], open: NO_OPEN, reason: 'chính nó' },
      { dependsOn: ['#1'], open: NO_OPEN, reason: '"#1"' },
      { dependsOn: ['#2'], open: OPEN_ONE, reason: '"#2"' },
      { dependsOn: ['#1', '#1'], open: OPEN_ONE, reason: 'hai lần' },
      { dependsOn: ['#0'], open: OPEN_ONE, reason: 'không hợp lệ' },
      { dependsOn: ['1'], open: OPEN_ONE, reason: 'không hợp lệ' },
      { dependsOn: [0.5], open: OPEN_ONE, reason: 'không hợp lệ' },
      { dependsOn: [null], open: OPEN_ONE, reason: 'không hợp lệ' },
      { dependsOn: 'x', open: OPEN_ONE, reason: 'không phải danh sách' },
    ];
    for (const { dependsOn, open, reason } of cases) {
      const checked = parseReply(
        {
          assignments: [{ assignee: 'session:s1', text: 'Làm', dependsOn }],
          note: '',
          done: false,
        },
        open,
      );
      expect(checked.ok, JSON.stringify(dependsOn)).toBe(false);
      if (!checked.ok) expect(checked.message).toContain(reason);
    }
  });

  it('caps the waits of one row at the limit', () => {
    const sequences = Array.from({ length: WORK_ITEM_DEPENDS_MAX + 1 }, (_, index) => index + 1);
    const open = new Set(sequences);
    const waits = sequences.map((sequence) => `#${sequence}`);
    const atLimit = parseReply(
      {
        assignments: [
          { assignee: 'session:s1', text: 'Làm', dependsOn: waits.slice(0, WORK_ITEM_DEPENDS_MAX) },
        ],
        note: '',
        done: false,
      },
      open,
    );
    expect(atLimit.ok).toBe(true);
    const overLimit = parseReply(
      {
        assignments: [{ assignee: 'session:s1', text: 'Làm', dependsOn: waits }],
        note: '',
        done: false,
      },
      open,
    );
    expect(overLimit.ok).toBe(false);
    if (!overLimit.ok) expect(overLimit.message).toContain(`tối đa ${WORK_ITEM_DEPENDS_MAX}`);
  });

  it('refuses rows that wait for each other in a loop', () => {
    const checked = parseReply({
      assignments: [
        { assignee: 'session:s1', text: 'A', dependsOn: [1] },
        { assignee: 'herdr:wA:p1', text: 'B', dependsOn: [0] },
      ],
      note: '',
      done: false,
    });
    expect(checked.ok).toBe(false);
    if (!checked.ok) expect(checked.message).toContain('vòng lặp');
  });
});

describe('parseSquadRows', () => {
  it('returns trimmed drafts and the rows the proposal keeps for valid rows', () => {
    const checked = parseSquadRows(
      [
        { text: '  Việc một ', assignee: { kind: 'herdr', paneId: 'wA:p1' } },
        { text: 'Việc hai', assignee: { kind: 'new-session' } },
      ],
      NO_OPEN_ITEM,
    );
    expect(checked).toEqual({
      ok: true,
      value: {
        drafts: [
          {
            text: 'Việc một',
            assignee: { kind: 'herdr', paneId: 'wA:p1' },
            priority: WORK_ITEM_PRIORITY_DEFAULT,
            dependsOn: [],
            dependsOnDrafts: [],
          },
          {
            text: 'Việc hai',
            assignee: { kind: 'new-session' },
            priority: WORK_ITEM_PRIORITY_DEFAULT,
            dependsOn: [],
            dependsOnDrafts: [],
          },
        ],
        rows: [
          {
            text: 'Việc một',
            assignee: { kind: 'herdr', paneId: 'wA:p1' },
            priority: WORK_ITEM_PRIORITY_DEFAULT,
            dependsOn: [],
          },
          {
            text: 'Việc hai',
            assignee: { kind: 'new-session' },
            priority: WORK_ITEM_PRIORITY_DEFAULT,
            dependsOn: [],
          },
        ],
      },
    });
  });

  it('maps a wait on a row to draft indexes, and a wait on an open item to its id', () => {
    const checked = parseSquadRows(
      [
        {
          text: 'Việc một',
          assignee: { kind: 'new-session' },
          priority: 0,
          acceptance: 'Test pass',
        },
        {
          text: 'Việc hai',
          assignee: { kind: 'new-session' },
          dependsOn: [
            { kind: 'row', row: 0 },
            { kind: 'item', sequence: 3 },
          ],
        },
      ],
      ONE_OPEN_ITEM,
    );
    expect(checked).toEqual({
      ok: true,
      value: {
        drafts: [
          {
            text: 'Việc một',
            assignee: { kind: 'new-session' },
            priority: 0,
            acceptance: 'Test pass',
            dependsOn: [],
            dependsOnDrafts: [],
          },
          {
            text: 'Việc hai',
            assignee: { kind: 'new-session' },
            priority: WORK_ITEM_PRIORITY_DEFAULT,
            dependsOn: [ITEM_ID],
            dependsOnDrafts: [0],
          },
        ],
        rows: [
          {
            text: 'Việc một',
            assignee: { kind: 'new-session' },
            priority: 0,
            acceptance: 'Test pass',
            dependsOn: [],
          },
          {
            text: 'Việc hai',
            assignee: { kind: 'new-session' },
            priority: WORK_ITEM_PRIORITY_DEFAULT,
            dependsOn: [
              { kind: 'row', row: 0 },
              { kind: 'item', sequence: 3 },
            ],
          },
        ],
      },
    });
  });

  it('refuses an empty list, a list over the limit, a bad assignee, and empty text', () => {
    expect(parseSquadRows([], NO_OPEN_ITEM).ok).toBe(false);
    const tooMany = Array.from({ length: SQUAD_MAX_ROWS + 1 }, () => ({
      text: 'x',
      assignee: { kind: 'new-session' },
    }));
    expect(parseSquadRows(tooMany, NO_OPEN_ITEM).ok).toBe(false);
    expect(parseSquadRows([{ text: 'x', assignee: { kind: 'herdr' } }], NO_OPEN_ITEM).ok).toBe(
      false,
    );
    expect(
      parseSquadRows([{ text: ' ', assignee: { kind: 'new-session' } }], NO_OPEN_ITEM).ok,
    ).toBe(false);
  });

  it('refuses a bad priority, an over-long done-when text, and a malformed wait', () => {
    const badPriority = parseSquadRows(
      [{ text: 'a', assignee: { kind: 'new-session' }, priority: 7 }],
      NO_OPEN_ITEM,
    );
    expect(badPriority.ok).toBe(false);
    if (!badPriority.ok) expect(badPriority.message).toContain('độ ưu tiên');

    const longAcceptance = parseSquadRows(
      [
        {
          text: 'a',
          assignee: { kind: 'new-session' },
          acceptance: 'x'.repeat(WORK_ITEM_ACCEPTANCE_MAX_CHARS + 1),
        },
      ],
      NO_OPEN_ITEM,
    );
    expect(longAcceptance.ok).toBe(false);
    if (!longAcceptance.ok) expect(longAcceptance.message).toContain('tiêu chí xong');

    const mixed = parseSquadRows(
      [
        {
          text: 'a',
          assignee: { kind: 'new-session' },
          dependsOn: [{ kind: 'row', row: 0, sequence: 1 }],
        },
      ],
      NO_OPEN_ITEM,
    );
    expect(mixed.ok).toBe(false);
    if (!mixed.ok) expect(mixed.message).toContain('không hợp lệ');
  });

  it('refuses a wait on an item that is not open, on itself, on a loop, and a repeated wait', () => {
    const unknownItem = parseSquadRows(
      [
        {
          text: 'a',
          assignee: { kind: 'new-session' },
          dependsOn: [{ kind: 'item', sequence: 9 }],
        },
      ],
      ONE_OPEN_ITEM,
    );
    expect(unknownItem.ok).toBe(false);
    if (!unknownItem.ok) expect(unknownItem.message).toContain('#9');

    const self = parseSquadRows(
      [{ text: 'a', assignee: { kind: 'new-session' }, dependsOn: [{ kind: 'row', row: 0 }] }],
      NO_OPEN_ITEM,
    );
    expect(self.ok).toBe(false);
    if (!self.ok) expect(self.message).toContain('chính nó');

    const loop = parseSquadRows(
      [
        { text: 'a', assignee: { kind: 'new-session' }, dependsOn: [{ kind: 'row', row: 1 }] },
        { text: 'b', assignee: { kind: 'new-session' }, dependsOn: [{ kind: 'row', row: 0 }] },
      ],
      NO_OPEN_ITEM,
    );
    expect(loop.ok).toBe(false);
    if (!loop.ok) expect(loop.message).toContain('vòng lặp');

    const repeated = parseSquadRows(
      [
        {
          text: 'a',
          assignee: { kind: 'new-session' },
          dependsOn: [
            { kind: 'item', sequence: 3 },
            { kind: 'item', sequence: 3 },
          ],
        },
      ],
      ONE_OPEN_ITEM,
    );
    expect(repeated.ok).toBe(false);
    if (!repeated.ok) expect(repeated.message).toContain('hai lần');
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

  it('reads rows saved before priority and waits existed as priority 2 with no waits', () => {
    const parsed = parseSquadFile({
      version: 1,
      revision: 1,
      runs: [
        {
          id: randomUUID(),
          request: 'Làm',
          status: 'proposed',
          turns: 1,
          proposals: [
            {
              id: randomUUID(),
              turn: 1,
              note: '',
              status: 'pending',
              createdAt: AT,
              rows: [{ text: 'Việc', assignee: { kind: 'new-session' } }],
            },
          ],
          pendingReviews: [],
          history: [],
          createdAt: AT,
          updatedAt: AT,
        },
      ],
    });
    expect(parsed.dropped).toBe(0);
    expect(parsed.file.runs[0]?.proposals[0]?.rows).toEqual([
      {
        text: 'Việc',
        assignee: { kind: 'new-session' },
        priority: WORK_ITEM_PRIORITY_DEFAULT,
        dependsOn: [],
      },
    ]);
  });

  it('keeps the done-when text of a saved review', () => {
    const itemId = randomUUID();
    const run = storedRun({
      pendingReviews: [{ itemId, at: AT, text: 'Form', result: 'Đã viết', acceptance: 'Có test' }],
    });
    const parsed = parseSquadFile({ version: 1, revision: 1, runs: [run] });
    expect(parsed.file.runs[0]?.pendingReviews).toEqual([
      { itemId, at: AT, text: 'Form', result: 'Đã viết', acceptance: 'Có test' },
    ]);
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
    expect(prompt).toContain('"priority"');
    expect(prompt).toContain('"dependsOn"');
    expect(prompt).toContain('This is turn 2 of 10.');
  });

  it('shows each item with its number, priority, done-when text, waits, and result', () => {
    const items: LeaderItemView[] = [
      {
        sequence: 1,
        text: 'Việc cũ',
        status: 'done',
        assignee: 'session:s1',
        priority: WORK_ITEM_PRIORITY_DEFAULT,
        dependsOn: [],
        result: 'Form đã xong',
      },
      {
        sequence: 2,
        text: 'Việc mới',
        status: 'queued',
        assignee: 'herdr:wA:p1',
        priority: 0,
        acceptance: 'Có test',
        dependsOn: [1],
      },
    ];
    const prompt = buildLeaderPrompt({
      folderName: 'app',
      request: 'Làm',
      members: MEMBERS,
      items,
      reviews: [],
      history: [],
      turn: 1,
    });
    expect(prompt).toContain('- #1 [done] Việc cũ · assigned to session:s1');
    expect(prompt).toContain('- #2 [queued] Việc mới · assigned to herdr:wA:p1');
    expect(prompt).toContain('  priority P0');
    expect(prompt).toContain('  done when: Có test');
    expect(prompt).toContain('  waits for: #1');
    expect(prompt).toContain('  result: Form đã xong');
  });

  it('shows the done-when text of a finished item waiting for review', () => {
    const prompt = buildLeaderPrompt({
      folderName: 'app',
      request: 'Làm',
      members: MEMBERS,
      items: [],
      reviews: [
        {
          itemId: randomUUID(),
          at: AT,
          text: 'Form đăng nhập',
          result: 'Đã viết',
          acceptance: 'Có test form',
        },
      ],
      history: [],
      turn: 1,
    });
    expect(prompt).toContain('- Form đăng nhập');
    expect(prompt).toContain('  done when: Có test form');
    expect(prompt).toContain('  result: Đã viết');
  });
});

describe('requestFromItem', () => {
  it('joins the item text, its done-when line, and its result', () => {
    expect(
      requestFromItem({ text: '  Viết form  ', acceptance: ' Có test ', result: 'Đã viết' }),
    ).toBe('Viết form\n\nXong khi: Có test\n\nKết quả:\nĐã viết');
  });

  it('leaves out blank parts', () => {
    expect(requestFromItem({ text: 'Viết form', acceptance: '  ', result: '' })).toBe('Viết form');
  });

  it('clips a long result to the leader result limit', () => {
    const prefix = 'Việc\n\nKết quả:\n';
    const text = requestFromItem({
      text: 'Việc',
      result: 'x'.repeat(SQUAD_CONTEXT_RESULT_MAX_CHARS + 50),
    });
    expect(text.startsWith(prefix)).toBe(true);
    expect(text.length).toBeLessThanOrEqual(prefix.length + SQUAD_CONTEXT_RESULT_MAX_CHARS);
  });
});

describe('rowsOf', () => {
  it('keeps priority, done-when text, and waits on the proposal row', () => {
    const assignments: LeaderAssignment[] = [
      {
        assignee: { kind: 'new-session' },
        text: 'Việc',
        priority: 1,
        acceptance: 'Xong',
        dependsOn: [
          { kind: 'row', row: 1 },
          { kind: 'item', sequence: 2 },
        ],
      },
    ];
    expect(rowsOf(assignments)).toEqual([
      {
        text: 'Việc',
        assignee: { kind: 'new-session' },
        priority: 1,
        acceptance: 'Xong',
        dependsOn: [
          { kind: 'row', row: 1 },
          { kind: 'item', sequence: 2 },
        ],
      },
    ]);
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

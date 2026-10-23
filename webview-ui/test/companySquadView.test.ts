import { describe, expect, it } from 'vitest';

import type {
  CompanySquadMessage,
  SquadProposal,
  SquadRun,
  SquadRunStatus,
  WorkItem,
  WorkItemAssignee,
} from '../../core/src/messages.js';
import { WORK_ITEM_DEPENDS_MAX } from '../../core/src/workItemGraph.js';
import type { AssigneeOption } from '../src/company/assigneeOptions.js';
import {
  isCompanyServerMessage,
  squadApprove,
  squadRequest,
  squadRetry,
} from '../src/company/companyMessages.js';
import { applyCompanyMessage } from '../src/company/companyState.js';
import type { CompanyLaneId } from '../src/company/constants.js';
import {
  blankDraftRow,
  canStartSquad,
  epicChildren,
  findSquadRun,
  openSequencesOf,
  progressLabel,
  proposalRowDepsOptions,
  removeDraftRow,
  rowsFromProposal,
  SQUAD_MAX_ROWS,
  type SquadDraftRow,
  squadEventLabel,
  squadLaneFor,
  squadProgressView,
  squadRunActions,
  squadRunKey,
  squadStatusLabel,
  toggleRowDependency,
  validateRows,
  visibleSquadRuns,
  waitItemLabel,
} from '../src/company/squadView.js';
import { stateFrom } from './companyFixtures.js';

const WORKSPACE = '/work/alpha';
const SESSION: WorkItemAssignee = { kind: 'session', sessionId: 's-1' };
const AT = '2026-01-01T00:00:00.000Z';

function run(overrides: Partial<SquadRun> = {}): SquadRun {
  return {
    id: 'run-1',
    request: 'Làm trang đăng nhập',
    status: 'planning',
    turns: 1,
    maxTurns: 3,
    progress: { done: 0, total: 0 },
    history: [],
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  };
}

function proposal(overrides: Partial<SquadProposal> = {}): SquadProposal {
  return {
    id: 'prop-1',
    turn: 1,
    note: 'Chia việc',
    rows: [
      { text: 'Dựng form', assignee: SESSION, priority: 2, dependsOn: [] },
      { text: 'Viết API', assignee: SESSION, priority: 2, dependsOn: [] },
    ],
    status: 'pending',
    warnings: [],
    createdAt: AT,
    ...overrides,
  };
}

function draft(text: string, assignee: WorkItemAssignee | null = SESSION): SquadDraftRow {
  return {
    key: `key-${text}`,
    text,
    repo: null,
    role: null,
    agent: '',
    areas: '',
    assignee,
    priority: 2,
    acceptance: '',
    dependsOn: [],
  };
}

function workItem(overrides: Partial<WorkItem> & Pick<WorkItem, 'id' | 'sequence'>): WorkItem {
  return {
    text: `Việc ${overrides.sequence}`,
    assignee: SESSION,
    status: 'queued',
    priority: 2,
    dependsOn: [],
    createdAt: AT,
    updatedAt: AT,
    history: [],
    ...overrides,
  };
}

function squadMessage(revision: number, runs: SquadRun[]): CompanySquadMessage {
  return { type: 'companySquad', workspacePath: WORKSPACE, revision, runs };
}

const SESSION_OPTION: AssigneeOption = {
  key: 'session:s-1',
  assignee: SESSION,
  label: 'Phiên 1',
  group: 'session',
};
const NEW_OPTION: AssigneeOption = {
  key: 'new-session',
  assignee: { kind: 'new-session' },
  label: 'Phiên omp mới',
  group: 'new',
};

describe('squad lanes', () => {
  it.each<[SquadRunStatus, CompanyLaneId | null]>([
    ['planning', 'planned'],
    ['proposed', 'planned'],
    ['failed', 'planned'],
    ['working', 'running'],
    ['done', 'done'],
    ['stopped', 'done'],
    ['dismissed', null],
  ])('shows a %s run in the %s lane', (status, lane) => {
    expect(squadLaneFor(run({ status }))).toBe(lane);
  });
  it('hides a working compact run behind its children and files its result under Xong', () => {
    expect(squadLaneFor(run({ compact: true, status: 'planning' }))).toBe('planned');
    expect(squadLaneFor(run({ compact: true, status: 'working' }))).toBeNull();
    expect(squadLaneFor(run({ compact: true, status: 'done' }))).toBe('done');
    expect(squadLaneFor(run({ compact: true, status: 'failed' }))).toBe('failed');
    expect(squadLaneFor(run({ compact: true, status: 'stopped' }))).toBe('done');
    expect(squadLaneFor(run({ status: 'done' }))).toBe('done');
    expect(squadLaneFor(run({ status: 'failed' }))).toBe('planned');
  });
});

describe('squad run actions', () => {
  it.each<SquadRunStatus>(['planning', 'proposed', 'working'])(
    'offers cancellation for an unfinished %s run',
    (status) => expect(squadRunActions(status)).toEqual({ cancel: true, remove: false }),
  );

  it.each<SquadRunStatus>(['done', 'dismissed', 'stopped', 'failed'])(
    'offers removal for a finished %s run',
    (status) => expect(squadRunActions(status)).toEqual({ cancel: false, remove: true }),
  );
});

describe('squad labels', () => {
  it('names a run status and a history event in words', () => {
    expect(squadStatusLabel('proposed')).toBe('Chờ duyệt');
    expect(squadEventLabel('approved')).toBe('Đã duyệt');
  });

  it('shows progress only once the run has a task count', () => {
    expect(progressLabel({ done: 2, total: 5 })).toBe('Đội: 2/5 xong');
    expect(progressLabel({ done: 0, total: 0 })).toBeNull();
  });
});

describe('proposal rows', () => {
  it('keeps each proposed row under a key of its own, so edits keep focus', () => {
    expect(rowsFromProposal(proposal())).toEqual([
      {
        key: 'prop-1:0',
        text: 'Dựng form',
        repo: null,
        role: null,
        agent: '',
        areas: '',
        assignee: SESSION,
        priority: 2,
        acceptance: '',
        dependsOn: [],
      },
      {
        key: 'prop-1:1',
        text: 'Viết API',
        repo: null,
        role: null,
        agent: '',
        areas: '',
        assignee: SESSION,
        priority: 2,
        acceptance: '',
        dependsOn: [],
      },
    ]);
  });
  it('groups compact run child items by every proposal id', () => {
    expect(
      epicChildren(
        { id: 'run-1', proposalIds: ['prop-old', 'prop-new'] },
        [
          workItem({ id: 'old', sequence: 1, squadRunId: 'prop-old' }),
          workItem({ id: 'new', sequence: 2, squadRunId: 'prop-new' }),
          workItem({ id: 'other', sequence: 3, squadRunId: 'other-proposal' }),
        ],
      ).map((child) => child.id),
    ).toEqual(['old', 'new']);
  });

  it('starts a blank row with no assignee', () => {
    expect(blankDraftRow('prop-1:new:1')).toEqual({
      key: 'prop-1:new:1',
      text: '',
      repo: null,
      role: null,
      agent: '',
      areas: '',
      assignee: null,
      priority: 2,
      acceptance: '',
      dependsOn: [],
    });
  });
});

describe('validateRows', () => {
  it('sends the rows with their text trimmed', () => {
    expect(validateRows([draft('  Dựng form  ')])).toEqual({
      ok: true,
      rows: [{ text: 'Dựng form', assignee: SESSION, priority: 2, dependsOn: [] }],
    });
  });

  it('needs at least one row', () => {
    expect(validateRows([])).toEqual({ ok: false, reason: 'Cần ít nhất 1 dòng việc.' });
  });

  it('takes up to SQUAD_MAX_ROWS rows and refuses one more', () => {
    const rows = Array.from({ length: SQUAD_MAX_ROWS }, (_, index) => draft(`việc ${index}`));
    expect(validateRows(rows).ok).toBe(true);
    expect(validateRows([...rows, draft('thêm')])).toEqual({
      ok: false,
      reason: `Tối đa ${SQUAD_MAX_ROWS} dòng việc.`,
    });
  });

  it('names the first row with no text', () => {
    expect(validateRows([draft('việc'), draft('   ')])).toEqual({
      ok: false,
      reason: 'Dòng 2 chưa có nội dung.',
    });
  });

  it('names the first row with no assignee', () => {
    expect(validateRows([draft('việc', null)])).toEqual({
      ok: false,
      reason: 'Dòng 1 chưa giao cho ai.',
    });
  });

  it('measures the text limit in bytes and accepts exactly the limit', () => {
    expect(validateRows([draft('x'.repeat(32768))]).ok).toBe(true);
    expect(validateRows([draft('x'.repeat(32769))])).toEqual({
      ok: false,
      reason: 'Dòng 1 dài quá 32 KB.',
    });
  });
});

describe('canStartSquad', () => {
  it('needs a member in the folder, not only a place for a new session', () => {
    expect(canStartSquad([NEW_OPTION])).toEqual({
      ok: false,
      reason: 'Thư mục này chưa có agent hay phiên omp nào để lập đội.',
    });
    expect(canStartSquad([])).toEqual({
      ok: false,
      reason: 'Thư mục này chưa có agent hay phiên omp nào để lập đội.',
    });
    expect(canStartSquad([SESSION_OPTION, NEW_OPTION])).toEqual({ ok: true });
  });
});

describe('squad lookup', () => {
  it('names a run by its folder as well as its id', () => {
    expect(squadRunKey({ runId: 'run-1', workspacePath: '/a' })).not.toBe(
      squadRunKey({ runId: 'run-1', workspacePath: '/b' }),
    );
  });

  it('finds a run in its own folder only', () => {
    const state = {
      ...stateFrom({}, WORKSPACE),
      squad: { [WORKSPACE]: { revision: 1, runs: [run()] } },
    };
    expect(findSquadRun(state, { runId: 'run-1', workspacePath: WORKSPACE })?.id).toBe('run-1');
    expect(findSquadRun(state, { runId: 'run-1', workspacePath: '/other' })).toBeUndefined();
  });

  it('lists every folder’s runs with no folder tag when no folder list is held', () => {
    const state = {
      ...stateFrom({}, WORKSPACE),
      squad: {
        '/a': { revision: 1, runs: [run({ id: 'a1' })] },
        '/b': { revision: 1, runs: [run({ id: 'b1' })] },
      },
    };
    const rows = visibleSquadRuns(state);
    expect(rows.map((row) => row.run.id)).toEqual(['a1', 'b1']);
    expect(rows.every((row) => row.folder === null)).toBe(true);
  });
});

describe('companySquad reduction', () => {
  it('stores a folder’s runs under that folder', () => {
    const state = applyCompanyMessage(stateFrom({}, WORKSPACE), squadMessage(1, [run()])).state;
    expect(state.squad[WORKSPACE]?.runs.map((item) => item.id)).toEqual(['run-1']);
  });

  it('ignores a message older than the revision it already holds', () => {
    const current = applyCompanyMessage(
      stateFrom({}, WORKSPACE),
      squadMessage(2, [run({ id: 'new' })]),
    ).state;
    const stale = applyCompanyMessage(current, squadMessage(1, [run({ id: 'old' })])).state;
    expect(stale.squad[WORKSPACE]?.runs.map((item) => item.id)).toEqual(['new']);
  });

  it('recognises the squad message as one of the company messages', () => {
    expect(isCompanyServerMessage({ type: 'companySquad' })).toBe(true);
  });
});

describe('squad client messages', () => {
  it('builds a request and a retry the server can read', () => {
    expect(squadRequest('req-1', WORKSPACE, 'Làm form')).toEqual({
      type: 'companySquadRequest',
      requestId: 'req-1',
      workspacePath: WORKSPACE,
      text: 'Làm form',
    });
    expect(squadRetry('req-2', WORKSPACE, 'run-1')).toEqual({
      type: 'companySquadRetry',
      requestId: 'req-2',
      workspacePath: WORKSPACE,
      runId: 'run-1',
    });
  });

  it('builds an approval under its own message type', () => {
    const rows = [{ text: 'Dựng form', assignee: SESSION }];
    expect(squadApprove('req-3', WORKSPACE, 'run-1', 'prop-1', rows).type).toBe(
      'companySquadApprove',
    );
  });
});

describe('squad progress view', () => {
  it('reads the bar and the label from the counts', () => {
    expect(squadProgressView({ done: 2, total: 5 })).toEqual({
      done: 2,
      total: 5,
      fraction: 0.4,
      label: '2/5',
    });
  });

  it('keeps the bar within 0 to 1 when the counts disagree', () => {
    expect(squadProgressView({ done: 7, total: 5 })).toEqual({
      done: 5,
      total: 5,
      fraction: 1,
      label: '5/5',
    });
    expect(squadProgressView({ done: -1, total: 4 })).toEqual({
      done: 0,
      total: 4,
      fraction: 0,
      label: '0/4',
    });
    expect(squadProgressView({ done: 3, total: -2 })).toEqual({
      done: 0,
      total: 0,
      fraction: 0,
      label: '0/0',
    });
  });
});

describe('row priority, acceptance and waits', () => {
  it('sends each row with its priority, its wait list, and acceptance when it has one', () => {
    const rows: SquadDraftRow[] = [
      { ...draft('Dựng form'), priority: 0, acceptance: '  Form gửi được  ' },
      { ...draft('Viết API'), dependsOn: [{ kind: 'row', row: 0 }] },
    ];
    expect(validateRows(rows)).toEqual({
      ok: true,
      rows: [
        {
          text: 'Dựng form',
          assignee: SESSION,
          priority: 0,
          dependsOn: [],
          acceptance: 'Form gửi được',
        },
        { text: 'Viết API', assignee: SESSION, priority: 2, dependsOn: [{ kind: 'row', row: 0 }] },
      ],
    });
  });

  it('names the row whose priority is outside P0 to P3', () => {
    expect(validateRows([{ ...draft('việc'), priority: 4 }])).toEqual({
      ok: false,
      reason: 'Dòng 1 có độ ưu tiên không hợp lệ.',
    });
  });

  it('refuses acceptance over its limit, counted in characters', () => {
    expect(validateRows([{ ...draft('việc'), acceptance: 'x'.repeat(1001) }])).toEqual({
      ok: false,
      reason: 'Dòng 1: phần "Xong khi" dài quá 1000 ký tự.',
    });
    expect(validateRows([{ ...draft('việc'), acceptance: 'x'.repeat(1000) }]).ok).toBe(true);
  });

  it('refuses a wait for the row itself, for a row not in the proposal, and a repeated wait', () => {
    expect(validateRows([{ ...draft('việc'), dependsOn: [{ kind: 'row', row: 0 }] }])).toEqual({
      ok: false,
      reason: 'Dòng 1: Không thể chờ chính dòng này.',
    });
    expect(validateRows([{ ...draft('việc'), dependsOn: [{ kind: 'row', row: 3 }] }])).toEqual({
      ok: false,
      reason: 'Dòng 1: Chờ một dòng không có trong đề xuất này.',
    });
    expect(
      validateRows([
        draft('việc'),
        {
          ...draft('việc 2'),
          dependsOn: [
            { kind: 'row', row: 0 },
            { kind: 'row', row: 0 },
          ],
        },
      ]),
    ).toEqual({ ok: false, reason: 'Dòng 2: Mỗi việc chỉ được chờ một lần.' });
  });

  it('refuses a wait list longer than the server takes', () => {
    const dependsOn = Array.from({ length: WORK_ITEM_DEPENDS_MAX + 1 }, (_, index) => ({
      kind: 'item' as const,
      sequence: index + 1,
    }));
    expect(validateRows([{ ...draft('việc'), dependsOn }])).toEqual({
      ok: false,
      reason: `Dòng 1: Chờ tối đa ${WORK_ITEM_DEPENDS_MAX} việc.`,
    });
  });

  it('refuses a wait for an item no longer open, and keeps it when no set is given', () => {
    const waiting: SquadDraftRow[] = [
      { ...draft('việc'), dependsOn: [{ kind: 'item', sequence: 7 }] },
    ];
    expect(validateRows(waiting, new Set([3]))).toEqual({
      ok: false,
      reason: 'Dòng 1: Việc #7 không còn mở.',
    });
    expect(validateRows(waiting).ok).toBe(true);
  });

  it('names a wait loop between rows', () => {
    const rows: SquadDraftRow[] = [
      { ...draft('A'), dependsOn: [{ kind: 'row', row: 1 }] },
      { ...draft('B'), dependsOn: [{ kind: 'row', row: 0 }] },
    ];
    expect(validateRows(rows)).toEqual({
      ok: false,
      reason: 'Dòng 1: Các dòng chờ nhau thành vòng lặp.',
    });
  });
});

describe('wait options and draft edits', () => {
  it('offers the other rows, then the open items by #n, and keeps a held wait no option offers', () => {
    const rows: SquadDraftRow[] = [
      draft('Dựng form'),
      { ...draft('Viết API'), dependsOn: [{ kind: 'item', sequence: 9 }] },
      draft('Chạy thử'),
    ];
    const open = [
      workItem({ id: 'i6', sequence: 6, text: 'Viết tài liệu', status: 'review' }),
      workItem({ id: 'i2', sequence: 2, text: 'Đã xong', status: 'done' }),
      workItem({ id: 'i4', sequence: 4, text: 'Chờ duyệt', status: 'queued' }),
    ];
    expect(
      proposalRowDepsOptions(rows, 1, open).map((option) => [
        option.key,
        option.label,
        option.selected,
      ]),
    ).toEqual([
      ['row:0', 'Việc 1 · Dựng form', false],
      ['row:2', 'Việc 3 · Chạy thử', false],
      ['item:4', '#4 · Chờ duyệt', false],
      ['item:6', '#6 · Viết tài liệu', false],
      ['item:9', '#9 · không còn mở', true],
    ]);
  });

  it('lists a row that waits for itself so the drawer can clear it', () => {
    const rows: SquadDraftRow[] = [{ ...draft('Dựng form'), dependsOn: [{ kind: 'row', row: 0 }] }];
    expect(proposalRowDepsOptions(rows, 0, [])).toEqual([
      {
        key: 'row:0',
        label: 'Việc 1 · chính dòng này',
        dependency: { kind: 'row', row: 0 },
        selected: true,
      },
    ]);
  });

  it('drops the waits on a removed row and moves later waits up by one', () => {
    const rows: SquadDraftRow[] = [
      { ...draft('A'), key: 'a' },
      { ...draft('B'), key: 'b', dependsOn: [{ kind: 'row', row: 0 }] },
      { ...draft('C'), key: 'c', dependsOn: [{ kind: 'row', row: 1 }] },
      {
        ...draft('D'),
        key: 'd',
        dependsOn: [
          { kind: 'row', row: 0 },
          { kind: 'row', row: 2 },
        ],
      },
    ];
    expect(removeDraftRow(rows, 'b').map((row) => [row.key, row.dependsOn])).toEqual([
      ['a', []],
      ['c', []],
      [
        'd',
        [
          { kind: 'row', row: 0 },
          { kind: 'row', row: 1 },
        ],
      ],
    ]);
  });

  it('adds a wait once and takes it back on the second toggle', () => {
    const rows: SquadDraftRow[] = [draft('A'), draft('B')];
    const once = toggleRowDependency(rows, 1, { kind: 'row', row: 0 });
    expect(once[1]?.dependsOn).toEqual([{ kind: 'row', row: 0 }]);
    expect(rows[1]?.dependsOn).toEqual([]);
    expect(toggleRowDependency(once, 1, { kind: 'row', row: 0 })[1]?.dependsOn).toEqual([]);
  });

  it('gives a wait label its heading, or just its number when the text is blank', () => {
    expect(waitItemLabel(workItem({ id: 'x', sequence: 4, text: 'Viết API' }))).toBe(
      '#4 · Viết API',
    );
    expect(waitItemLabel(workItem({ id: 'x', sequence: 4, text: '   ' }))).toBe('#4');
  });
});

describe('epic children', () => {
  const items: WorkItem[] = [
    workItem({ id: 'i3', sequence: 3, text: 'Dựng form', status: 'running', squadRunId: 'run-1' }),
    workItem({
      id: 'i5',
      sequence: 5,
      text: 'Viết API',
      status: 'queued',
      squadRunId: 'run-1',
      dependsOn: ['i2', 'i3', 'gone'],
    }),
    workItem({ id: 'i2', sequence: 2, text: 'Thiết kế', status: 'done', squadRunId: 'run-1' }),
    workItem({ id: 'i1', sequence: 1, text: 'Khảo sát', status: 'failed', squadRunId: 'run-1' }),
    workItem({
      id: 'i6',
      sequence: 6,
      text: 'Kiểm thử',
      status: 'queued',
      squadRunId: 'run-1',
      dependsOn: ['i1'],
    }),
    workItem({ id: 'i4', sequence: 4, text: 'Việc khác', status: 'review', squadRunId: 'run-2' }),
    workItem({ id: 'i7', sequence: 7, text: 'Việc lẻ', status: 'queued' }),
  ];

  it('lists a run’s children in #n order, leaving out other runs and loose items', () => {
    const children = epicChildren(run({ id: 'run-1' }), items);
    expect(children.map((child) => child.sequence)).toEqual([1, 2, 3, 5, 6]);
    expect(children.map((child) => child.statusLabel)).toEqual([
      'Lỗi',
      'Xong',
      'Đang làm',
      'Xếp hàng',
      'Xếp hàng',
    ]);
  });

  it('words each wait by the state of what it waits for', () => {
    const children = epicChildren(run({ id: 'run-1' }), items);
    expect(children.find((child) => child.sequence === 5)?.waits.map((wait) => wait.text)).toEqual([
      '#2 xong',
      'Chờ #3',
      'Chờ việc đã gỡ',
    ]);
    expect(children.find((child) => child.sequence === 6)?.waits.map((wait) => wait.text)).toEqual([
      '#1 bị lỗi',
    ]);
  });

  it('counts only open items as open sequences across the folder', () => {
    expect(openSequencesOf(items)).toEqual(new Set([3, 4, 5, 6, 7]));
  });
});

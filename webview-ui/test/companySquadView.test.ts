import { describe, expect, it } from 'vitest';

import type {
  CompanySquadMessage,
  SquadProposal,
  SquadRun,
  SquadRunStatus,
  WorkItemAssignee,
} from '../../core/src/messages.js';
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
  findSquadRun,
  progressLabel,
  rowsFromProposal,
  SQUAD_MAX_ROWS,
  type SquadDraftRow,
  squadEventLabel,
  squadLaneFor,
  squadRunKey,
  squadStatusLabel,
  validateRows,
  visibleSquadRuns,
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
      { text: 'Dựng form', assignee: SESSION },
      { text: 'Viết API', assignee: SESSION },
    ],
    status: 'pending',
    createdAt: AT,
    ...overrides,
  };
}

function draft(text: string, assignee: WorkItemAssignee | null = SESSION): SquadDraftRow {
  return { key: `key-${text}`, text, assignee };
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
      { key: 'prop-1:0', text: 'Dựng form', assignee: SESSION },
      { key: 'prop-1:1', text: 'Viết API', assignee: SESSION },
    ]);
  });

  it('starts a blank row with no assignee', () => {
    expect(blankDraftRow('prop-1:new:1')).toEqual({
      key: 'prop-1:new:1',
      text: '',
      assignee: null,
    });
  });
});

describe('validateRows', () => {
  it('sends the rows with their text trimmed', () => {
    expect(validateRows([draft('  Dựng form  ')])).toEqual({
      ok: true,
      rows: [{ text: 'Dựng form', assignee: SESSION }],
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

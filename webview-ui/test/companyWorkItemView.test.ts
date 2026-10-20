import { describe, expect, it } from 'vitest';

import type {
  AgentRole,
  CompanyWorkspaceEntry,
  SquadSettings,
  WorkItem,
  WorkItemStatus,
} from '../../core/src/messages.js';
import { buildBoardLanes } from '../src/company/boardView.js';
import {
  applyCompanyMessage,
  type CompanyViewState,
  emptyCompanyState,
} from '../src/company/companyState.js';
import { drawerSubjectKey } from '../src/company/selection.js';
import {
  assigneeLabel,
  laneForWorkItem,
  NEW_SESSION_LABEL,
  queuePosition,
  queueWaitText,
  roleDescriptionFor,
  statusWordVi,
  visibleWorkItems,
  WORK_ITEM_HEAD_MAX_CHARS,
  workItemCardHead,
  workItemKey,
  workItemsOf,
} from '../src/company/workItemView.js';
import { session, stateFrom } from './companyFixtures.js';

const ACTIVE = 'D:/work/app';
const OTHER = 'D:/work/site';

const SETTINGS: SquadSettings = {
  maxParallel: 4,
  maxSquadSessions: 3,
  minFreeRamGb: 2,
  autoJudge: true,
  autoApproveNext: false,
  brain: 'omp',
  claudeModelLeader: 'opus',
  claudeModelJudge: 'sonnet',
  preferClaude: false,
  maxClaudeRuns: 2,
  claudeMaxTurns: 40,
  claudeMaxBudgetUsd: 3,
};

function item(overrides: Pick<WorkItem, 'id'> & Partial<WorkItem>): WorkItem {
  return {
    text: 'Viết trang bảng xếp hạng',
    assignee: { kind: 'herdr', paneId: 'p1' },
    status: 'queued',
    sequence: 1,
    priority: 2,
    dependsOn: [],
    createdAt: '2026-05-01T10:00:00.000Z',
    updatedAt: '2026-05-01T10:00:00.000Z',
    history: [],
    ...overrides,
  };
}

function folder(path: string, active: boolean): CompanyWorkspaceEntry {
  return { path, active, open: true, working: 0, waiting: 0 };
}

/** Stores a folder's work items through the same message the server sends. */
function withWorkItems(
  state: CompanyViewState,
  workspacePath: string,
  items: WorkItem[],
  revision = 1,
  roles: AgentRole[] = [],
): CompanyViewState {
  return applyCompanyMessage(state, {
    type: 'companyWorkItems',
    workspacePath,
    revision,
    items,
    roles,
    repos: [],
    agents: [],
    settings: SETTINGS,
  }).state;
}

/** A board with two open folders and a herdr roster naming pane p1 and pane p2. */
function boardWithRoster(viewMode: 'all' | 'folder'): CompanyViewState {
  const listed = applyCompanyMessage(
    emptyCompanyState({ viewMode, focusPath: viewMode === 'folder' ? ACTIVE : null }),
    {
      type: 'companyWorkspaces',
      workspaces: [folder(ACTIVE, true), folder(OTHER, false)],
    },
  ).state;
  return applyCompanyMessage(listed, {
    type: 'herdrAgents',
    available: true,
    agents: [
      { paneId: 'p1', name: 'Dev A', kind: 'claude', status: 'idle', workspaceId: 'ws-1' },
      { paneId: 'p2', title: 'Tiêu đề', kind: 'claude', status: 'idle', workspaceId: 'ws-1' },
    ],
    sleeping: [],
  }).state;
}

describe('laneForWorkItem', () => {
  it('maps each status to the lane the board names for it', () => {
    expect(laneForWorkItem('queued')).toBe('ready');
    expect(laneForWorkItem('running')).toBe('running');
    expect(laneForWorkItem('needs_input')).toBe('needs_input');
    expect(laneForWorkItem('review')).toBe('review');
    expect(laneForWorkItem('done')).toBe('done');
    expect(laneForWorkItem('failed')).toBe('failed');
  });
});

describe('statusWordVi', () => {
  it('names every status in Vietnamese, each word distinct', () => {
    const statuses: WorkItemStatus[] = [
      'queued',
      'running',
      'needs_input',
      'review',
      'done',
      'failed',
    ];
    const words = statuses.map(statusWordVi);
    expect(words.every((word) => word.length > 0)).toBe(true);
    expect(new Set(words).size).toBe(statuses.length);
  });
});

describe('assigneeLabel', () => {
  it('names a herdr pane by its agent name, then its title, then its pane id', () => {
    const state = boardWithRoster('all');
    expect(assigneeLabel({ kind: 'herdr', paneId: 'p1' }, state, ACTIVE)).toBe('Dev A');
    expect(assigneeLabel({ kind: 'herdr', paneId: 'p2' }, state, ACTIVE)).toBe('Tiêu đề');
    expect(assigneeLabel({ kind: 'herdr', paneId: 'p9' }, state, ACTIVE)).toBe('p9');
  });

  it('names an omp session by its name, then its code, then says it is gone', () => {
    const state = stateFrom({
      sessions: [
        session({ id: 's-named', name: 'Lập trình', code: 'PA-1' }),
        session({ id: 's-code', name: '', code: 'PA-2' }),
      ],
    });
    expect(assigneeLabel({ kind: 'session', sessionId: 's-named' }, state, ACTIVE)).toBe(
      'Lập trình',
    );
    expect(assigneeLabel({ kind: 'session', sessionId: 's-code' }, state, ACTIVE)).toBe('PA-2');
    expect(assigneeLabel({ kind: 'session', sessionId: 's-gone' }, state, ACTIVE)).toBe(
      'Phiên không còn trên bảng',
    );
  });

  it('names a new session with the shared label', () => {
    expect(assigneeLabel({ kind: 'new-session' }, emptyCompanyState(), ACTIVE)).toBe(
      NEW_SESSION_LABEL,
    );
  });
});

describe('queuePosition', () => {
  it('numbers queued items per assignee in sequence order, and 0 when not queued', () => {
    const a = item({ id: 'a', sequence: 1 });
    const b = item({ id: 'b', sequence: 2 });
    const c = item({ id: 'c', sequence: 3, assignee: { kind: 'herdr', paneId: 'p2' } });
    const d = item({ id: 'd', sequence: 4, status: 'running' });
    const items = [d, b, c, a];
    expect(queuePosition(a, items)).toBe(1);
    expect(queuePosition(b, items)).toBe(2);
    expect(queuePosition(c, items)).toBe(1);
    expect(queuePosition(d, items)).toBe(0);
  });
});

describe('queueWaitText', () => {
  it('says who is busy, and where the item stands when others wait ahead of it', () => {
    expect(queueWaitText('Dev A', 1)).toBe('Chờ Dev A rảnh');
    expect(queueWaitText('Dev A', 3)).toBe('Chờ Dev A rảnh · thứ 3 trong hàng');
  });
});

describe('workItemCardHead', () => {
  it('takes the first non-blank line, trimmed', () => {
    expect(workItemCardHead('  \n\n  Mở đầu  \nphần sau')).toBe('Mở đầu');
  });

  it('is empty for blank text', () => {
    expect(workItemCardHead('')).toBe('');
    expect(workItemCardHead('   \n  ')).toBe('');
  });

  it('cuts a long line at the limit and marks the cut', () => {
    const head = workItemCardHead('a'.repeat(WORK_ITEM_HEAD_MAX_CHARS + 20));
    expect(Array.from(head)).toHaveLength(WORK_ITEM_HEAD_MAX_CHARS);
    expect(head.endsWith('…')).toBe(true);
  });

  it('keeps a line exactly at the limit whole', () => {
    const line = 'b'.repeat(WORK_ITEM_HEAD_MAX_CHARS);
    expect(workItemCardHead(line)).toBe(line);
  });
});

describe('workItemsOf and roleDescriptionFor', () => {
  it('reads an empty folder as empty lists and no settings', () => {
    const state = emptyCompanyState();
    expect(workItemsOf(state, ACTIVE)).toEqual({
      revision: 0,
      items: [],
      parkedSessionIds: [],
      claudeStatus: null,
      roles: [],
      repos: [],
      agents: [],
      settings: null,
    });
    expect(roleDescriptionFor(state, ACTIVE, { kind: 'herdr', paneId: 'p1' })).toBe('');
  });

  it('returns the description of the matching role only', () => {
    const roles: AgentRole[] = [
      {
        agent: { kind: 'herdr', paneId: 'p1' },
        description: 'Lập trình viên',
        updatedAt: '2026-05-01T10:00:00.000Z',
      },
    ];
    const state = withWorkItems(emptyCompanyState(), ACTIVE, [], 1, roles);
    expect(roleDescriptionFor(state, ACTIVE, { kind: 'herdr', paneId: 'p1' })).toBe(
      'Lập trình viên',
    );
    expect(roleDescriptionFor(state, ACTIVE, { kind: 'herdr', paneId: 'p2' })).toBe('');
    expect(roleDescriptionFor(state, OTHER, { kind: 'herdr', paneId: 'p1' })).toBe('');
  });
});

describe('companyWorkItems ingest', () => {
  it('replaces a folder list only when the revision is newer', () => {
    const a = item({ id: 'a' });
    const b = item({ id: 'b', sequence: 2 });
    const first = withWorkItems(emptyCompanyState(), ACTIVE, [a], 2);
    expect(workItemsOf(first, ACTIVE).items.map((entry) => entry.id)).toEqual(['a']);

    const equal = withWorkItems(first, ACTIVE, [a, b], 2);
    expect(workItemsOf(equal, ACTIVE).items.map((entry) => entry.id)).toEqual(['a']);

    const older = withWorkItems(first, ACTIVE, [], 1);
    expect(workItemsOf(older, ACTIVE).items.map((entry) => entry.id)).toEqual(['a']);

    const newer = withWorkItems(first, ACTIVE, [b], 3);
    expect(workItemsOf(newer, ACTIVE).items.map((entry) => entry.id)).toEqual(['b']);
    expect(workItemsOf(newer, ACTIVE).revision).toBe(3);
  });

  it('keeps each folder list apart', () => {
    const state = withWorkItems(
      withWorkItems(emptyCompanyState(), ACTIVE, [item({ id: 'a' })]),
      OTHER,
      [item({ id: 'b' })],
    );
    expect(workItemsOf(state, ACTIVE).items.map((entry) => entry.id)).toEqual(['a']);
    expect(workItemsOf(state, OTHER).items.map((entry) => entry.id)).toEqual(['b']);
  });
});

describe('visibleWorkItems', () => {
  it('shows only the active folder in folder mode, with no folder tag', () => {
    const state = withWorkItems(
      withWorkItems(boardWithRoster('folder'), ACTIVE, [item({ id: 'a' })]),
      OTHER,
      [item({ id: 'b' })],
    );
    const visible = visibleWorkItems(state);
    expect(visible.map((entry) => entry.item.id)).toEqual(['a']);
    expect(visible[0]?.folder).toBeNull();
  });

  it('shows every open folder in all mode, in folder order, each tagged with its folder', () => {
    // Sequences are per folder, so they never order items across folders.
    const state = withWorkItems(
      withWorkItems(boardWithRoster('all'), ACTIVE, [item({ id: 'a', sequence: 2 })]),
      OTHER,
      [item({ id: 'b', sequence: 1 })],
    );
    const visible = visibleWorkItems(state);
    expect(visible.map((entry) => entry.item.id)).toEqual(['a', 'b']);
    expect(visible.map((entry) => entry.workspacePath)).toEqual([ACTIVE, OTHER]);
    expect(visible.every((entry) => entry.folder !== null)).toBe(true);
    expect(visible[1]?.folder?.path).toBe(OTHER);
  });
});

describe('workItemKey and drawerSubjectKey', () => {
  it('tells apart the same item id in two folders', () => {
    expect(workItemKey({ id: 'a', workspacePath: ACTIVE })).not.toBe(
      workItemKey({ id: 'a', workspacePath: OTHER }),
    );
    expect(drawerSubjectKey({ kind: 'workItem', id: 'a', workspacePath: ACTIVE })).not.toBe(
      drawerSubjectKey({ kind: 'workItem', id: 'a', workspacePath: OTHER }),
    );
  });
});

describe('buildBoardLanes and work items', () => {
  it('places each work item in the lane for its status, beside the task cards', () => {
    const state = withWorkItems(boardWithRoster('all'), ACTIVE, [
      item({ id: 'q', sequence: 1, reason: 'Chờ Dev A rảnh' }),
      item({ id: 'd', sequence: 2, status: 'done', assignee: { kind: 'herdr', paneId: 'p2' } }),
    ]);
    const lanes = buildBoardLanes(state);
    const ready = lanes.find((lane) => lane.id === 'ready');
    const done = lanes.find((lane) => lane.id === 'done');

    expect(ready?.cards).toEqual([]);
    expect(ready?.workItems.map((card) => card.id)).toEqual(['q']);
    expect(ready?.workItems[0]).toMatchObject({
      lane: 'ready',
      status: 'queued',
      head: 'Viết trang bảng xếp hạng',
      reason: 'Chờ Dev A rảnh',
      sequence: 1,
      priority: 2,
      blocker: null,
    });
    expect(ready?.workItems[0]?.assignee).toBe('Dev A');
    expect(done?.workItems.map((card) => card.id)).toEqual(['d']);
  });
});

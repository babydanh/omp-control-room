import { describe, expect, it } from 'vitest';

import type { WorkItem } from '../../core/src/messages.js';
import { WORK_ITEM_DEPENDS_MAX } from '../../core/src/workItemGraph.js';
import {
  squadRequestFromWorkItem,
  workItemCreate,
  workItemDependencies,
} from '../src/company/companyMessages.js';
import {
  blockerChip,
  dependencyChoices,
  dependencyRefusal,
  dependencyRefusalText,
  isOpenWorkItem,
  queueOrder,
  statusWordVi,
  waitingOn,
  waitingOnLabel,
} from '../src/company/workItemView.js';

const ACTIVE = 'D:/work/app';

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

describe('blockerChip', () => {
  it('returns no chip when nothing holds the item', () => {
    expect(blockerChip({})).toBeNull();
    expect(blockerChip({ blocker: null })).toBeNull();
  });

  it('names a busy agent in muted tone', () => {
    expect(blockerChip({ blocker: { kind: 'agent' } })).toEqual({
      text: 'Agent đang bận',
      tone: 'muted',
    });
  });

  it('names a wait on another item in muted tone, with or without its #n', () => {
    expect(blockerChip({ blocker: { kind: 'dependency', sequence: 3 } })).toEqual({
      text: 'Chờ việc khác',
      tone: 'muted',
    });
    expect(blockerChip({ blocker: { kind: 'dependency' } })).toEqual({
      text: 'Chờ việc khác',
      tone: 'muted',
    });
  });

  it('names a failed dependency in danger tone', () => {
    expect(blockerChip({ blocker: { kind: 'failed', sequence: 2 } })).toEqual({
      text: 'Việc lỗi',
      tone: 'danger',
    });
    expect(blockerChip({ blocker: { kind: 'failed' } })).toEqual({
      text: 'Việc lỗi',
      tone: 'danger',
    });
  });

  it('shows the running count of a full folder, or only the words when the count is missing', () => {
    expect(blockerChip({ blocker: { kind: 'capacity', running: 4, limit: 4 } })).toEqual({
      text: 'Đầy chỗ 4/4',
      tone: 'muted',
    });
    expect(blockerChip({ blocker: { kind: 'capacity' } })).toEqual({
      text: 'Đầy chỗ',
      tone: 'muted',
    });
  });

  it('names a held code area and an item with no agent to take it, in muted tone', () => {
    expect(blockerChip({ blocker: { kind: 'area', area: 'auth' } })).toEqual({
      text: 'Vùng đang bị giữ',
      tone: 'muted',
    });
    expect(blockerChip({ blocker: { kind: 'no_member' } })).toEqual({
      text: 'Chưa có agent',
      tone: 'muted',
    });
  });

  it('names a busy repo, a worktree not yet made and a full pool, in muted tone', () => {
    expect(blockerChip({ blocker: { kind: 'busy_checkout', area: 'web' } })).toEqual({
      text: 'Repo đang bận',
      tone: 'muted',
    });
    expect(blockerChip({ blocker: { kind: 'worktree' } })).toEqual({
      text: 'Chờ worktree',
      tone: 'muted',
    });
    expect(blockerChip({ blocker: { kind: 'pool_full' } })).toEqual({
      text: 'Hết phiên chạy',
      tone: 'muted',
    });
    expect(blockerChip({ blocker: { kind: 'disk_full' } })).toEqual({
      text: 'Chờ ổ đĩa',
      tone: 'muted',
    });
  });
});

describe('queueOrder', () => {
  it('orders queued items by priority, then creation order, and leaves the input alone', () => {
    const a = item({ id: 'a', sequence: 1, priority: 2 });
    const b = item({ id: 'b', sequence: 2, priority: 0 });
    const c = item({ id: 'c', sequence: 3, priority: 2 });
    const d = item({ id: 'd', sequence: 4, priority: 1 });
    const running = item({ id: 'r', sequence: 5, priority: 0, status: 'running' });
    const input = [a, b, c, d, running];

    expect(queueOrder(input).map((entry) => entry.id)).toEqual(['b', 'd', 'a', 'c']);
    expect(input.map((entry) => entry.id)).toEqual(['a', 'b', 'c', 'd', 'r']);
  });
});

describe('isOpenWorkItem', () => {
  it('counts queued, running, needs-input and review as open', () => {
    expect(isOpenWorkItem('queued')).toBe(true);
    expect(isOpenWorkItem('running')).toBe(true);
    expect(isOpenWorkItem('needs_input')).toBe(true);
    expect(isOpenWorkItem('review')).toBe(true);
  });

  it('counts done and failed as closed', () => {
    expect(isOpenWorkItem('done')).toBe(false);
    expect(isOpenWorkItem('failed')).toBe(false);
  });
});

describe('waitingOn and waitingOnLabel', () => {
  it('lists the waits in #n order, with a removed item last and marked removed', () => {
    const first = item({ id: 'first', sequence: 1, text: 'Dựng khung', status: 'done' });
    const second = item({ id: 'second', sequence: 2, text: 'Viết API', status: 'running' });
    const waiter = item({ id: 'waiter', sequence: 3, dependsOn: ['second', 'gone', 'first'] });

    const entries = waitingOn(waiter, [waiter, second, first]);

    expect(entries.map((entry) => entry.id)).toEqual(['first', 'second', 'gone']);
    expect(entries[2]).toEqual({ id: 'gone', sequence: null, text: '', status: 'removed' });
    expect(entries.map((entry) => waitingOnLabel(entry))).toEqual([
      `#1 Dựng khung · ${statusWordVi('done')}`,
      `#2 Viết API · ${statusWordVi('running')}`,
      'Việc đã bị gỡ',
    ]);
  });
});

describe('dependencyChoices', () => {
  it('offers the open items plus the current waits, and never the item itself', () => {
    const first = item({ id: 'first', sequence: 1, status: 'done' });
    const second = item({ id: 'second', sequence: 2, status: 'running' });
    const third = item({ id: 'third', sequence: 3, status: 'done' });
    const waiter = item({ id: 'waiter', sequence: 4, dependsOn: ['first'] });

    const choices = dependencyChoices(waiter, [first, second, third, waiter]);

    expect(choices.map((choice) => choice.id)).toEqual(['first', 'second']);
  });

  it('keeps a removed current wait in the list so saving cannot drop it silently', () => {
    const waiter = item({ id: 'waiter', sequence: 1, dependsOn: ['gone'] });

    const choices = dependencyChoices(waiter, [waiter]);

    expect(choices).toEqual([{ id: 'gone', sequence: null, text: '', status: 'removed' }]);
  });
});

describe('dependencyRefusal', () => {
  const a = item({ id: 'a', sequence: 1 });
  const b = item({ id: 'b', sequence: 2, dependsOn: ['a'] });

  it('accepts a list of real items that closes no loop', () => {
    expect(dependencyRefusal(b, ['a'], [a, b])).toBeNull();
    expect(dependencyRefusal(a, [], [a, b])).toBeNull();
  });

  it('refuses an item that waits for itself', () => {
    expect(dependencyRefusal(a, ['a'], [a, b])).toBe('self');
  });

  it('refuses an id the folder does not hold', () => {
    expect(dependencyRefusal(a, ['missing'], [a, b])).toBe('unknown');
  });

  it('refuses the same id twice', () => {
    expect(dependencyRefusal(b, ['a', 'a'], [a, b])).toBe('duplicate');
  });

  it('refuses more than the most waits an item may hold', () => {
    const many = Array.from({ length: WORK_ITEM_DEPENDS_MAX + 1 }, (_, n) => `x${n}`);
    expect(dependencyRefusal(a, many, [a, b])).toBe('too_many');
  });

  it('refuses a wait that closes a loop', () => {
    // b already waits for a, so a waiting for b would close the loop a -> b -> a.
    expect(dependencyRefusal(a, ['b'], [a, b])).toBe('cycle');
  });
});

describe('dependencyRefusalText', () => {
  it('gives each refusal its own sentence, and the cap sentence names the cap', () => {
    const refusals = ['too_many', 'duplicate', 'self', 'unknown', 'cycle'] as const;
    const sentences = refusals.map((refusal) => dependencyRefusalText(refusal));

    expect(new Set(sentences).size).toBe(refusals.length);
    expect(sentences[0]).toContain(String(WORK_ITEM_DEPENDS_MAX));
  });
});

describe('work item message builders', () => {
  it('carries priority, acceptance and waits on create, and omits them when unset', () => {
    expect(
      workItemCreate(
        'r1',
        ACTIVE,
        'Viết API',
        { kind: 'herdr', paneId: 'p1' },
        {
          priority: 0,
          acceptance: 'Có test',
          dependsOn: ['a'],
        },
      ),
    ).toEqual({
      type: 'companyWorkItemCreate',
      requestId: 'r1',
      workspacePath: ACTIVE,
      text: 'Viết API',
      assignee: { kind: 'herdr', paneId: 'p1' },
      priority: 0,
      acceptance: 'Có test',
      dependsOn: ['a'],
    });

    expect(workItemCreate('r1', ACTIVE, 'Viết API', { kind: 'herdr', paneId: 'p1' })).toEqual({
      type: 'companyWorkItemCreate',
      requestId: 'r1',
      workspacePath: ACTIVE,
      text: 'Viết API',
      assignee: { kind: 'herdr', paneId: 'p1' },
    });
  });

  it('sends the whole wait list, and an empty list clears it', () => {
    expect(workItemDependencies('r2', ACTIVE, 'w1', ['a', 'b'])).toEqual({
      type: 'companyWorkItemDependencies',
      requestId: 'r2',
      workspacePath: ACTIVE,
      id: 'w1',
      dependsOn: ['a', 'b'],
    });
    expect(workItemDependencies('r3', ACTIVE, 'w1', [])).toMatchObject({ dependsOn: [] });
  });

  it('asks the squad from a review item by its id, with no request text', () => {
    expect(squadRequestFromWorkItem('r4', ACTIVE, 'w1')).toEqual({
      type: 'companySquadRequest',
      requestId: 'r4',
      workspacePath: ACTIVE,
      fromWorkItemId: 'w1',
    });
  });
});

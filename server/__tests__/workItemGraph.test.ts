import { describe, expect, it } from 'vitest';

import type { WorkItemStatus } from '../../core/src/messages.js';
import {
  blockerOf,
  blockerReason,
  checkDependsOn,
  closesLoop,
  compareQueue,
  composePrompt,
  dependenciesDone,
  type DependencyState,
  graphHasCycle,
  isWorkItemPriority,
  priorityLabel,
  WORK_ITEM_ACCEPTANCE_MAX_CHARS,
  WORK_ITEM_DEPENDS_MAX,
} from '../../core/src/workItemGraph.js';

/** Dependencies of a fixed graph: an id's waits, or undefined for an id that is not on the board. */
function waitsOf(graph: Record<string, string[]>): (id: string) => string[] | undefined {
  return (id) => graph[id];
}

/** Edges of a fixed graph, where an id with no entry has no waits. */
function edgesOf(graph: Record<string, string[]>): (id: string) => string[] {
  return (id) => graph[id] ?? [];
}

function at(status: WorkItemStatus, sequence: number): DependencyState {
  return { status, sequence };
}

/** Each id's state from a table; an id missing from the table reads as failed, like a removed item. */
function stateOf(table: Record<string, DependencyState>): (id: string) => DependencyState {
  return (id) => table[id] ?? at('failed', 0);
}

const noWaits = (): string[] => [];

describe('priority values', () => {
  it('accepts whole numbers from P0 to P3 only', () => {
    for (const value of [0, 1, 2, 3]) expect(isWorkItemPriority(value)).toBe(true);
    for (const value of [-1, 4, 2.5, '2', null, undefined]) {
      expect(isWorkItemPriority(value)).toBe(false);
    }
  });

  it('labels a priority as P followed by its number', () => {
    expect(priorityLabel(0)).toBe('P0');
    expect(priorityLabel(3)).toBe('P3');
  });
});

describe('checkDependsOn', () => {
  it('accepts a wait list at the cap and refuses one more', () => {
    const atCap = Array.from({ length: WORK_ITEM_DEPENDS_MAX }, (_, index) => `id-${index}`);
    expect(checkDependsOn('self', atCap, noWaits)).toBeNull();
    expect(checkDependsOn('self', [...atCap, 'id-extra'], noWaits)).toBe('too_many');
  });

  it('refuses a repeated wait', () => {
    expect(checkDependsOn('self', ['a', 'b', 'a'], noWaits)).toBe('duplicate');
  });

  it('refuses a wait on itself only for an item that already exists', () => {
    expect(checkDependsOn('a', ['a'], noWaits)).toBe('self');
    expect(checkDependsOn(null, ['a'], noWaits)).toBeNull();
  });

  it('refuses a wait on an id that is not on the board', () => {
    expect(checkDependsOn('a', ['gone'], () => undefined)).toBe('unknown');
  });

  it('refuses a wait that closes a loop, and accepts a diamond', () => {
    expect(checkDependsOn('a', ['b'], waitsOf({ b: ['a'] }))).toBe('cycle');
    expect(checkDependsOn('a', ['b', 'c'], waitsOf({ b: ['d'], c: ['d'], d: [] }))).toBeNull();
  });

  it('reports the first refusal in order: too many before unknown', () => {
    const unknown = Array.from({ length: WORK_ITEM_DEPENDS_MAX + 1 }, (_, index) => `x${index}`);
    expect(checkDependsOn('a', unknown, () => undefined)).toBe('too_many');
  });
});

describe('closesLoop and graphHasCycle', () => {
  it('finds a loop back to the item itself, and ignores a loop elsewhere', () => {
    expect(closesLoop('a', ['b'], waitsOf({ b: ['c'], c: ['a'] }))).toBe(true);
    expect(closesLoop('a', ['b'], waitsOf({ b: ['c'], c: ['b'] }))).toBe(false);
  });

  it('detects a self loop and a loop of three', () => {
    expect(graphHasCycle(['a'], edgesOf({ a: ['a'] }))).toBe(true);
    expect(graphHasCycle(['a', 'b', 'c'], edgesOf({ a: ['b'], b: ['c'], c: ['a'] }))).toBe(true);
  });

  it('accepts an acyclic graph, including a long chain without recursion', () => {
    expect(graphHasCycle(['a'], edgesOf({ a: ['b', 'c'], b: ['c'], c: [] }))).toBe(false);
    const nodes = Array.from({ length: 50_000 }, (_, index) => index);
    const chain = (index: number): number[] => (index + 1 < nodes.length ? [index + 1] : []);
    expect(graphHasCycle(nodes, chain)).toBe(false);
  });
});

describe('blockerOf', () => {
  it('returns no blocker when every wait is done and the agent is free', () => {
    expect(blockerOf([], stateOf({}), false)).toBeNull();
    expect(blockerOf(['a'], stateOf({ a: at('done', 1) }), false)).toBeNull();
  });

  it('treats a wait in review as not done yet', () => {
    expect(blockerOf(['a'], stateOf({ a: at('review', 2) }), false)).toEqual({
      kind: 'dependency',
      sequence: 2,
    });
  });

  it('names the lowest pending #n', () => {
    const table = { a: at('running', 5), b: at('queued', 3) };
    expect(blockerOf(['a', 'b'], stateOf(table), false)).toEqual({
      kind: 'dependency',
      sequence: 3,
    });
  });

  it('prefers a failed wait over a pending one, and names the lowest failed #n', () => {
    const table = { a: at('queued', 1), b: at('failed', 7), c: at('failed', 4) };
    expect(blockerOf(['a', 'b', 'c'], stateOf(table), false)).toEqual({
      kind: 'failed',
      sequence: 4,
    });
  });

  it('holds the item for its agent only when nothing it waits for holds it', () => {
    expect(blockerOf([], stateOf({}), true)).toEqual({ kind: 'agent' });
    expect(blockerOf(['a'], stateOf({ a: at('queued', 1) }), true)).toEqual({
      kind: 'dependency',
      sequence: 1,
    });
  });
});

describe('blockerReason', () => {
  it('states each blocker in Vietnamese with its #n', () => {
    expect(blockerReason({ kind: 'agent' })).toBe('Chờ agent rảnh để nhận việc.');
    expect(blockerReason({ kind: 'dependency', sequence: 3 })).toBe('Chờ việc #3 xong.');
    expect(blockerReason({ kind: 'failed', sequence: 4 })).toBe(
      'Việc #4 bị lỗi, gỡ chờ hoặc giao lại.',
    );
  });
});

describe('dependenciesDone', () => {
  it('treats an empty wait list as done, and a review as not done', () => {
    expect(dependenciesDone([], stateOf({}))).toBe(true);
    expect(dependenciesDone(['a', 'b'], stateOf({ a: at('done', 1), b: at('review', 2) }))).toBe(
      false,
    );
  });
});

describe('compareQueue', () => {
  it('orders by priority first, then by creation, never by anything else', () => {
    const items = [
      { priority: 2, sequence: 1 },
      { priority: 0, sequence: 9 },
      { priority: 2, sequence: 0 },
      { priority: 1, sequence: 5 },
      { priority: 0, sequence: 4 },
    ];
    expect([...items].sort(compareQueue)).toEqual([
      { priority: 0, sequence: 4 },
      { priority: 0, sequence: 9 },
      { priority: 1, sequence: 5 },
      { priority: 2, sequence: 0 },
      { priority: 2, sequence: 1 },
    ]);
  });
});

describe('composePrompt', () => {
  it('sends the text alone when there are no criteria or only blank ones', () => {
    expect(composePrompt('Sửa', undefined)).toBe('Sửa');
    expect(composePrompt('Sửa', '  \n ')).toBe('Sửa');
  });

  it('adds the criteria after a blank line, trimmed', () => {
    expect(composePrompt('Sửa', '  Test pass  ')).toBe('Sửa\n\nXong khi: Test pass');
  });

  it('keeps the criteria length limit as a whole number of characters', () => {
    expect(WORK_ITEM_ACCEPTANCE_MAX_CHARS).toBe(1000);
  });
});

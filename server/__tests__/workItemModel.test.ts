import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  assigneeKey,
  canCancel,
  canFollowUp,
  canMark,
  canReassign,
  isWorkItemAssignee,
  normalizeAssignee,
  observeHerdrStatus,
  observeSessionStatus,
  occupiesAgent,
  parseWorkItemsFile,
  refuseText,
  toWorkItem,
} from '../src/company/workItems/workItemModel.js';

const AT = '2026-05-01T08:00:00.000Z';

function storedRaw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: randomUUID(),
    text: 'Việc',
    assignee: { kind: 'herdr', paneId: 'wA:p1' },
    status: 'queued',
    sequence: 3,
    createdAt: AT,
    updatedAt: AT,
    history: [{ at: AT, kind: 'created' }],
    ...overrides,
  };
}

describe('work item status rules', () => {
  it('maps herdr statuses: idle and done are free, blocked waits on the user, the rest is busy', () => {
    expect(observeHerdrStatus('idle')).toBe('free');
    expect(observeHerdrStatus('done')).toBe('free');
    expect(observeHerdrStatus('blocked')).toBe('blocked');
    expect(observeHerdrStatus('working')).toBe('busy');
    expect(observeHerdrStatus('unknown')).toBe('busy');
  });

  it('maps omp session statuses, leaving undecided ones alone and treating ended ones as gone', () => {
    expect(observeSessionStatus('idle')).toBe('free');
    expect(observeSessionStatus('waiting_input')).toBe('blocked');
    expect(observeSessionStatus('busy')).toBe('busy');
    expect(observeSessionStatus('starting')).toBe('busy');
    expect(observeSessionStatus('parked')).toBe('unknown');
    expect(observeSessionStatus('pausing')).toBe('unknown');
    expect(observeSessionStatus('stopped')).toBe('gone');
    expect(observeSessionStatus('crashed')).toBe('gone');
    expect(observeSessionStatus('archived')).toBe('gone');
  });

  it('lets only running and needs_input items hold an agent', () => {
    expect(occupiesAgent('running')).toBe(true);
    expect(occupiesAgent('needs_input')).toBe(true);
    expect(occupiesAgent('review')).toBe(false);
    expect(occupiesAgent('queued')).toBe(false);
  });

  it('allows follow-up only from review or failed, reassign from queued, review or failed, cancel only from queued', () => {
    expect(canFollowUp('review')).toBe(true);
    expect(canFollowUp('failed')).toBe(true);
    expect(canFollowUp('queued')).toBe(false);
    expect(canReassign('queued')).toBe(true);
    expect(canReassign('running')).toBe(false);
    expect(canCancel('queued')).toBe(true);
    expect(canCancel('review')).toBe(false);
  });

  it('refuses a verdict on a done item or a repeated verdict', () => {
    expect(canMark('review', 'done')).toBe(true);
    expect(canMark('failed', 'done')).toBe(true);
    expect(canMark('done', 'failed')).toBe(false);
    expect(canMark('failed', 'failed')).toBe(false);
  });

  it('refuses text that is blank or over the byte limit', () => {
    expect(refuseText('  \n')).toBe('empty_text');
    expect(refuseText('việc')).toBeNull();
    expect(refuseText('x'.repeat(32 * 1024 + 1))).toBe('prompt_too_large');
  });
});

describe('work item assignees', () => {
  it('accepts herdr panes, sessions and new sessions, and rejects anything else', () => {
    expect(isWorkItemAssignee({ kind: 'herdr', paneId: 'wA:p1' })).toBe(true);
    expect(isWorkItemAssignee({ kind: 'herdr', paneId: 'not a pane' })).toBe(false);
    expect(isWorkItemAssignee({ kind: 'session', sessionId: 's-1' })).toBe(true);
    expect(isWorkItemAssignee({ kind: 'new-session' })).toBe(true);
    expect(isWorkItemAssignee({ kind: 'queue' })).toBe(false);
    expect(isWorkItemAssignee(null)).toBe(false);
  });

  it('keeps only the fields its kind uses, and keys queues by agent', () => {
    expect(normalizeAssignee({ kind: 'herdr', paneId: 'wA:p1', sessionId: 's-1' })).toEqual({
      kind: 'herdr',
      paneId: 'wA:p1',
    });
    expect(assigneeKey({ kind: 'herdr', paneId: 'wA:p1' })).toBe('herdr:wA:p1');
    expect(assigneeKey({ kind: 'session', sessionId: 's-1' })).toBe('session:s-1');
  });
});

describe('work item file parsing', () => {
  it('reads a missing file as empty and not corrupt', () => {
    expect(parseWorkItemsFile(null)).toEqual({
      file: { version: 1, revision: 0, nextSequence: 0, items: [], roles: [] },
      dropped: 0,
      corrupt: false,
    });
  });

  it('marks a file that is not an object or has another version as corrupt', () => {
    expect(parseWorkItemsFile('not json').corrupt).toBe(true);
    expect(parseWorkItemsFile({ version: 2, items: [] }).corrupt).toBe(true);
  });

  it('drops invalid and duplicate items and counts them, keeping valid ones in order', () => {
    const good = storedRaw({ sequence: 5 });
    const parsed = parseWorkItemsFile({
      version: 1,
      revision: 9,
      nextSequence: 2,
      items: [good, { ...good }, storedRaw({ status: 'exploded' }), storedRaw({ text: '  ' })],
      roles: [{ agent: { kind: 'herdr', paneId: 'wA:p1' }, description: 'x', updatedAt: AT }],
    });

    expect(parsed.corrupt).toBe(false);
    expect(parsed.dropped).toBe(3);
    expect(parsed.file.items.map((item) => item.id)).toEqual([good.id]);
    expect(parsed.file.revision).toBe(9);
    // nextSequence never falls below the highest stored sequence plus one.
    expect(parsed.file.nextSequence).toBe(6);
    expect(parsed.file.roles).toHaveLength(1);
  });

  it('drops a role note over the length limit', () => {
    const parsed = parseWorkItemsFile({
      version: 1,
      items: [],
      roles: [
        {
          agent: { kind: 'herdr', paneId: 'wA:p1' },
          description: 'x'.repeat(1001),
          updatedAt: AT,
        },
      ],
    });
    expect(parsed.file.roles).toHaveLength(0);
    expect(parsed.dropped).toBe(1);
  });
});

describe('work item wire shape', () => {
  it('never exposes the owed prompt', () => {
    const parsed = parseWorkItemsFile({ version: 1, items: [storedRaw()], roles: [] });
    const [stored] = parsed.file.items;
    expect(stored).toBeDefined();
    if (stored === undefined) return;
    expect(stored.pendingPrompt).toBe('Việc');
    expect(toWorkItem(stored)).not.toHaveProperty('pendingPrompt');
  });
});

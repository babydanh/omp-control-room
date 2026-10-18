import { describe, expect, it } from 'vitest';

import {
  buildBoardLanes,
  latestAttemptForTask,
  reviewOwnerFor,
  sentBackFor,
} from '../src/company/boardView.js';
import { COMPANY_LANE_ORDER, COMPANY_LANE_OWNERS } from '../src/company/constants.js';
import { attempt, stateFrom, task } from './companyFixtures.js';

describe('lane owners', () => {
  it('names an owner for every lane', () => {
    for (const id of COMPANY_LANE_ORDER) {
      expect(COMPANY_LANE_OWNERS[id].length).toBeGreaterThan(0);
    }
  });

  it('names QA and the Trọng tài as the review lane owners', () => {
    expect(COMPANY_LANE_OWNERS.review).toContain('QA');
    expect(COMPANY_LANE_OWNERS.review).toContain('Trọng tài');
  });

  it('gives the lanes the mockup vocabulary', () => {
    const lanes = buildBoardLanes(stateFrom());
    const labelOf = (id: string) => lanes.find((lane) => lane.id === id)?.label;
    expect(labelOf('running')).toBe('Đang làm');
    expect(labelOf('review')).toBe('Kiểm');
    expect(labelOf('needs_input')).toBe('Chờ bạn');
  });
});

describe('latestAttemptForTask', () => {
  it('returns the attempt that started last among the ones the task names', () => {
    const older = attempt({ startedAt: '2026-10-02T10:00:00.000Z' });
    const newer = attempt({ startedAt: '2026-10-02T11:00:00.000Z' });
    const stray = attempt({ startedAt: '2026-10-02T12:00:00.000Z' });
    const work = task({ attemptIds: [newer.id, older.id] });

    const state = stateFrom({ tasks: [work], attempts: [older, newer, stray] });

    expect(latestAttemptForTask(state, work)?.id).toBe(newer.id);
  });

  it('is undefined when the server has not sent any of the task attempts', () => {
    const work = task({ attemptIds: ['missing-attempt'] });
    expect(latestAttemptForTask(stateFrom({ tasks: [work] }), work)).toBeUndefined();
  });
});

describe('reviewOwnerFor', () => {
  it('leaves a review with QA until QA passes it', () => {
    expect(reviewOwnerFor(undefined)).toBe('QA');
    expect(reviewOwnerFor(attempt({ status: 'running' }))).toBe('QA');
    expect(reviewOwnerFor(attempt({ qaVerdict: { verdict: 'fail' } }))).toBe('QA');
  });

  it('hands the review to the Trọng tài once QA has passed it', () => {
    expect(reviewOwnerFor(attempt({ qaVerdict: { verdict: 'pass' } }))).toBe('Trọng tài');
  });
});

describe('sentBackFor', () => {
  it('marks a running task whose latest attempt failed verification', () => {
    expect(sentBackFor('running', attempt({ status: 'failed' }))).toBe(true);
  });

  it('does not mark a running task with a fresh attempt, or with no attempt at all', () => {
    expect(sentBackFor('running', attempt({ status: 'running' }))).toBe(false);
    expect(sentBackFor('running', undefined)).toBe(false);
  });

  it('does not mark a task that is no longer running', () => {
    expect(sentBackFor('done', attempt({ status: 'failed' }))).toBe(false);
    expect(sentBackFor('failed', attempt({ status: 'failed' }))).toBe(false);
  });
});

describe('card owners and sent-back cards', () => {
  it('shows the owner of a review card: QA before a pass, the Trọng tài after', () => {
    const qaWait = attempt({ status: 'running' });
    const judgeWait = attempt({ qaVerdict: { verdict: 'pass' } });
    const verifying = task({ code: 'PA-T0001', status: 'verifying', attemptIds: [qaWait.id] });
    const changesRequested = task({
      code: 'PA-T0002',
      status: 'changes_requested',
      attemptIds: [judgeWait.id],
    });

    const lanes = buildBoardLanes(
      stateFrom({ tasks: [verifying, changesRequested], attempts: [qaWait, judgeWait] }),
    );
    const cardOf = (code: string) =>
      lanes.flatMap((lane) => lane.cards).find((card) => card.code === code);

    expect(cardOf('PA-T0001')?.reviewOwner).toBe('QA');
    expect(cardOf('PA-T0002')?.reviewOwner).toBe('Trọng tài');
  });

  it('leaves the owner empty on cards outside the review lane', () => {
    const running = task({ code: 'PA-T0003', status: 'running' });
    const lanes = buildBoardLanes(stateFrom({ tasks: [running] }));
    expect(lanes.flatMap((lane) => lane.cards)[0]?.reviewOwner).toBeNull();
  });

  it('marks a running card as sent back only when its latest attempt failed', () => {
    const failed = attempt({ status: 'failed' });
    const repairing = task({ code: 'PA-T0004', status: 'running', attemptIds: [failed.id] });
    const fresh = task({ code: 'PA-T0005', status: 'running' });

    const lanes = buildBoardLanes(stateFrom({ tasks: [repairing, fresh], attempts: [failed] }));
    const cardOf = (code: string) =>
      lanes.flatMap((lane) => lane.cards).find((card) => card.code === code);

    expect(cardOf('PA-T0004')?.sentBack).toBe(true);
    expect(cardOf('PA-T0005')?.sentBack).toBe(false);
  });
});

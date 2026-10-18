import { describe, expect, it } from 'vitest';

import type { Task } from '../../core/src/company.js';
import {
  boardFlow,
  buildBoardLanes,
  evidenceForTask,
  planningPrompts,
} from '../src/company/boardView.js';
import { COMPANY_LANE_ORDER } from '../src/company/constants.js';
import { buildContractPlanView } from '../src/company/contractPlanView.js';
import { buildQuestionAnswers, isQuestionAnswered } from '../src/company/questionAnswers.js';
import { canSendContractApproval } from '../src/company/selection.js';
import { sessionControls } from '../src/company/sessionActions.js';
import {
  attempt,
  contract,
  criterion,
  evidence,
  phase,
  question,
  requirement,
  session,
  stateFrom,
  task,
} from './companyFixtures.js';

describe('company board lanes', () => {
  it('shows every lane, including the empty ones', () => {
    const lanes = buildBoardLanes(stateFrom());
    expect(lanes.map((lane) => lane.id)).toEqual([...COMPANY_LANE_ORDER]);
    expect(lanes.every((lane) => lane.cards.length === 0)).toBe(true);
  });

  it('shows a prompt a Director is planning until a Contract takes it over', () => {
    const director = session({ role: 'director' });
    const worker = session({ code: 'PA-S0002', role: 'worker' });
    const prompt = {
      id: '11111111-1111-4111-8111-111111111111',
      preview: 'Build the standings page',
      createdAt: '2026-10-02T00:00:00.000Z',
      attachments: [],
      targetSessionId: director.id,
    };
    const followUp = {
      ...prompt,
      id: '22222222-2222-4222-8222-222222222222',
      targetSessionId: worker.id,
    };

    const planning = stateFrom({ sessions: [director, worker], prompts: [prompt, followUp] });
    expect(planningPrompts(planning).map((entry) => entry.preview)).toEqual([
      'Build the standings page',
    ]);

    const planned = stateFrom({
      sessions: [director, worker],
      prompts: [prompt, followUp],
      contracts: [contract({ promptIds: [prompt.id] })],
    });
    expect(planningPrompts(planned)).toEqual([]);
  });

  it('puts each task in the lane its status belongs to', () => {
    const cases: [Task['status'], string][] = [
      ['planned', 'planned'],
      ['ready', 'ready'],
      ['running', 'running'],
      ['waiting_input', 'needs_input'],
      ['paused', 'needs_input'],
      ['verifying', 'review'],
      ['changes_requested', 'review'],
      ['done', 'done'],
      ['failed', 'failed'],
      ['cancelled', 'failed'],
    ];
    const state = stateFrom({
      tasks: cases.map(([status], index) => task({ code: `PA-T${index}`, status })),
    });

    const lanes = buildBoardLanes(state);
    for (const [status, laneId] of cases) {
      const card = lanes.flatMap((lane) => lane.cards).find((entry) => entry.status === status);
      expect(card?.lane).toBe(laneId);
    }
    expect(lanes.flatMap((lane) => lane.cards).length).toBe(cases.length);
  });

  it('names the session, model, phase, dependencies and routing reason on the card', () => {
    const workstream = session({ code: 'PA-S0007', role: 'worker', status: 'busy' });
    const buildPhase = phase({ title: 'Wire the board' });
    const plan = contract({ phases: [buildPhase] });
    const first = task({ code: 'PA-T0001', status: 'done', contractId: plan.id });
    const second = task({
      code: 'PA-T0002',
      status: 'running',
      contractId: plan.id,
      phaseId: buildPhase.id,
      sessionId: workstream.id,
      dependsOn: [first.id],
      routeReason: 'same workstream as PA-C0001',
    });
    plan.tasks = [first, second];

    const lanes = buildBoardLanes(
      stateFrom({ contracts: [plan], tasks: [first, second], sessions: [workstream] }),
    );
    const card = lanes.flatMap((lane) => lane.cards).find((entry) => entry.code === 'PA-T0002');

    expect(card).toMatchObject({
      contractCode: 'PA-C0001',
      phaseTitle: 'Wire the board',
      blockedByCodes: [],
      routeReason: 'same workstream as PA-C0001',
    });
    expect(card?.session).toMatchObject({ code: 'PA-S0007', role: 'worker', status: 'busy' });
  });

  it('shows what a task is still waiting on', () => {
    const dependency = task({ code: 'PA-T0001', status: 'running' });
    const dependent = task({ code: 'PA-T0002', status: 'ready', dependsOn: [dependency.id] });
    const lanes = buildBoardLanes(stateFrom({ tasks: [dependency, dependent] }));
    const card = lanes.flatMap((lane) => lane.cards).find((entry) => entry.code === 'PA-T0002');
    expect(card?.blockedByCodes).toEqual(['PA-T0001']);
  });

  it('counts evidence from the attempts that actually ran', () => {
    const passing = evidence({ exitCode: 0 });
    const failing = evidence({ exitCode: 1 });
    const taskUnderTest = task({
      attemptIds: ['attempt-a', 'attempt-b'],
    });
    const state = stateFrom({
      tasks: [taskUnderTest],
      contracts: [
        contract({
          tasks: [taskUnderTest],
          acceptance: [criterion({ id: passing.id }), criterion({ id: failing.id })],
        }),
      ],
    });
    const withAttempts = {
      ...state,
      attempts: {
        'attempt-a': attempt({ evidenceIds: [passing.id] }),
        'attempt-b': attempt({ evidenceIds: [failing.id] }),
      },
      evidence: { [passing.id]: passing, [failing.id]: failing },
    };

    expect(evidenceForTask(withAttempts, taskUnderTest).summary).toEqual({
      total: 2,
      passed: 1,
      failed: 1,
    });
  });
});

describe('contract approval', () => {
  const requirementId = 'req-1';
  const buildPhase = phase();
  const planned = task({
    code: 'PA-T0001',
    phaseId: buildPhase.id,
    requirementIds: [requirementId],
  });
  const complete = contract({
    phases: [buildPhase],
    tasks: [planned],
    requirements: [requirement({ id: requirementId })],
    acceptance: [criterion()],
  });
  planned.acceptance = [complete.acceptance[0].id];

  it('refuses to send an approval the plan cannot justify', () => {
    const view = buildContractPlanView(contract({ acceptance: [] }));
    expect(canSendContractApproval(contract({ acceptance: [] }), view)).toBe(false);
  });

  it('allows an approval for a complete plan awaiting a decision', () => {
    const view = buildContractPlanView(complete);
    expect(canSendContractApproval(complete, view)).toBe(true);
  });

  it('does not send an approval for a contract that is no longer awaiting one', () => {
    const running = { ...complete, status: 'running' as const };
    expect(canSendContractApproval(running, buildContractPlanView(running))).toBe(false);
  });
});

describe('session controls follow the reported status', () => {
  it('offers resume and restart for a parked session, never pause', () => {
    expect(sessionControls('parked')).toMatchObject({ resume: true, restart: true, pause: false });
  });

  it('distinguishes paused from parked', () => {
    expect(sessionControls('paused')).toMatchObject({ resume: true, pause: false, kill: true });
  });

  it('offers nothing for a status it does not know', () => {
    expect(sessionControls('levitating')).toEqual({
      pause: false,
      interrupt: false,
      resume: false,
      kill: false,
      restart: false,
      archive: false,
    });
  });
});

describe('question answers', () => {
  it('drops an option index the question no longer offers', () => {
    const pending = question();
    const answers = buildQuestionAnswers(pending, {
      [pending.questions[0].id]: { indices: [0, 9], text: '' },
    });
    expect(answers[pending.questions[0].id]).toEqual({
      selectedIndices: [0],
      isOther: false,
    });
  });

  it('sends typed text as an "other" answer, and nothing when it is empty', () => {
    const pending = question();
    const typed = buildQuestionAnswers(pending, {
      [pending.questions[0].id]: { indices: [], text: '  use a file  ' },
    });
    const blank = buildQuestionAnswers(pending, {
      [pending.questions[0].id]: { indices: [], text: '   ' },
    });
    expect(typed[pending.questions[0].id]).toEqual({
      selectedIndices: [],
      text: 'use a file',
      isOther: true,
    });
    expect(blank[pending.questions[0].id]).toEqual({ selectedIndices: [], isOther: false });
  });

  it('is only answered once every prompt has a selection or text', () => {
    const pending = question();
    expect(isQuestionAnswered(pending, {})).toBe(false);
    expect(
      isQuestionAnswered(pending, {
        [pending.questions[0].id]: { indices: [1], text: '' },
      }),
    ).toBe(true);
  });
});

describe('lane flow', () => {
  it('names why a card is not moving, and why that reason wins', () => {
    const dependency = task({ code: 'PA-T0001', status: 'running' });
    const blocked = task({ code: 'PA-T0002', status: 'ready', dependsOn: [dependency.id] });
    const queued = task({ code: 'PA-T0003', status: 'ready' });
    const paused = task({ code: 'PA-T0004', status: 'paused' });
    const running = task({ code: 'PA-T0005', status: 'running' });
    const waiting = task({ code: 'PA-T0006', status: 'ready', dependsOn: [dependency.id] });
    const pending = question({ taskId: waiting.id, status: 'pending' });

    const lanes = buildBoardLanes(
      stateFrom({
        tasks: [dependency, blocked, queued, paused, running, waiting],
        questions: [pending],
      }),
    );
    const reasonOf = (code: string) =>
      lanes.flatMap((lane) => lane.cards).find((card) => card.code === code)?.waitReason;

    expect(reasonOf('PA-T0002')).toBe('blocked_by_dependencies');
    expect(reasonOf('PA-T0003')).toBe('queued');
    expect(reasonOf('PA-T0004')).toBe('paused');
    expect(reasonOf('PA-T0005')).toBeNull();
    // An answer only the user can give outranks every scheduling reason.
    expect(reasonOf('PA-T0006')).toBe('awaiting_answer');
  });

  it('counts the running lane against the configured worker limit', () => {
    const running = ['PA-T0000', 'PA-T0001', 'PA-T0002', 'PA-T0003'].map((code) =>
      task({ code, status: 'running' }),
    );
    const queued = task({ code: 'PA-T0009', status: 'ready' });
    const lanes = buildBoardLanes(stateFrom({ tasks: [...running, queued] }));

    const flow = boardFlow(lanes, 4);
    expect(flow).toMatchObject({ running: 4, runningLimit: 4, ready: 1, queuedBehindWip: true });
  });

  it('does not call a queue full before the limit is reached', () => {
    const running = ['PA-T0000', 'PA-T0001', 'PA-T0002'].map((code) =>
      task({ code, status: 'running' }),
    );
    const queued = task({ code: 'PA-T0009', status: 'ready' });
    const lanes = buildBoardLanes(stateFrom({ tasks: [...running, queued] }));

    expect(boardFlow(lanes, 4)).toMatchObject({ running: 3, queuedBehindWip: false });
  });

  it('reports no worker limit before the first snapshot', () => {
    const lanes = buildBoardLanes(stateFrom({ tasks: [task({ status: 'running' })] }));
    expect(boardFlow(lanes, null)).toMatchObject({ running: 1, runningLimit: null });
  });
});

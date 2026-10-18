/**
 * The session insight the bridge reads from OMP's live session branch and task
 * tool details. The readers are pure, so the shaping rules are checked here
 * without a running OMP: the latest todo snapshot wins, an errored todo result
 * never counts, subagent statuses are derived for finished results, and free
 * text is clipped to the bridge bound.
 */

import { describe, expect, it } from 'vitest';

import {
  readBranchPlanMode,
  readBranchTodoPhases,
  readLatestTaskDetails,
  readTaskSubagents,
} from '../src/company/ompBridgeExtension.js';

function todoResult(phases: unknown, isError = false): unknown {
  return {
    type: 'message',
    message: { role: 'toolResult', toolName: 'todo', isError, details: { phases } },
  };
}

function taskResult(details: unknown): unknown {
  return { type: 'message', message: { role: 'toolResult', toolName: 'task', details } };
}

const BUILD_PHASE = {
  name: 'Build',
  tasks: [
    { content: 'Compile', status: 'completed' },
    { content: 'Ship', status: 'blocked', blocker: 'waiting on review' },
  ],
};

describe('readBranchTodoPhases', () => {
  it('returns undefined when the branch never carried a todo', () => {
    expect(readBranchTodoPhases([{ type: 'mode_change', mode: 'plan' }])).toBeUndefined();
  });

  it('uses the latest successful todo result', () => {
    const entries = [
      todoResult([{ name: 'Old', tasks: [{ content: 'x', status: 'pending' }] }]),
      todoResult([BUILD_PHASE]),
    ];
    expect(readBranchTodoPhases(entries)).toEqual([BUILD_PHASE]);
  });

  it('lets a later user edit override an earlier todo result', () => {
    const userEdit = {
      type: 'custom',
      customType: 'user_todo_edit',
      data: { phases: [{ name: 'Edited', tasks: [{ content: 'y', status: 'in_progress' }] }] },
    };
    expect(readBranchTodoPhases([todoResult([BUILD_PHASE]), userEdit])).toEqual([
      { name: 'Edited', tasks: [{ content: 'y', status: 'in_progress' }] },
    ]);
  });

  it('skips an errored todo result and keeps the snapshot before it', () => {
    const entries = [todoResult([BUILD_PHASE]), todoResult([], true)];
    expect(readBranchTodoPhases(entries)).toEqual([BUILD_PHASE]);
  });

  it('keeps an empty phase list as the current state', () => {
    expect(readBranchTodoPhases([todoResult([BUILD_PHASE]), todoResult([])])).toEqual([]);
  });

  it('drops malformed task rows and clips long text to the bridge bound', () => {
    const long = 'z'.repeat(1000);
    const phases = [
      {
        name: 'Mixed',
        tasks: [
          { content: 'kept', status: 'pending' },
          { content: 'no status' },
          { content: long, status: 'pending' },
        ],
      },
    ];
    const [phase] = readBranchTodoPhases([todoResult(phases)]) ?? [];
    expect(phase?.tasks.map((task) => task.content.length)).toEqual([4, 400]);
  });
});

describe('readBranchPlanMode', () => {
  it('reads the latest mode change and defaults to none', () => {
    expect(readBranchPlanMode([])).toBe('none');
    expect(
      readBranchPlanMode([
        { type: 'mode_change', mode: 'plan' },
        { type: 'mode_change', mode: 'none' },
      ]),
    ).toBe('none');
    expect(readBranchPlanMode([{ type: 'mode_change', mode: 'plan' }])).toBe('plan');
  });
});

describe('readLatestTaskDetails', () => {
  it('returns the details of the latest task result', () => {
    const older = { progress: [] };
    const newer = { progress: [{ id: 'A' }] };
    expect(readLatestTaskDetails([taskResult(older), taskResult(newer)])).toBe(newer);
  });
});

describe('readTaskSubagents', () => {
  it('maps live progress rows and drops rows without the required fields', () => {
    const details = {
      progress: [
        {
          id: 'AuthReviewer',
          agent: 'reviewer',
          status: 'running',
          task: 'Check auth',
          currentTool: 'read',
          tokens: 1200,
          contextTokens: 800,
          contextWindow: 200000,
          cost: 0.04,
          durationMs: 9000,
          completionPercent: 40,
        },
        { id: 'broken', agent: 'reviewer', status: 'running', durationMs: 1 },
      ],
    };
    expect(readTaskSubagents(details)).toEqual([
      {
        id: 'AuthReviewer',
        agent: 'reviewer',
        status: 'running',
        task: 'Check auth',
        currentTool: 'read',
        tokens: 1200,
        contextTokens: 800,
        contextWindow: 200000,
        costUsd: 0.04,
        durationMs: 9000,
        completionPercent: 40,
      },
    ]);
  });

  it('derives the status of finished results from their exit', () => {
    const details = {
      results: [
        {
          id: 'R1',
          agent: 'explore',
          task: 'Map files',
          tokens: 300,
          durationMs: 4000,
          exitCode: 0,
        },
        {
          id: 'R2',
          agent: 'explore',
          task: 'Map tests',
          tokens: 50,
          durationMs: 1000,
          exitCode: 1,
        },
        {
          id: 'R3',
          agent: 'explore',
          task: 'Map docs',
          tokens: 5,
          durationMs: 100,
          exitCode: 0,
          aborted: true,
        },
      ],
    };
    expect(readTaskSubagents(details).map((row) => [row.id, row.status])).toEqual([
      ['R1', 'completed'],
      ['R2', 'failed'],
      ['R3', 'aborted'],
    ]);
  });

  it('returns no rows for details that carry neither progress nor results', () => {
    expect(readTaskSubagents(undefined)).toEqual([]);
    expect(readTaskSubagents({})).toEqual([]);
  });
});

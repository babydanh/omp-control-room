/**
 * Host-side validation of the session insight the bridge pushes. The bridge is
 * trusted only as far as its frame shape, so these cases pin what reaches the
 * company state: a plan mode is required, malformed rows are dropped, statuses
 * must be known, and every field stays inside the contract bounds.
 */

import { describe, expect, it } from 'vitest';

import { parseSessionInsight } from '../src/company/sessionInsight.js';

const OBSERVED_AT = '2026-05-01T10:00:00.000Z';

describe('parseSessionInsight', () => {
  it('rejects a frame without a plan mode', () => {
    expect(parseSessionInsight({ subagents: [] }, OBSERVED_AT)).toBeUndefined();
  });

  it('keeps a valid todo, plan mode and subagent row, stamped with the observation time', () => {
    const insight = parseSessionInsight(
      {
        k: 'insight',
        todo: {
          phases: [
            {
              name: 'Build',
              tasks: [
                { content: 'Compile', status: 'completed' },
                { content: 'Ship', status: 'blocked', blocker: 'waiting' },
              ],
            },
          ],
        },
        planMode: 'plan',
        subagents: [
          {
            id: 'A',
            agent: 'reviewer',
            status: 'running',
            tokens: 10,
            durationMs: 5,
            costUsd: 0.1,
          },
        ],
      },
      OBSERVED_AT,
    );
    expect(insight).toEqual({
      observedAt: OBSERVED_AT,
      todo: {
        phases: [
          {
            name: 'Build',
            tasks: [
              { content: 'Compile', status: 'completed' },
              { content: 'Ship', status: 'blocked', blocker: 'waiting' },
            ],
          },
        ],
      },
      planMode: 'plan',
      subagents: [
        { id: 'A', agent: 'reviewer', status: 'running', tokens: 10, durationMs: 5, costUsd: 0.1 },
      ],
    });
  });

  it('omits todo when the frame carries none', () => {
    const insight = parseSessionInsight({ planMode: 'none', subagents: [] }, OBSERVED_AT);
    expect(insight).toEqual({ observedAt: OBSERVED_AT, planMode: 'none', subagents: [] });
  });

  it('drops task rows with an unknown status and subagent rows with an unknown status', () => {
    const insight = parseSessionInsight(
      {
        planMode: 'none',
        todo: {
          phases: [
            {
              name: 'Mixed',
              tasks: [
                { content: 'good', status: 'pending' },
                { content: 'bad', status: 'paused' },
              ],
            },
          ],
        },
        subagents: [
          { id: 'ok', agent: 'a', status: 'failed', tokens: 1, durationMs: 1 },
          { id: 'bad', agent: 'a', status: 'paused', tokens: 1, durationMs: 1 },
        ],
      },
      OBSERVED_AT,
    );
    expect(insight?.todo?.phases[0]?.tasks).toEqual([{ content: 'good', status: 'pending' }]);
    expect(insight?.subagents.map((row) => row.id)).toEqual(['ok']);
  });

  it('bounds phases, tasks, subagents and text to the contract limits', () => {
    const long = 'x'.repeat(900);
    const phases = Array.from({ length: 60 }, (_, index) => ({
      name: `Phase ${index}`,
      tasks: Array.from({ length: 210 }, () => ({ content: long, status: 'pending' })),
    }));
    const subagents = Array.from({ length: 50 }, (_, index) => ({
      id: `S${index}`,
      agent: long,
      status: 'running',
      tokens: 1,
      durationMs: 1,
      completionPercent: 250,
    }));
    const insight = parseSessionInsight(
      { planMode: long, todo: { phases }, subagents },
      OBSERVED_AT,
    );
    expect(insight?.planMode.length).toBe(64);
    expect(insight?.todo?.phases).toHaveLength(50);
    expect(insight?.todo?.phases[0]?.tasks).toHaveLength(200);
    expect(insight?.todo?.phases[0]?.tasks[0]?.content.length).toBe(400);
    expect(insight?.subagents).toHaveLength(40);
    expect(insight?.subagents[0]?.agent.length).toBe(80);
    // A percentage above 100 is malformed and is dropped, not clamped.
    expect(insight?.subagents[0]?.completionPercent).toBeUndefined();
  });

  it('rejects negative and non-finite counts on a subagent row', () => {
    const insight = parseSessionInsight(
      {
        planMode: 'none',
        subagents: [
          { id: 'neg', agent: 'a', status: 'running', tokens: -1, durationMs: 1 },
          { id: 'inf', agent: 'a', status: 'running', tokens: 1, durationMs: Number.NaN },
          { id: 'ok', agent: 'a', status: 'running', tokens: 0, durationMs: 0 },
        ],
      },
      OBSERVED_AT,
    );
    expect(insight?.subagents.map((row) => row.id)).toEqual(['ok']);
  });
});

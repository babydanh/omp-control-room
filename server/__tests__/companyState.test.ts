import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { CompanyChange, CompanyEvent } from '../../core/src/company.js';
import { applyCompanyEvent, createInitialCompanyState } from '../src/company/companyState.js';

function countersEvent(sequence: number, baseRevision: number, sessionCount: number): CompanyEvent {
  const change: CompanyChange = {
    entity: 'counters',
    op: 'put',
    id: 'counters',
    value: { session: sessionCount, task: 0, contract: 0 },
  };
  return {
    id: randomUUID(),
    sequence,
    at: new Date().toISOString(),
    baseRevision,
    changes: [change],
  };
}

describe('company state', () => {
  it('starts with the approved resource bounds and monotonic counters', () => {
    const state = createInitialCompanyState('C:/workspace');

    expect(state.schemaVersion).toBe(1);
    expect(state.revision).toBe(0);
    expect(state.counters).toEqual({ session: 0, task: 0, contract: 0 });
    expect(state.settings).toMatchObject({
      maxRetainedSessions: 10,
      maxLiveRunners: 4,
      maxConcurrentModelCalls: 4,
      maxWorkers: 4,
      idleParkSeconds: 120,
    });
  });

  it('applies an event only at its base revision and advances the durable sequence', () => {
    const initial = createInitialCompanyState('C:/workspace');
    const updated = applyCompanyEvent(initial, countersEvent(1, 0, 1));

    expect(updated.revision).toBe(1);
    expect(updated.counters.session).toBe(1);
    expect(() => applyCompanyEvent(updated, countersEvent(2, 0, 2))).toThrowError(
      expect.objectContaining({ code: 'company_revision_conflict' }),
    );
  });
});

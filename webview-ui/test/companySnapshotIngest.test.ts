import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { CompanySnapshot } from '../../core/src/messages.js';
import type { CompanyViewState } from '../src/company/companyState.js';
import { applyCompanyMessage, usageKey } from '../src/company/companyState.js';
import { attempt, evidence, report, snapshot, stateFrom, usageRecord } from './companyFixtures.js';

function ingest(state: CompanyViewState, overrides: Partial<CompanySnapshot>): CompanyViewState {
  return applyCompanyMessage(state, {
    type: 'companySnapshot',
    requestId: randomUUID(),
    snapshot: snapshot(overrides),
  }).state;
}

describe('snapshot ingest of optional collections', () => {
  it('replaces the held attempts with a present collection', () => {
    const old = attempt();
    const fresh = attempt();
    const base = stateFrom({ attempts: [old] });

    const next = ingest(base, { revision: 2, attempts: [fresh] });

    expect(Object.keys(next.attempts)).toEqual([fresh.id]);
  });

  it('keeps the held attempts when the snapshot does not carry them', () => {
    const held = attempt();
    const base = stateFrom({ attempts: [held] });

    const next = ingest(base, { revision: 2 });

    expect(Object.keys(next.attempts)).toEqual([held.id]);
  });

  it('treats an empty collection as present, so it clears the held one', () => {
    const base = stateFrom({ attempts: [attempt()] });

    const next = ingest(base, { revision: 2, attempts: [] });

    expect(Object.keys(next.attempts)).toEqual([]);
  });

  it('applies the same rule to evidence', () => {
    const proof = evidence();
    const base = stateFrom({ evidence: [proof] });

    expect(Object.keys(ingest(base, { revision: 2 }).evidence)).toEqual([proof.id]);
    expect(Object.keys(ingest(base, { revision: 2, evidence: [] }).evidence)).toEqual([]);
  });

  it('keys reports by their contract, the way a report put is keyed', () => {
    const first = report();
    const second = report();

    const next = ingest(stateFrom(), {
      revision: 2,
      reports: [first, second],
    });

    expect(Object.keys(next.reports).sort()).toEqual([first.contractId, second.contractId].sort());
    expect(next.reports[first.contractId]?.revision).toBe(first.revision);
  });

  it('keeps held reports when the snapshot does not carry them', () => {
    const held = report();
    const base = stateFrom({ reports: [held] });

    expect(Object.keys(ingest(base, { revision: 2 }).reports)).toEqual([held.contractId]);
  });

  it('keys usage by its native entry, so a rescan does not double-count spend', () => {
    const first = usageRecord({ nativeEntryId: 'entry-1' });
    const second = usageRecord({ nativeEntryId: 'entry-2' });
    const rescanned = usageRecord({ nativeEntryId: 'entry-1' });

    const next = ingest(stateFrom(), {
      revision: 2,
      usage: [first, second, rescanned],
    });

    expect(Object.keys(next.usage)).toHaveLength(2);
    expect(next.usage[usageKey(first)]).toBeDefined();
  });

  it('keeps held usage when the snapshot does not carry it', () => {
    const held = usageRecord();
    const base = stateFrom({ usage: [held] });

    expect(Object.keys(ingest(base, { revision: 2 }).usage)).toEqual([usageKey(held)]);
  });

  it('keys a usage record as native session and native entry', () => {
    expect(usageKey(usageRecord())).toBe('native-1:entry-1');
  });
});

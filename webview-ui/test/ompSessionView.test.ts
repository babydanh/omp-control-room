import { describe, expect, it } from 'vitest';

import {
  buildOmpSessionForest,
  buildOmpSessionRows,
  describeOmpStatus,
  flattenOmpSessionForest,
  formatOmpTimestamp,
  OMP_SESSION_STATUS_UNOBSERVED,
  OMP_SESSION_STATUSES,
  type OmpSessionRecord,
} from '../src/company/ompSessionView.js';

/**
 * Field shapes copied from `@oh-my-pi/pi-coding-agent` v18.4.9:
 * `src/session/session-listing.ts:17-39` for the full `SessionInfo` and
 * `src/modes/acp/acp-agent.ts:2044-2055` for `#toSessionInfo`, the projection
 * that drops `status`, `created` and `parentSessionPath`. `acpRecord` is a
 * record shaped like one that arrived over that surface; `fullRecord` is one
 * shaped like the in-process listing.
 */
function fullRecord(overrides: Partial<OmpSessionRecord> = {}): OmpSessionRecord {
  return {
    id: 'ses_a',
    path: '/root/.omp/agent/sessions/proj/ses_a.jsonl',
    cwd: 'C:/repo',
    title: 'Refactor the parser',
    created: '2026-09-30T08:00:00.000Z',
    modified: '2026-09-30T09:30:00.000Z',
    messageCount: 42,
    status: 'complete',
    ...overrides,
  };
}

function acpRecord(overrides: Partial<OmpSessionRecord> = {}): OmpSessionRecord {
  return {
    id: 'ses_b',
    cwd: 'C:/repo',
    title: 'From the ACP surface',
    modified: '2026-09-30T09:31:00.000Z',
    messageCount: 7,
    ...overrides,
  };
}

describe('status is only ever what OMP reported', () => {
  it('passes every OMP status through unchanged', () => {
    for (const status of OMP_SESSION_STATUSES) {
      const [row] = buildOmpSessionRows([fullRecord({ status })]);
      expect(row.status).toBe(status);
      expect(row.statusObserved).toBe(true);
      expect(describeOmpStatus(status)).toMatchObject({ status, observed: true });
    }
  });

  // The case most likely to regress into a silent guess.
  it('renders an absent status as unknown, never as a neighbour', () => {
    const [omitted, nulled, blank] = buildOmpSessionRows([
      acpRecord({ id: 'a', status: undefined }),
      acpRecord({ id: 'b', status: null }),
      acpRecord({ id: 'c', status: undefined }),
    ]);

    for (const row of [omitted!, nulled!, blank!]) {
      expect(row.status).toBe(OMP_SESSION_STATUS_UNOBSERVED);
      expect(row.statusObserved).toBe(false);
    }
    // Feeding the collapse back in yields the same word, so a re-render that
    // re-normalizes an already-normalized row cannot invent provenance.
    expect(describeOmpStatus(undefined)).toMatchObject({ status: 'unknown', observed: false });
    expect(describeOmpStatus(null)).toMatchObject({ status: 'unknown', observed: false });
    expect(describeOmpStatus('unknown')).toMatchObject({ status: 'unknown', observed: true });
  });

  it('distinguishes "OMP said unknown" from "OMP said nothing"', () => {
    const [saidUnknown] = buildOmpSessionRows([fullRecord({ status: 'unknown' })]);
    const [saidNothing] = buildOmpSessionRows([acpRecord()]);

    expect(saidUnknown).toMatchObject({ status: 'unknown', statusObserved: true });
    expect(saidNothing).toMatchObject({ status: 'unknown', statusObserved: false });
    // Same rendered word, different provenance -- the reader must not be able
    // to tell these apart by accident.
    expect(saidUnknown.status).toBe(saidNothing.status);
    expect(saidUnknown.statusObserved).not.toBe(saidNothing.statusObserved);
  });

  it('collapses a status it does not recognise instead of rendering it', () => {
    const described = describeOmpStatus('running' as never);
    expect(described.status).toBe('unknown');
    expect(described.observed).toBe(false);
  });

  it('gives every status a basis in OMP terms, and the collapsed one admits it', () => {
    const reported = OMP_SESSION_STATUSES.map((status) => describeOmpStatus(status).basis);
    for (const basis of reported) {
      expect(basis.length).toBeGreaterThan(0);
    }
    // The collapse has to explain ITSELF rather than inherit the reading of a
    // status OMP never reported, so its basis is a sentence of its own. This
    // is asserted by distinctness rather than by wording: the panel draws
    // these in the user's language, and pinning the phrase would make a
    // translation look like a behaviour change.
    const collapsed = describeOmpStatus(null).basis;
    expect(collapsed.length).toBeGreaterThan(0);
    expect(reported).not.toContain(collapsed);
  });
});

describe('the view adds no field OMP does not have', () => {
  it('exposes exactly the projected fields, and no liveness', () => {
    const [row] = buildOmpSessionRows([fullRecord()]);
    expect(Object.keys(row!).sort()).toEqual([
      'created',
      'cwd',
      'depth',
      'id',
      'messageCount',
      'modified',
      'parentId',
      'parentReferenced',
      'status',
      'statusObserved',
      'title',
    ]);
    // OMP's `SessionInfo` carries no pid, heartbeat or start time, so no claim
    // about a running process can be sourced from it.
    expect(Object.keys(row!).some((key) => /running|alive|live|pid|heartbeat|busy/i.test(key))).toBe(
      false,
    );
  });

  it('gives a just-modified session the same status as an abandoned one', () => {
    const [fresh] = buildOmpSessionRows([fullRecord({ id: 'fresh', modified: new Date().toISOString() })]);
    const [stale] = buildOmpSessionRows([fullRecord({ id: 'stale', modified: '2020-01-01T00:00:00.000Z' })]);

    expect(fresh!.status).toBe(stale!.status);
    expect(fresh!.statusObserved).toBe(stale!.statusObserved);
  });
});

describe('absent fields stay absent', () => {
  it('reads an ACP-shaped record without inventing what it dropped', () => {
    const [row] = buildOmpSessionRows([acpRecord()]);
    expect(row).toMatchObject({
      id: 'ses_b',
      cwd: 'C:/repo',
      title: 'From the ACP surface',
      created: null,
      messageCount: 7,
      parentId: null,
      parentReferenced: false,
      status: 'unknown',
      statusObserved: false,
    });
  });

  it('treats an empty cwd as unreported -- OMP writes "" for old sessions', () => {
    const [row] = buildOmpSessionRows([fullRecord({ cwd: '' })]);
    expect(row!.cwd).toBeNull();
  });

  it('does not accept a non-finite message count', () => {
    const [row] = buildOmpSessionRows([fullRecord({ messageCount: Number.NaN })]);
    expect(row!.messageCount).toBeNull();
  });

  it('handles an empty listing', () => {
    expect(buildOmpSessionRows([])).toEqual([]);
    expect(buildOmpSessionForest([])).toEqual([]);
    expect(flattenOmpSessionForest([])).toEqual([]);
  });
});

describe('parent linkage', () => {
  it('nests a child under the parent that recorded it', () => {
    const parentRecord = fullRecord({ id: 'p', path: '/s/p.jsonl' });
    const childRecord = fullRecord({
      id: 'c',
      path: '/s/c.jsonl',
      parentSessionPath: '/s/p.jsonl',
      title: 'Forked work',
    });

    const rows = buildOmpSessionRows([parentRecord, childRecord]);
    expect(rows.find((row) => row.id === 'c')).toMatchObject({
      parentId: 'p',
      parentReferenced: true,
      depth: 1,
    });
    expect(rows.find((row) => row.id === 'p')).toMatchObject({ parentId: null, depth: 0 });

    expect(
      flattenOmpSessionForest(buildOmpSessionForest([parentRecord, childRecord])).map((r) => r.id),
    ).toEqual(['p', 'c']);
  });

  it('nests a grandchild two levels deep', () => {
    const tree = flattenOmpSessionForest(
      buildOmpSessionForest([
        fullRecord({ id: 'a', path: '/s/a.jsonl' }),
        fullRecord({ id: 'b', path: '/s/b.jsonl', parentSessionPath: '/s/a.jsonl' }),
        fullRecord({ id: 'c', path: '/s/c.jsonl', parentSessionPath: '/s/b.jsonl' }),
      ]),
    );
    expect(tree.map((row) => [row.id, row.depth])).toEqual([
      ['a', 0],
      ['b', 1],
      ['c', 2],
    ]);
  });

  it('shows a session whose parent is outside the listing, and says so', () => {
    const orphan = fullRecord({ id: 'c', parentSessionPath: '/elsewhere/p.jsonl' });
    expect(buildOmpSessionRows([orphan])[0]).toMatchObject({
      parentId: null,
      parentReferenced: true,
      depth: 0,
    });
    // Still listed. Hiding it would be as much of a guess as calling it a root.
    expect(flattenOmpSessionForest(buildOmpSessionForest([orphan])).map((r) => r.id)).toEqual(['c']);
  });

  it('never parents a session to itself', () => {
    const [self] = buildOmpSessionRows([fullRecord({ path: '/s/a.jsonl', parentSessionPath: '/s/a.jsonl' })]);
    expect(self).toMatchObject({ parentId: null, parentReferenced: true, depth: 0 });
  });

  it('terminates on a parent cycle and still shows both sessions', () => {
    const cyclic = [
      fullRecord({ id: 'a', path: '/s/a.jsonl', parentSessionPath: '/s/b.jsonl' }),
      fullRecord({ id: 'b', path: '/s/b.jsonl', parentSessionPath: '/s/a.jsonl' }),
    ];
    expect(flattenOmpSessionForest(buildOmpSessionForest(cyclic)).map((r) => r.id).sort()).toEqual([
      'a',
      'b',
    ]);
    // Depths inside a cycle are arbitrary by construction; only termination
    // and visibility are guaranteed.
    expect(buildOmpSessionRows(cyclic).every((row) => Number.isInteger(row.depth))).toBe(true);
  });

  it('keeps the first record for a duplicated path', () => {
    const rows = buildOmpSessionRows([
      fullRecord({ id: 'first', path: '/s/dup.jsonl' }),
      fullRecord({ id: 'second', path: '/s/dup.jsonl' }),
      fullRecord({ id: 'child', path: '/s/child.jsonl', parentSessionPath: '/s/dup.jsonl' }),
    ]);
    expect(rows.find((row) => row.id === 'child')!.parentId).toBe('first');
  });
});

describe('timestamps are absolute or untouched', () => {
  it('renders a parseable timestamp as absolute UTC to the minute', () => {
    expect(formatOmpTimestamp('2026-09-30T09:30:00.000Z')).toBe('2026-09-30T09:30Z');
    expect(formatOmpTimestamp('2026-09-30T11:30:00.000+02:00')).toBe('2026-09-30T09:30Z');
  });

  it('never produces a relative label', () => {
    const rendered = formatOmpTimestamp(new Date().toISOString());
    expect(rendered).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z$/);
    expect(rendered).not.toMatch(/ago|now/i);
  });

  it('passes an unparseable value through instead of rounding it', () => {
    expect(formatOmpTimestamp('last tuesday')).toBe('last tuesday');
    expect(formatOmpTimestamp(null)).toBeNull();
  });
});
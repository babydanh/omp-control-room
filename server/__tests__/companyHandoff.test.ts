import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type {
  Attempt,
  CompanySession,
  Contract,
  RelatedWorkspaceFile,
  Requirement,
  Task,
  VerificationEvidence,
} from '../../core/src/company.js';
import {
  buildSessionHandoff,
  HANDOFF_LIMITS,
  HANDOFF_MAX_BYTES,
  handoffByteLength,
  type HandoffInput,
  renderHandoffText,
} from '../src/company/handoff.js';

const GENERATED_AT = '2026-01-02T03:04:05.000Z';

function session(overrides: Partial<CompanySession> = {}): CompanySession {
  return {
    id: randomUUID(),
    code: 'PA-S0001',
    name: 'worker alpha',
    role: 'worker',
    workstreamId: 'ws-api',
    workspaceKey: 'ws',
    requestedModel: 'openai-codex/gpt-6-luna:xhigh',
    effectiveModel: 'openai-codex/gpt-6-luna:xhigh',
    nativeSessionId: 'native-abc',
    nativeSessionPath: '/company/sessions/native-abc.jsonl',
    runEpoch: 5,
    status: 'idle',
    lastUsedAt: '2026-01-02T02:00:00.000Z',
    ...overrides,
  } as CompanySession;
}

function contract(overrides: Partial<Contract> = {}): Contract {
  return {
    id: randomUUID(),
    code: 'PA-C0001',
    revision: 4,
    promptIds: [],
    requirements: [],
    phases: [],
    tasks: [],
    assumptions: [],
    decisions: [],
    acceptance: [],
    status: 'running',
    ...overrides,
  } as Contract;
}

function requirement(id: string, text: string): Requirement {
  return {
    id,
    promptId: randomUUID(),
    fragmentIds: [],
    text,
    kind: 'goal',
    status: 'planned',
  } as Requirement;
}

function evidence(id: string, endedAt: string, exitCode: number): VerificationEvidence {
  return {
    id,
    command: {
      id: randomUUID(),
      executable: 'npm',
      argv: ['run', 'test', '--', '--runInBand'],
      cwd: 'backend',
      timeoutSeconds: 600,
    },
    startedAt: '2026-01-02T01:00:00.000Z',
    endedAt,
    exitCode,
    stdoutArtifactId: randomUUID(),
    stderrArtifactId: randomUUID(),
    criterionIds: ['crit-1'],
  } as VerificationEvidence;
}

function failedAttempt(taskId: string, error: string): Attempt {
  return {
    id: randomUUID(),
    taskId,
    sessionId: randomUUID(),
    runEpoch: 5,
    startedAt: '2026-01-02T01:00:00.000Z',
    endedAt: '2026-01-02T01:10:00.000Z',
    status: 'failed',
    changes: [],
    evidenceIds: ['ev-1'],
    error,
  } as Attempt;
}

function input(overrides: Partial<HandoffInput> = {}): HandoffInput {
  return {
    session: session(),
    contract: contract(),
    requirements: [requirement('req-1', 'The standings API must recompute totals.')],
    tasks: [],
    decisions: [],
    evidence: [],
    attempts: [],
    refs: [],
    nextAction: 'Run the backend suite and report the result.',
    nativeEntryId: 'entry-42',
    generatedAt: GENERATED_AT,
    ...overrides,
  };
}

describe('handoff content', () => {
  it('carries the Contract revision and provenance of the session it came from', () => {
    const handoff = buildSessionHandoff(input());

    expect(handoff.contract).toEqual({ id: handoff.contract?.id, code: 'PA-C0001', revision: 4 });
    expect(handoff.source).toMatchObject({
      sessionCode: 'PA-S0001',
      role: 'worker',
      workstreamId: 'ws-api',
      runEpoch: 5,
      nativeSessionId: 'native-abc',
      nativeEntryId: 'entry-42',
    });
  });

  it('carries requirements, file refs, decisions and the next action', () => {
    const refs: RelatedWorkspaceFile[] = [
      { path: 'backend/src/standings.service.ts', relation: 'source', reason: 'recomputes totals' },
      { path: 'backend/test/standings.spec.ts', relation: 'test' },
    ];
    const handoff = buildSessionHandoff(
      input({
        requirements: [requirement('req-1', 'The standings API must recompute totals.')],
        refs,
        decisions: ['Totals are recomputed on read, never cached.'],
        nextAction: 'Fix the tie-break in the standings comparator.',
      }),
    );

    expect(handoff.requirements[0]).toMatchObject({ id: 'req-1', kind: 'goal' });
    expect(handoff.refs.map((ref) => ref.path)).toEqual([
      'backend/src/standings.service.ts',
      'backend/test/standings.spec.ts',
    ]);
    expect(handoff.decisions).toEqual(['Totals are recomputed on read, never cached.']);
    expect(handoff.nextAction).toBe('Fix the tie-break in the standings comparator.');
  });

  it('leads with the newest verification and keeps the failure that caused it', () => {
    const older = evidence('ev-old', '2026-01-02T01:00:00.000Z', 0);
    const newer = evidence('ev-new', '2026-01-02T02:00:00.000Z', 1);
    const taskId = randomUUID();
    const handoff = buildSessionHandoff(
      input({
        evidence: [older, newer],
        attempts: [failedAttempt(taskId, 'jest exited 1: expected 3 received 2')],
        tasks: [
          {
            id: taskId,
            code: 'PA-T0004',
            title: 'Standings comparator',
          } as Task,
        ],
      }),
    );

    expect(handoff.evidence.map((record) => record.id)).toEqual(['ev-new', 'ev-old']);
    expect(handoff.evidence[0]).toMatchObject({
      command: 'npm run test -- --runInBand',
      cwd: 'backend',
      exitCode: 1,
      passed: false,
    });
    expect(handoff.failures).toEqual([
      {
        attemptId: expect.any(String),
        taskCode: 'PA-T0004',
        error: 'jest exited 1: expected 3 received 2',
        evidenceIds: ['ev-1'],
        endedAt: '2026-01-02T01:10:00.000Z',
      },
    ]);
  });

  it('references captured output by artifact id instead of carrying the bytes', () => {
    const record = evidence('ev-1', '2026-01-02T02:00:00.000Z', 0);
    const handoff = buildSessionHandoff(input({ evidence: [record] }));

    expect(handoff.evidence[0].stdoutArtifactId).toBe(record.stdoutArtifactId);
    expect(
      Object.keys(handoff.evidence[0]).filter((key) => key === 'stdout' || key === 'stderr'),
    ).toEqual([]);
  });

  it('excludes the session context snapshot, which is where a transcript would ride', () => {
    const transcript = 'x'.repeat(200_000);
    const handoff = buildSessionHandoff(
      input({ session: session({ contextSnapshot: { transcript } }) }),
    );

    expect(JSON.stringify(handoff)).not.toContain(transcript.slice(0, 64));
  });
});

describe('handoff bounds', () => {
  it('caps every list and reports what it dropped', () => {
    const requirements = Array.from({ length: HANDOFF_LIMITS.requirements + 5 }, (_, index) =>
      requirement(`req-${index}`, `requirement ${index}`),
    );
    const decisions = Array.from(
      { length: HANDOFF_LIMITS.decisions + 3 },
      (_, index) => `decision ${index}`,
    );
    const records = Array.from({ length: HANDOFF_LIMITS.evidence + 2 }, (_, index) =>
      evidence(`ev-${index}`, `2026-01-02T0${index}:00:00.000Z`, 0),
    );

    const handoff = buildSessionHandoff(input({ requirements, decisions, evidence: records }));

    expect(handoff.requirements).toHaveLength(HANDOFF_LIMITS.requirements);
    expect(handoff.decisions).toHaveLength(HANDOFF_LIMITS.decisions);
    expect(handoff.evidence).toHaveLength(HANDOFF_LIMITS.evidence);
    expect(handoff.truncated).toEqual({
      requirements: 5,
      tasks: 0,
      refs: 0,
      decisions: 3,
      evidence: 2,
      failures: 0,
    });
  });

  it('truncates long text without splitting a grapheme', () => {
    const long = '👩‍💻'.repeat(HANDOFF_LIMITS.text + 200);
    const handoff = buildSessionHandoff(
      input({ requirements: [requirement('req-1', long)], nextAction: long }),
    );

    const text = handoff.requirements[0].text;
    expect(text.length).toBeLessThan(long.length);
    expect(text.endsWith('…')).toBe(true);
    expect([
      ...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text),
    ]).toHaveLength(HANDOFF_LIMITS.text + 1);
    expect(handoffByteLength(handoff)).toBeLessThan(HANDOFF_MAX_BYTES);
  });

  it('does not mark wide text as cut when it fits the grapheme limit', () => {
    // 501 graphemes of a ZWJ sequence: over the UTF-16 budget, under the
    // grapheme budget. Nothing was dropped, so nothing may claim it was.
    const wide = '👩‍💻'.repeat(HANDOFF_LIMITS.text - 99) + 'tail';
    expect(wide.length).toBeGreaterThan(HANDOFF_LIMITS.text);

    const handoff = buildSessionHandoff(input({ requirements: [requirement('req-1', wide)] }));

    expect(handoff.requirements[0].text).toBe(wide);
  });

  it('refuses a packet whose structured scopes cannot fit, rather than truncating permissions', () => {
    const oversized: Task[] = Array.from(
      { length: HANDOFF_LIMITS.tasks },
      () =>
        ({
          id: randomUUID(),
          code: 'PA-T0001',
          title: 'bulk',
          status: 'planned',
          requirementIds: [],
          writeScopes: Array.from({ length: 400 }, (_, index) => ({
            path: `backend/src/generated/module-${index}/${'segment-'.repeat(20)}.ts`,
            kind: 'file',
            operations: ['modify'],
          })),
        }) as unknown as Task,
    );

    expect(() => buildSessionHandoff(input({ tasks: oversized }))).toThrowError(
      expect.objectContaining({ code: 'company_handoff_too_large' }),
    );
  });
});

describe('handoff rendering', () => {
  it('renders a deterministic block the next session can be sent verbatim', () => {
    const handoff = buildSessionHandoff(
      input({
        decisions: ['Totals are recomputed on read.'],
        evidence: [evidence('ev-1', '2026-01-02T02:00:00.000Z', 1)],
        nextAction: 'Fix the tie-break.',
      }),
    );

    const text = renderHandoffText(handoff);

    expect(text).toBe(renderHandoffText(handoff));
    expect(text).toContain('Handoff from PA-S0001 (worker)');
    expect(text).toContain('Contract PA-C0001 revision 4');
    expect(text).toContain('Read up to entry: entry-42');
    expect(text).toContain('npm run test -- --runInBand [failed (1)]');
    expect(text).toContain('Next action: Fix the tie-break.');
  });

  it('tells the reader what was omitted instead of implying it was complete', () => {
    const handoff = buildSessionHandoff(
      input({
        requirements: Array.from({ length: HANDOFF_LIMITS.requirements + 2 }, (_, index) =>
          requirement(`req-${index}`, `requirement ${index}`),
        ),
      }),
    );

    expect(renderHandoffText(handoff)).toContain('Omitted for length: 2 requirements');
  });
});

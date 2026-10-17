import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { CompanyRole, CompanySession, Question } from '../../core/src/company.js';
import {
  DEFAULT_POOL_LIMITS,
  sessionHoldsRunner,
  SessionPool,
} from '../src/company/sessionPool.js';

const T0 = Date.parse('2026-01-01T00:00:00.000Z');
const IDLE_MS = DEFAULT_POOL_LIMITS.idleParkSeconds * 1000;

let clock = T0;

function at(offsetMs: number): string {
  return new Date(T0 + offsetMs).toISOString();
}

function session(overrides: Partial<CompanySession> = {}): CompanySession {
  return {
    id: randomUUID(),
    code: 'PA-S0001',
    name: 'worker alpha',
    role: 'worker' as CompanyRole,
    workstreamId: randomUUID(),
    workspaceKey: 'ws',
    requestedModel: 'openai-codex/gpt-6-luna:xhigh',
    runEpoch: 3,
    status: 'idle',
    lastUsedAt: at(0),
    ...overrides,
  } as CompanySession;
}

function question(sessionId: string): Question {
  return {
    id: randomUUID(),
    sessionId,
    runEpoch: 1,
    kind: 'approval',
    title: 'Approve the lockfile update?',
    questions: [],
    status: 'pending',
    createdAt: at(0),
  } as Question;
}

function pool(limits?: Partial<typeof DEFAULT_POOL_LIMITS>) {
  return new SessionPool({ now: () => clock, ...(limits ? { limits } : {}) });
}

/** A pool holding `count` idle worker sessions, oldest first. */
function poolWithIdle(count: number, limits?: Partial<typeof DEFAULT_POOL_LIMITS>) {
  const sessions = Array.from({ length: count }, (_, index) =>
    session({ code: `PA-S${String(index + 1).padStart(4, '0')}`, lastUsedAt: at(index * 1000) }),
  );
  const instance = pool(limits);
  for (const entry of sessions) instance.upsert(entry);
  return { instance, sessions };
}

describe('retained session bound', () => {
  it('allocates while the pool is below the retained limit', () => {
    const { instance } = poolWithIdle(3);

    const decision = instance.plan({
      role: 'worker',
      workstreamId: randomUUID(),
      requestedModel: 'openai-codex/gpt-6-luna:xhigh',
    });

    expect(decision.kind).toBe('allocate');
  });

  it('reuses an idle session of the same workstream without restarting it', () => {
    const instance = pool();
    const workstreamId = randomUUID();
    instance.upsert(session({ workstreamId, status: 'idle', runEpoch: 4 }));

    const decision = instance.plan({
      role: 'worker',
      workstreamId,
      requestedModel: 'openai-codex/gpt-6-luna:xhigh',
    });

    expect(decision.kind).toBe('reuse');
    expect(decision.kind === 'reuse' && decision.runEpoch).toBe(4);
    expect(decision.kind === 'reuse' && decision.session.status).toBe('idle');
  });

  it('bumps the epoch when it reopens a parked session on its own native history', () => {
    const instance = pool();
    const workstreamId = randomUUID();
    instance.upsert(
      session({ workstreamId, status: 'parked', runEpoch: 7, nativeSessionId: 'native-7' }),
    );

    const decision = instance.plan({
      role: 'worker',
      workstreamId,
      requestedModel: 'openai-codex/gpt-6-luna:xhigh',
    });

    expect(decision.kind === 'reuse' && decision.runEpoch).toBe(8);
    expect(decision.kind === 'reuse' && decision.session.nativeSessionId).toBe('native-7');
  });

  it('never hijacks a session that is busy or waiting on the user', () => {
    const instance = pool();
    const workstreamId = randomUUID();
    instance.upsert(session({ workstreamId, status: 'busy' }));
    instance.upsert(session({ workstreamId, status: 'waiting_input' }));

    const decision = instance.plan({
      role: 'worker',
      workstreamId,
      requestedModel: 'openai-codex/gpt-6-luna:xhigh',
    });

    expect(decision.kind).toBe('allocate');
  });
});

describe('archive pressure', () => {
  it('offers the oldest parked session when the pool is full', () => {
    const { instance, sessions } = poolWithIdle(10);
    for (const [index, entry] of sessions.entries()) {
      instance.upsert({ ...entry, status: 'parked', lastUsedAt: at(index * 1000) });
    }

    const decision = instance.plan({
      role: 'worker',
      workstreamId: randomUUID(),
      requestedModel: 'openai-codex/gpt-6-luna:xhigh',
    });

    expect(decision.kind === 'allocate' && decision.archiveCandidates[0].id).toBe(sessions[0].id);
  });

  it('reports the runner limit before suggesting an archive that would not help', () => {
    const instance = pool({ maxRetainedSessions: 2, maxLiveRunners: 1 });
    const live = session({ code: 'PA-S0001', status: 'busy' });
    const parked = session({ code: 'PA-S0002', status: 'parked' });
    instance.upsert(live);
    instance.upsert(parked);

    const decision = instance.plan({
      role: 'worker',
      workstreamId: randomUUID(),
      requestedModel: 'openai-codex/gpt-6-luna:xhigh',
    });

    expect(decision.kind === 'queue' && decision.code).toBe('live_limit');
    expect(decision.kind === 'queue' && decision.blockedBy).toEqual([live.id]);
  });

  it('refuses to evict a session that is live, running, or awaiting input', () => {
    const instance = pool({ maxRetainedSessions: 2, maxLiveRunners: 8 });
    const busy = session({ status: 'busy' });
    const waiting = session({ status: 'waiting_input', activeTaskId: randomUUID() });
    instance.upsert(busy);
    instance.upsert(waiting);

    const decision = instance.plan({
      role: 'worker',
      workstreamId: randomUUID(),
      requestedModel: 'openai-codex/gpt-6-luna:xhigh',
    });

    expect(decision.kind).toBe('queue');
    expect(decision.kind === 'queue' && decision.code).toBe('pool_full');
    expect(decision.kind === 'queue' && decision.blockedBy).toEqual([busy.id, waiting.id]);
  });

  it('refuses to evict a pinned parked session', () => {
    const instance = pool({ maxRetainedSessions: 1, maxLiveRunners: 8 });
    const pinned = session({ status: 'parked' });
    instance.upsert(pinned);
    instance.pin(pinned.id);

    const decision = instance.plan({
      role: 'worker',
      workstreamId: randomUUID(),
      requestedModel: 'openai-codex/gpt-6-luna:xhigh',
    });

    expect(decision.kind === 'queue' && decision.code).toBe('pool_full');
  });

  it('never archives a parked session before its handoff is stored', () => {
    const instance = pool();
    const parked = session({ status: 'parked' });
    instance.upsert(parked);

    expect(instance.planArchive(parked.id, { handoffStored: false })).toEqual({
      archive: false,
      reason: 'handoff_not_stored',
    });
    expect(instance.planArchive(parked.id, { handoffStored: true })).toEqual({ archive: true });
  });

  it('keeps a parked session that still has a pending question', () => {
    const instance = pool();
    const parked = session({ status: 'parked' });
    instance.upsert(parked);

    expect(
      instance.planArchive(parked.id, {
        handoffStored: true,
        questions: [question(parked.id)],
      }),
    ).toEqual({ archive: false, reason: 'pending_question' });
  });

  it('frees the retained slot once the handoff is stored and the session is archived', () => {
    const instance = pool({ maxRetainedSessions: 1, maxLiveRunners: 8 });
    const parked = session({ status: 'parked' });
    instance.upsert(parked);

    expect(instance.counts().retained).toBe(1);
    instance.upsert({ ...parked, status: 'archived', handoffArtifactId: randomUUID() });

    expect(instance.counts()).toMatchObject({ retained: 0, archived: 1 });
    expect(
      instance.plan({ role: 'worker', workstreamId: randomUUID(), requestedModel: 'model' }).kind,
    ).toBe('allocate');
  });

  it('exchanges an archived session for a parked one without losing either id', () => {
    const instance = pool({ maxRetainedSessions: 1, maxLiveRunners: 8 });
    const archived = session({ code: 'PA-S0001', status: 'archived' });
    const parked = session({ code: 'PA-S0002', status: 'parked' });
    instance.upsert(archived);
    instance.upsert(parked);

    instance.exchangeSlots(archived.id, parked.id);

    expect(instance.get(archived.id)?.status).toBe('parked');
    expect(instance.get(parked.id)?.status).toBe('archived');
  });

  it('drops an archived session from the hot view without freeing its retained slot', () => {
    const instance = pool({ maxRetainedSessions: 2, maxLiveRunners: 8 });
    const archived = session({ code: 'PA-S0001', status: 'archived' });
    const parked = session({ code: 'PA-S0002', status: 'parked' });
    instance.upsert(archived);
    instance.upsert(parked);

    instance.remove(archived.id);

    expect(instance.get(archived.id)).toBeUndefined();
    expect(instance.counts()).toMatchObject({ retained: 1, archived: 0 });
  });
});

describe('live runner bound', () => {
  it('queues new work when every runner is busy', () => {
    const instance = pool({ maxRetainedSessions: 10, maxLiveRunners: 2 });
    const first = session({ status: 'busy' });
    const second = session({ status: 'busy' });
    instance.upsert(first);
    instance.upsert(second);

    const decision = instance.plan({
      role: 'qa',
      workstreamId: randomUUID(),
      requestedModel: 'model',
    });

    expect(decision.kind === 'queue' && decision.code).toBe('live_limit');
    expect(decision.kind === 'queue' && decision.blockedBy).toEqual([first.id, second.id]);
  });

  it('admits work that only needs a retained slot while all runners are busy', () => {
    const instance = pool({ maxRetainedSessions: 10, maxLiveRunners: 1 });
    instance.upsert(session({ status: 'busy' }));

    const decision = instance.plan({
      role: 'worker',
      workstreamId: randomUUID(),
      requestedModel: 'model',
      requireLiveRunner: false,
    });

    expect(decision.kind === 'allocate');
    expect(decision.kind === 'allocate' && decision.mint.status).toBe('parked');
  });

  it('counts a paused session as live but a parked one as free', () => {
    const instance = pool();
    instance.upsert(session({ status: 'paused' }));
    instance.upsert(session({ status: 'parked' }));

    expect(instance.liveCount()).toBe(1);
    expect(
      instance
        .list()
        .filter(sessionHoldsRunner)
        .map((entry) => entry.status),
    ).toEqual(['paused']);
  });
});

describe('parking', () => {
  it('parks an idle session only after the idle threshold', () => {
    const instance = pool();
    const idle = session({ status: 'idle', lastUsedAt: at(0) });
    instance.upsert(idle);

    clock = T0 + IDLE_MS - 1;
    expect(instance.planPark(idle.id)).toEqual({ park: false, reason: 'not_idle_long_enough' });

    clock = T0 + IDLE_MS;
    expect(instance.planPark(idle.id)).toEqual({ park: true });
  });

  it('refuses to park a session with a pending question or an attached terminal', () => {
    const instance = pool();
    const idle = session({ status: 'idle' });
    instance.upsert(idle);
    clock = T0 + IDLE_MS;

    expect(instance.planPark(idle.id, { questions: [question(idle.id)] })).toEqual({
      park: false,
      reason: 'pending_question',
    });
    expect(instance.planPark(idle.id, { attachedTerminalSessionIds: [idle.id] })).toEqual({
      park: false,
      reason: 'terminal_attached',
    });
  });

  it('ranks park candidates oldest first and never lists one that is still busy', () => {
    const instance = pool();
    const older = session({ code: 'PA-S0001', status: 'idle', lastUsedAt: at(-30_000) });
    const newer = session({ code: 'PA-S0002', status: 'idle', lastUsedAt: at(-1000) });
    const busy = session({ code: 'PA-S0003', status: 'busy', lastUsedAt: at(-30_000) });
    for (const entry of [newer, busy, older]) instance.upsert(entry);
    clock = T0 + IDLE_MS;

    expect(instance.parkCandidates().map((entry) => entry.code)).toEqual(['PA-S0001', 'PA-S0002']);
  });
});

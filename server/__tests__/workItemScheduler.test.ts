import { describe, expect, it } from 'vitest';

import type { WorkItemAssignee,WorkItemBlocker } from '../../core/src/messages.js';
import { GIB } from '../src/company/workItems/squadSettings.js';
import {
  areasOverlap,
  checkoutKey,
  decideStart,
  isInsideRepo,
  type SchedulerContext,
  type SchedulerDecision,
  type SchedulerHold,
  type SchedulerItem,
  type SchedulerMember,
} from '../src/company/workItems/workItemScheduler.js';

const REPO = '/work/folder/app';
const OTHER = '/work/folder/other';

function item(overrides: Partial<SchedulerItem> = {}): SchedulerItem {
  return {
    sequence: 1,
    kind: 'auto',
    memberKey: undefined,
    repo: REPO,
    role: undefined,
    areas: [],
    readOnly: false,
    ...overrides,
  };
}

function member(
  key: string,
  assignee: WorkItemAssignee,
  overrides: Partial<SchedulerMember> = {},
): SchedulerMember {
  return {
    key,
    assignee,
    cwd: REPO,
    role: undefined,
    note: undefined,
    free: true,
    busy: false,
    squadRepo: undefined,
    ...overrides,
  };
}

function herdr(paneId: string, overrides: Partial<SchedulerMember> = {}): SchedulerMember {
  return member(`herdr:${paneId}`, { kind: 'herdr', paneId }, overrides);
}

function session(sessionId: string, overrides: Partial<SchedulerMember> = {}): SchedulerMember {
  return member(`session:${sessionId}`, { kind: 'session', sessionId }, overrides);
}

function hold(memberKey: string, overrides: Partial<SchedulerHold> = {}): SchedulerHold {
  return {
    memberKey,
    sequence: 9,
    readOnly: false,
    areas: [],
    checkout: undefined,
    ...overrides,
  };
}

function ctx(overrides: Partial<SchedulerContext> = {}): SchedulerContext {
  return {
    members: [],
    holds: [],
    maxParallel: 4,
    maxSquadSessions: 3,
    squadSessionsOpen: 0,
    freeBytes: 8 * GIB,
    minFreeBytes: 2 * GIB,
    claudeRunsOpen: 0,
    maxClaudeRuns: 2,
    preferClaude: false,
    ...overrides,
  };
}

/** The member key a decision uses; fails the test when the decision is not a use. */
function usedKey(decision: SchedulerDecision): string {
  if (decision.kind !== 'use') throw new Error(`expected use, got ${decision.kind}`);
  return decision.member.key;
}

/** The blocker a decision waits on; fails the test when the decision is not a wait. */
function blockerOf(decision: SchedulerDecision): WorkItemBlocker {
  if (decision.kind !== 'wait') throw new Error(`expected wait, got ${decision.kind}`);
  return decision.blocker;
}

/** The reason a wait decision shows; fails the test when the decision is not a wait. */
function reasonOf(decision: SchedulerDecision): string {
  if (decision.kind !== 'wait') throw new Error(`expected wait, got ${decision.kind}`);
  return decision.reason;
}

describe('decideStart: named herdr pane or session', () => {
  it('uses the named member when it is free and nothing holds it', () => {
    const decision = decideStart(
      item({ kind: 'herdr', memberKey: 'herdr:A' }),
      ctx({ members: [herdr('A')] }),
    );
    expect(usedKey(decision)).toBe('herdr:A');
  });

  it('waits on agent when the named member is absent', () => {
    const decision = decideStart(item({ kind: 'session', memberKey: 'session:gone' }), ctx());
    expect(blockerOf(decision)).toEqual({ kind: 'agent' });
  });

  it('waits on agent when the named member is not free', () => {
    const decision = decideStart(
      item({ kind: 'herdr', memberKey: 'herdr:A' }),
      ctx({ members: [herdr('A', { free: false })] }),
    );
    expect(blockerOf(decision)).toEqual({ kind: 'agent' });
  });

  it('waits on agent when a running item already holds the member', () => {
    const decision = decideStart(
      item({ kind: 'herdr', memberKey: 'herdr:A' }),
      ctx({ members: [herdr('A')], holds: [hold('herdr:A')] }),
    );
    expect(blockerOf(decision)).toEqual({ kind: 'agent' });
  });

  it('waits on capacity when running items reach maxParallel', () => {
    const holds = ['h1', 'h2', 'h3', 'h4'].map((paneId) => hold(`herdr:${paneId}`));
    const decision = decideStart(
      item({ kind: 'herdr', memberKey: 'herdr:A' }),
      ctx({ members: [herdr('A')], holds }),
    );
    expect(blockerOf(decision)).toEqual({ kind: 'capacity', running: 4, limit: 4 });
    expect(reasonOf(decision)).toContain('Đầy chỗ (4/4)');
  });

  it('still uses the member one below the cap', () => {
    const holds = ['h1', 'h2', 'h3'].map((paneId) => hold(`herdr:${paneId}`));
    const decision = decideStart(
      item({ kind: 'herdr', memberKey: 'herdr:A' }),
      ctx({ members: [herdr('A')], holds }),
    );
    expect(usedKey(decision)).toBe('herdr:A');
  });

  it('does not apply the RAM guard to a named member', () => {
    const decision = decideStart(
      item({ kind: 'herdr', memberKey: 'herdr:A' }),
      ctx({ members: [herdr('A')], freeBytes: 0 }),
    );
    expect(usedKey(decision)).toBe('herdr:A');
  });

  it('waits on area when a running item holds an overlapping area', () => {
    const decision = decideStart(
      item({ kind: 'herdr', memberKey: 'herdr:A', areas: ['web/ui'] }),
      ctx({ members: [herdr('A')], holds: [hold('herdr:B', { sequence: 5, areas: ['web'] })] }),
    );
    expect(blockerOf(decision)).toEqual({ kind: 'area', sequence: 5, area: 'web/ui' });
  });

  it('treats a shared prefix as overlap only at a folder boundary', () => {
    const named = item({ kind: 'herdr', memberKey: 'herdr:A', areas: ['api'] });
    const boundary = ctx({
      members: [herdr('A')],
      holds: [hold('herdr:B', { areas: ['api/v2'] })],
    });
    expect(blockerOf(decideStart(named, boundary))).toEqual({
      kind: 'area',
      sequence: 9,
      area: 'api',
    });
    const partial = ctx({ members: [herdr('A')], holds: [hold('herdr:B', { areas: ['apix'] })] });
    expect(usedKey(decideStart(named, partial))).toBe('herdr:A');
  });

  it('waits on the checkout lock when another item edits the same checkout', () => {
    const decision = decideStart(
      item({ kind: 'herdr', memberKey: 'herdr:A' }),
      ctx({
        members: [herdr('A')],
        holds: [hold('herdr:B', { sequence: 3, checkout: `${REPO}/` })],
      }),
    );
    expect(blockerOf(decision)).toEqual({ kind: 'area', sequence: 3, area: 'app' });
  });

  it('matches checkouts across Windows separators and case', () => {
    const decision = decideStart(
      item({ kind: 'herdr', memberKey: 'herdr:A' }),
      ctx({
        members: [herdr('A', { cwd: 'V:/Work/Folder/App' })],
        holds: [hold('herdr:B', { sequence: 3, checkout: 'v:\\work\\folder\\app' })],
      }),
    );
    expect(blockerOf(decision).kind).toBe('area');
  });

  it('lets a read-only item take no area or checkout lock', () => {
    const decision = decideStart(
      item({ kind: 'herdr', memberKey: 'herdr:A', areas: ['web'], readOnly: true }),
      ctx({
        members: [herdr('A')],
        holds: [hold('herdr:B', { areas: ['web'], checkout: REPO })],
      }),
    );
    expect(usedKey(decision)).toBe('herdr:A');
  });

  it('lets an editing item pass a read-only holder', () => {
    const decision = decideStart(
      item({ kind: 'herdr', memberKey: 'herdr:A', areas: ['web'] }),
      ctx({
        members: [herdr('A')],
        holds: [hold('herdr:B', { readOnly: true, areas: ['web'], checkout: REPO })],
      }),
    );
    expect(usedKey(decision)).toBe('herdr:A');
  });
});

describe('decideStart: auto', () => {
  it('picks an idle member inside the repo', () => {
    const decision = decideStart(item(), ctx({ members: [session('a')] }));
    expect(usedKey(decision)).toBe('session:a');
  });

  it('never picks a member outside the repo, and opens nothing when the squad cap is zero', () => {
    const decision = decideStart(
      item(),
      ctx({ members: [session('a', { cwd: OTHER })], maxSquadSessions: 0 }),
    );
    expect(blockerOf(decision)).toEqual({ kind: 'no_member' });
    expect(reasonOf(decision)).toContain('Chưa có agent trong repo app');
  });

  it('breaks ties by member key', () => {
    const decision = decideStart(item(), ctx({ members: [session('b'), session('a')] }));
    expect(usedKey(decision)).toBe('session:a');
  });

  it('prefers the squad-opened session with the same repo and role', () => {
    const decision = decideStart(
      item({ role: 'qa' }),
      ctx({
        members: [herdr('A'), session('S', { squadRepo: REPO, role: 'qa' })],
      }),
    );
    expect(usedKey(decision)).toBe('session:S');
  });

  it('prefers a role note naming the role over squad reuse', () => {
    const decision = decideStart(
      item({ role: 'qa' }),
      ctx({
        members: [
          session('S', { squadRepo: REPO, role: 'qa' }),
          herdr('A', { note: 'Chuyên QA mobile' }),
        ],
      }),
    );
    expect(usedKey(decision)).toBe('herdr:A');
  });

  it('gives squad reuse only to a session the squad opened for this repo', () => {
    const decision = decideStart(
      item({ role: 'qa' }),
      ctx({
        members: [
          session('A', { squadRepo: OTHER, role: 'qa' }),
          session('B', { squadRepo: REPO, role: 'qa' }),
        ],
      }),
    );
    expect(usedKey(decision)).toBe('session:B');
  });

  it('reaches a squad worktree outside the repo folder when the squad opened it for the repo', () => {
    const decision = decideStart(
      item({ role: 'qa' }),
      ctx({
        members: [session('W', { cwd: '/work/folder/.worktrees/squad-1a2b3c4d', squadRepo: REPO, role: 'qa' })],
      }),
    );
    expect(usedKey(decision)).toBe('session:W');
  });

  it('never picks a herdr pane for a subagent, and opens a read-only omp session in the repo for it', () => {
    const decision = decideStart(
      item({ agent: 'scout', readOnly: true }),
      ctx({ members: [herdr('A')] }),
    );
    expect(decision).toEqual({ kind: 'open', cwd: REPO, role: 'chat', isolate: false });
  });

  it('gives a subagent a free omp session in the repo, never a herdr pane', () => {
    const decision = decideStart(
      item({ agent: 'reviewer' }),
      ctx({ members: [herdr('A'), session('S')] }),
    );
    expect(usedKey(decision)).toBe('session:S');
  });

  it('leaves busy herdr panes out of the refusal for a subagent, since none can take it', () => {
    const decision = decideStart(
      item({ agent: 'reviewer' }),
      ctx({ members: [herdr('A', { free: false, busy: true })], maxSquadSessions: 0 }),
    );
    expect(blockerOf(decision)).toEqual({ kind: 'no_member' });
    expect(reasonOf(decision)).not.toContain('bận');
  });

  it('still lets the default worker take a free herdr pane', () => {
    expect(usedKey(decideStart(item({ agent: 'task' }), ctx({ members: [herdr('A')] })))).toBe(
      'herdr:A',
    );
    expect(usedKey(decideStart(item(), ctx({ members: [herdr('A')] })))).toBe('herdr:A');
  });

  it('keeps an explicit herdr assignee open to a subagent', () => {
    const decision = decideStart(
      item({ kind: 'herdr', memberKey: 'herdr:A', agent: 'scout', readOnly: true }),
      ctx({ members: [herdr('A')] }),
    );
    expect(usedKey(decision)).toBe('herdr:A');
  });

  it('skips a busy member and opens a session instead', () => {
    const decision = decideStart(item(), ctx({ members: [session('a', { free: false })] }));
    expect(decision).toEqual({ kind: 'open', cwd: REPO, role: 'chat', isolate: true });
  });

  it('skips a member that a running item holds', () => {
    const decision = decideStart(
      item(),
      ctx({ members: [session('a')], holds: [hold('session:a')] }),
    );
    expect(decision.kind).toBe('open');
  });

  it('moves past a member whose checkout is locked to the next idle member', () => {
    const decision = decideStart(
      item(),
      ctx({
        members: [session('a', { cwd: REPO }), session('b', { cwd: `${REPO}/sub` })],
        holds: [hold('herdr:H', { sequence: 3, checkout: REPO })],
      }),
    );
    expect(usedKey(decision)).toBe('session:b');
  });

  it('waits on the area of the first conflict when every idle member is locked', () => {
    const decision = decideStart(
      item(),
      ctx({
        members: [session('a', { cwd: REPO })],
        holds: [hold('herdr:H', { sequence: 3, checkout: REPO })],
      }),
    );
    expect(blockerOf(decision)).toEqual({ kind: 'area', sequence: 3, area: 'app' });
  });

  it('waits on capacity before looking at members', () => {
    const holds = ['h1', 'h2', 'h3', 'h4'].map((paneId) => hold(`herdr:${paneId}`));
    const decision = decideStart(item(), ctx({ members: [session('a')], holds }));
    expect(blockerOf(decision)).toEqual({ kind: 'capacity', running: 4, limit: 4 });
  });

  it('opens a chat session in the repo when nothing is idle', () => {
    expect(decideStart(item(), ctx())).toEqual({
      kind: 'open',
      cwd: REPO,
      role: 'chat',
      isolate: true,
    });
  });

  it('opens a session with the item role when it has one', () => {
    expect(decideStart(item({ role: 'qa' }), ctx())).toEqual({
      kind: 'open',
      cwd: REPO,
      role: 'qa',
      isolate: true,
    });
  });

  it('refuses to open when free memory is below the threshold', () => {
    const decision = decideStart(item(), ctx({ freeBytes: 1 * GIB }));
    expect(blockerOf(decision)).toEqual({ kind: 'no_member' });
    expect(reasonOf(decision)).toContain('RAM trống 1.0 GB, cần 2.0 GB');
  });

  it('refuses to open when the squad has reached its session cap', () => {
    const decision = decideStart(item(), ctx({ squadSessionsOpen: 3, maxSquadSessions: 3 }));
    expect(blockerOf(decision)).toEqual({ kind: 'no_member' });
    expect(reasonOf(decision)).toContain('đội đã mở 3/3 phiên');
  });

  it('names busy agents in the repo in the refusal, without blocking on them alone', () => {
    const busy = decideStart(
      item(),
      ctx({ members: [session('a', { free: false })], maxSquadSessions: 0 }),
    );
    expect(blockerOf(busy)).toEqual({ kind: 'no_member' });
    expect(reasonOf(busy)).toContain('1 phiên trong repo đang bận');
    expect(reasonOf(busy)).toContain('đội đã mở 0/0 phiên');
  });
});

describe('decideStart: new session', () => {
  it('opens in the repo with the item role, or chat when it has none', () => {
    expect(decideStart(item({ kind: 'new-session', role: 'worker' }), ctx())).toEqual({
      kind: 'open',
      cwd: REPO,
      role: 'worker',
      isolate: true,
    });
    expect(decideStart(item({ kind: 'new-session' }), ctx())).toEqual({
      kind: 'open',
      cwd: REPO,
      role: 'chat',
      isolate: true,
    });
  });

  it('is not held back by free memory or the squad session cap', () => {
    const decision = decideStart(
      item({ kind: 'new-session' }),
      ctx({ freeBytes: 0, squadSessionsOpen: 9, maxSquadSessions: 0 }),
    );
    expect(decision.kind).toBe('open');
  });

  it('still waits on capacity', () => {
    const holds = ['h1', 'h2', 'h3', 'h4'].map((paneId) => hold(`herdr:${paneId}`));
    const decision = decideStart(item({ kind: 'new-session' }), ctx({ holds }));
    expect(blockerOf(decision)).toEqual({ kind: 'capacity', running: 4, limit: 4 });
  });

  it('opens an isolated session even when another item holds the repo checkout', () => {
    const decision = decideStart(
      item({ kind: 'new-session' }),
      ctx({ holds: [hold('herdr:H', { sequence: 3, checkout: REPO })] }),
    );
    expect(decision).toEqual({ kind: 'open', cwd: REPO, role: 'chat', isolate: true });
  });

  it('still waits on the area of a running item the new session would overlap', () => {
    const decision = decideStart(
      item({ kind: 'new-session', areas: ['app/ui'] }),
      ctx({ holds: [hold('herdr:H', { sequence: 3, areas: ['app'] })] }),
    );
    expect(blockerOf(decision)).toEqual({ kind: 'area', sequence: 3, area: 'app/ui' });
  });

  it('opens the repo itself, without isolation, for a read-only new session', () => {
    const decision = decideStart(
      item({ kind: 'new-session', readOnly: true }),
      ctx({ holds: [hold('herdr:H', { sequence: 3, checkout: REPO })] }),
    );
    expect(decision).toEqual({ kind: 'open', cwd: REPO, role: 'chat', isolate: false });
  });
});

describe('decideStart: busy agents and isolation', () => {
  it('waits on the checkout of a busy agent outside the board for an editing auto item', () => {
    const decision = decideStart(
      item(),
      ctx({
        members: [session('a', { cwd: REPO }), session('b', { cwd: REPO, free: false, busy: true })],
      }),
    );
    expect(blockerOf(decision)).toEqual({ kind: 'busy_checkout', area: 'app' });
    expect(reasonOf(decision)).toContain('đang làm trong app');
  });

  it('lets a read-only item use an idle member while a busy agent shares its checkout', () => {
    const decision = decideStart(
      item({ readOnly: true }),
      ctx({
        members: [session('a', { cwd: REPO }), session('b', { cwd: REPO, free: false, busy: true })],
      }),
    );
    expect(usedKey(decision)).toBe('session:a');
  });

  it('ignores a busy agent whose work the board holds read-only', () => {
    const decision = decideStart(
      item(),
      ctx({
        members: [session('a', { cwd: REPO }), session('b', { cwd: REPO, free: false, busy: true })],
        holds: [hold('session:b', { readOnly: true, checkout: REPO })],
      }),
    );
    expect(usedKey(decision)).toBe('session:a');
  });

  it('makes an explicit editing item wait while a busy agent works in its checkout', () => {
    const decision = decideStart(
      item({ kind: 'herdr', memberKey: 'herdr:A' }),
      ctx({
        members: [herdr('A', { cwd: REPO }), session('b', { cwd: REPO, free: false, busy: true })],
      }),
    );
    expect(blockerOf(decision)).toEqual({ kind: 'busy_checkout', area: 'app' });
  });

  it('opens an isolated session for an editing item when a busy agent shares the repo', () => {
    const decision = decideStart(
      item(),
      ctx({ members: [session('b', { cwd: REPO, free: false, busy: true })] }),
    );
    expect(decision).toEqual({ kind: 'open', cwd: REPO, role: 'chat', isolate: true });
  });

  it('does not lock a checkout for a busy agent outside the repo', () => {
    const decision = decideStart(
      item(),
      ctx({
        members: [session('a', { cwd: REPO }), session('b', { cwd: OTHER, free: false, busy: true })],
      }),
    );
    expect(usedKey(decision)).toBe('session:a');
  });
});

describe('scheduler helpers', () => {
  it('normalizes checkout keys across separators, case, and trailing slashes', () => {
    expect(checkoutKey('V:\\Work\\App\\')).toBe('v:/work/app');
  });

  it('treats an area and its sub-area as overlapping, but not a longer name that shares characters', () => {
    expect(areasOverlap('web', 'web')).toBe(true);
    expect(areasOverlap('web', 'web/ui')).toBe(true);
    expect(areasOverlap('web', 'webapp')).toBe(false);
  });

  it('finds a checkout inside the repo, and never an undefined one', () => {
    expect(isInsideRepo(REPO, REPO)).toBe(true);
    expect(isInsideRepo(`${REPO}/sub`, REPO)).toBe(true);
    expect(isInsideRepo('/work/folder/application', REPO)).toBe(false);
    expect(isInsideRepo(undefined, REPO)).toBe(false);
  });
});

describe('decideStart: Claude Code runs', () => {
  it('starts an editing run in the item repo; the service isolates its checkout', () => {
    expect(decideStart(item({ kind: 'claude' }), ctx())).toEqual({
      kind: 'claude',
      cwd: REPO,
      readOnly: false,
    });
  });

  it('starts a read-only run in the repo itself', () => {
    expect(decideStart(item({ kind: 'claude', readOnly: true }), ctx())).toEqual({
      kind: 'claude',
      cwd: REPO,
      readOnly: true,
    });
  });

  it('waits once the claude run cap is full', () => {
    const decision = decideStart(
      item({ kind: 'claude' }),
      ctx({ claudeRunsOpen: 2, maxClaudeRuns: 2 }),
    );
    expect(decision.kind).toBe('wait');
    expect(blockerOf(decision).kind).toBe('capacity');
  });

  it('counts claude runs against the folder cap as well', () => {
    const decision = decideStart(
      item({ kind: 'claude' }),
      ctx({ maxParallel: 1, holds: [hold('herdr:p1')] }),
    );
    expect(decision.kind).toBe('wait');
  });

  it('waits behind an editing run that shares an area', () => {
    const decision = decideStart(
      item({ kind: 'claude', areas: ['web'] }),
      ctx({ holds: [hold('claude', { sequence: 2, areas: ['web'] })] }),
    );
    expect(decision.kind).toBe('wait');
  });

  it('prefers an idle member over a claude run for an auto item', () => {
    const decision = decideStart(
      item({ kind: 'auto' }),
      ctx({ members: [herdr('p1')], preferClaude: true }),
    );
    expect(usedKey(decision)).toBe('herdr:p1');
  });

  it('starts a claude run for an auto item when claude is preferred and a slot is free', () => {
    expect(decideStart(item({ kind: 'auto' }), ctx({ preferClaude: true }))).toEqual({
      kind: 'claude',
      cwd: REPO,
      readOnly: false,
    });
  });

  it('leaves an auto item to omp when the claude cap is full', () => {
    const decision = decideStart(
      item({ kind: 'auto' }),
      ctx({ preferClaude: true, claudeRunsOpen: 2, maxClaudeRuns: 2 }),
    );
    expect(decision.kind).toBe('open');
  });

  it('keeps an auto item on omp when claude is not preferred', () => {
    expect(decideStart(item({ kind: 'auto' }), ctx()).kind).toBe('open');
  });
});

import { describe, expect, it } from 'vitest';

import type { HerdrAgent, HerdrSleepingSession, LedgerSession } from '../../core/src/messages.js';
import {
  checkoutOf,
  ENDED_LIMIT,
  filterManagerChips,
  type ManagerInput,
  managersByCheckout,
  normalizeAgentKind,
  panesOf,
  sessionActivityByCheckout,
} from '../src/company/ledger/ledgerManagers.js';
import type { BoardSessionIndex } from '../src/company/ledger/ledgerMapping.js';
import { normalizeCheckoutPath } from '../src/company/ledger/ledgerSelection.js';

const GENERATED = '2026-10-18 10:00:00';
const TRUNK = 'D:/Code/app';
const BRANCH = 'D:/Code/app-feat';
const TRUNK_KEY = normalizeCheckoutPath(TRUNK);
const BRANCH_KEY = normalizeCheckoutPath(BRANCH);

function session(sessionId: string, overrides: Partial<LedgerSession> = {}): LedgerSession {
  return {
    sessionId,
    agentKind: 'omp',
    agentName: `Phiên ${sessionId}`,
    open: true,
    live: true,
    state: 'idle',
    cwd: BRANCH,
    repo: 'D:/Code/app',
    checkout: BRANCH,
    branch: 'feat/x',
    lastIntent: null,
    lastCallAt: '2026-10-18 09:55:00',
    calls5m: 0,
    calls30m: 0,
    spamming: false,
    spamReason: null,
    pid: null,
    ...overrides,
  };
}

function input(overrides: Partial<ManagerInput> = {}): ManagerInput {
  return {
    checkouts: [TRUNK_KEY, BRANCH_KEY],
    sessions: [],
    panes: [],
    boardSessions: {},
    generatedAt: GENERATED,
    ...overrides,
  };
}

describe('checkoutOf', () => {
  it('finds the checkout a folder sits in, and the longest path wins', () => {
    const keys = [TRUNK_KEY, BRANCH_KEY];
    expect(checkoutOf(`${BRANCH}/src/a.ts`, keys)).toBe(BRANCH_KEY);
    expect(checkoutOf('D:\\Code\\app\\src', keys)).toBe(TRUNK_KEY);
  });

  it('does not match a folder that only shares a name prefix', () => {
    expect(checkoutOf('D:/Code/apple', [TRUNK_KEY])).toBeNull();
  });
});

describe('sessionActivityByCheckout', () => {
  it('keeps the latest call per checkout, and reads a session without a checkout from its folder', () => {
    const sessions = [
      session('a', { lastCallAt: '2026-10-18 09:20:00' }),
      session('b', { lastCallAt: '2026-10-18 09:55:00' }),
      session('c', { checkout: null, cwd: `${TRUNK}/docs`, lastCallAt: '2026-10-18 08:00:00' }),
    ];
    const activity = sessionActivityByCheckout(sessions, [TRUNK_KEY, BRANCH_KEY]);
    expect(activity.get(BRANCH_KEY)).toBe(Date.parse('2026-10-18T09:55:00'));
    expect(activity.get(TRUNK_KEY)).toBe(Date.parse('2026-10-18T08:00:00'));
  });
});

describe('managersByCheckout', () => {
  it('orders waiting, active, idle, then ended, and keeps only the most recent ended ones', () => {
    const sessions = [
      session('a', { live: false, lastCallAt: '2026-10-18 09:50:00' }),
      session('b', {
        spamming: true,
        spamReason: 'gọi công cụ quá dày',
        lastCallAt: '2026-10-18 09:40:00',
      }),
      session('c', { lastCallAt: '2026-10-18 09:30:00' }),
      session('d', { open: false, lastCallAt: '2026-10-18 09:00:00' }),
      session('e', { open: false, lastCallAt: '2026-10-18 08:00:00' }),
      session('f', { open: false, lastCallAt: '2026-10-18 07:00:00' }),
    ];
    const chips = managersByCheckout(input({ sessions })).get(BRANCH_KEY) ?? [];
    expect(chips.map((chip) => chip.key)).toEqual([
      'session:b',
      'session:c',
      'session:a',
      'session:d',
      'session:e',
    ]);
    expect(chips.filter((chip) => chip.dot === 'ended')).toHaveLength(ENDED_LIMIT);
  });

  it('drops a closed session once a day has passed, and says a spamming one is waiting', () => {
    const sessions = [
      session('old', { open: false, lastCallAt: '2026-10-16 10:00:00' }),
      session('spam', { spamming: true, spamReason: 'lặp lại' }),
    ];
    const chips = managersByCheckout(input({ sessions })).get(BRANCH_KEY) ?? [];
    expect(chips.map((chip) => chip.key)).toEqual(['session:spam']);
    expect(chips[0]).toMatchObject({ dot: 'waiting', flag: 'Spam: lặp lại' });
  });

  it('names a board session by its board label and opens its drawer; an unlinked one opens the ledger session', () => {
    const boardSessions: BoardSessionIndex = {
      'board-1': { nativeSessionId: 'linked', label: 'S2 · Phiên chat' },
    };
    const sessions = [session('linked'), session('loose')];
    const chips = managersByCheckout(input({ sessions, boardSessions })).get(BRANCH_KEY) ?? [];
    expect(chips.find((chip) => chip.key === 'session:linked')).toMatchObject({
      label: 'S2 · Phiên chat',
      action: { kind: 'board', boardKey: 'board-1' },
    });
    expect(chips.find((chip) => chip.key === 'session:loose')).toMatchObject({
      label: 'Phiên loose',
      action: { kind: 'session', sessionId: 'loose' },
    });
  });

  it('lists a working herdr pane as active and a slept one as ended, and gives every checkout a list', () => {
    const agents: HerdrAgent[] = [
      {
        paneId: 'pane-12',
        kind: 'Claude',
        status: 'working',
        workspaceId: 'w1',
        cwd: BRANCH,
        title: '⠋ Đang sửa lỗi',
      },
    ];
    const sleeping: HerdrSleepingSession[] = [
      {
        paneId: 'pane-3',
        title: 'Việc cũ',
        sessionFile: 'old.jsonl',
        sleptAt: '2026-10-18 09:30:00',
        cwd: BRANCH,
      },
    ];
    const result = managersByCheckout(input({ panes: panesOf(agents, sleeping) }));
    const chips = result.get(BRANCH_KEY) ?? [];
    expect(chips).toMatchObject([
      {
        key: 'pane:pane-12',
        label: 'Claude 12',
        dot: 'active',
        state: 'đang làm',
        detail: 'Đang sửa lỗi',
      },
      {
        key: 'pane:pane-3',
        label: 'Đã ngủ 3',
        dot: 'ended',
        state: 'đang ngủ',
        action: { kind: 'sleeping', paneId: 'pane-3' },
      },
    ]);
    expect(result.get(TRUNK_KEY)).toEqual([]);
  });
});

describe('panesOf', () => {
  it('reads a sleeping pane as its own kind, and a live pane from its worktree root before its cwd', () => {
    const agents: HerdrAgent[] = [
      {
        paneId: 'pane-1',
        kind: 'Claude',
        status: 'idle',
        workspaceId: 'w1',
        cwd: BRANCH,
        worktreeRoot: TRUNK,
      },
    ];
    const sleeping: HerdrSleepingSession[] = [
      { paneId: 'pane-2', title: 'Ngủ', sessionFile: 's.jsonl', sleptAt: '2026-10-18 09:00:00' },
    ];
    expect(panesOf(agents, sleeping)).toEqual([
      {
        paneId: 'pane-1',
        kind: 'Claude',
        status: 'idle',
        location: TRUNK,
        title: null,
        sleptAt: null,
      },
      {
        paneId: 'pane-2',
        kind: 'Đã ngủ',
        status: 'sleeping',
        location: null,
        title: 'Ngủ',
        sleptAt: '2026-10-18 09:00:00',
      },
    ]);
  });
});

describe('filterManagerChips', () => {
  it('normalizes tool labels and filters the visible checkout managers', () => {
    const chips = managersByCheckout(input({
      sessions: [session('omp'), session('claude', { agentKind: 'Claude Code' }), session('sub', { agentKind: 'sub' })],
    })).get(BRANCH_KEY) ?? [];
    expect(normalizeAgentKind('Claude Code')).toBe('claude');
    expect(filterManagerChips(chips, 'claude').map((chip) => chip.key)).toEqual(['session:claude']);
    expect(filterManagerChips(chips, 'all')).toHaveLength(3);
  });
});

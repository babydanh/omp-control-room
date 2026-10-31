import { describe, expect, it } from 'vitest';

import type { FleetMachineSnapshot } from '../../core/src/messages.js';
import { CLOUD_CLEAN_HIDE_MS, settleCleaned } from '../src/company/fleet/cloudClean.js';

function machine(overrides: Partial<FleetMachineSnapshot> = {}): FleetMachineSnapshot {
  return { agentId: 'danh1', state: 'online', receivedAt: 0, repos: [], tmuxSessions: [], ...overrides } as FleetMachineSnapshot;
}

const session = { name: 'fix-aqp', attached: false, idleSeconds: 5 };

describe('settleCleaned', () => {
  it('keeps a removed task hidden while its machine still lists the tmux session', () => {
    const pending = new Map([['danh1/fix-aqp', 1_000]]);

    const result = settleCleaned(pending, [machine({ tmuxSessions: [session] })], 2_000);

    expect(result.settled).toEqual([]);
    expect([...result.remaining.keys()]).toEqual(['danh1/fix-aqp']);
  });

  it('keeps it hidden while the machine still lists its cloud branch', () => {
    const pending = new Map([['danh1/fix-aqp', 1_000]]);
    const repo = { branch: 'cloud/danh1-fix-aqp', ahead: 2, dirtyCount: 0 } as FleetMachineSnapshot['repos'][number];

    expect(settleCleaned(pending, [machine({ repos: [repo] })], 2_000).settled).toEqual([]);
  });

  it('settles once an online machine reports neither the session nor the branch', () => {
    const pending = new Map([['danh1/fix-aqp', 1_000]]);

    const result = settleCleaned(pending, [machine()], 2_000);

    expect(result.settled).toEqual(['danh1/fix-aqp']);
    expect(result.remaining.size).toBe(0);
  });

  it('does not settle on a machine that stopped reporting, until the hide time is up', () => {
    const pending = new Map([['danh1/fix-aqp', 1_000]]);
    const paused = machine({ state: 'stale' as FleetMachineSnapshot['state'] });

    expect(settleCleaned(pending, [paused], 2_000).settled).toEqual([]);
    expect(settleCleaned(pending, [paused], 1_000 + CLOUD_CLEAN_HIDE_MS + 1).settled).toEqual(['danh1/fix-aqp']);
  });
});

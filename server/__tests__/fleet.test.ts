import { describe, expect, it, vi } from 'vitest';

import type { ServerMessage } from '../../core/src/messages.js';
import { FLEET_REASON_READ_ONLY, FLEET_STALE_AFTER_MS } from '../src/fleet/constants.js';
import { classifyFleetMachineState, computeFleetOverlaps } from '../src/fleet/fleetSnapshot.js';
import { handleFleetMessage } from '../src/fleet/handler.js';
import type { FleetHubClient, FleetHubMachine } from '../src/fleet/hubClient.js';

function machine(agent_id: string, path: string, dirty_files: string[]): FleetHubMachine {
  return {
    agent_id,
    received_at: 1_000,
    sessions: [],
    repos: [{ path, branch: 'main', ahead: 0, behind: 0, dirty_files }],
  };
}

describe('fleet snapshot calculations', () => {
  it('finds the same dirty file across two cloud machines', () => {
    expect(
      computeFleetOverlaps(
        [
          machine('danh1', 'C:/work/pixel-agents', ['server/src/fleet.ts']),
          machine('danh4', 'D:/projects/pixel-agents', ['server/src/fleet.ts']),
        ],
        [],
      ),
    ).toEqual([
      { repo: 'pixel-agents', path: 'server/src/fleet.ts', machines: ['danh1', 'danh4'], local: false },
    ]);
  });

  it('maps .worktrees checkouts to their repository when matching local dirty files', () => {
    expect(
      computeFleetOverlaps(
        [machine('danh5', 'D:/projects/pixel-agents.worktrees/cloud', ['server/src/fleet.ts'])],
        [{ repo: 'C:/work/pixel-agents/.worktrees/local', dirtyFiles: ['server/src/fleet.ts'] }],
      ),
    ).toEqual([
      { repo: 'pixel-agents', path: 'server/src/fleet.ts', machines: ['danh5'], local: true },
    ]);
  });

  it('does not report matching file names in different repositories', () => {
    expect(
      computeFleetOverlaps(
        [
          machine('danh1', 'C:/work/pixel-agents', ['server/src/fleet.ts']),
          machine('danh4', 'D:/projects/another-project', ['server/src/fleet.ts']),
        ],
        [],
      ),
    ).toEqual([]);
  });

  it('classifies only machine reports older than ten minutes as stale', () => {
    const now = 1_000_000;
    expect(classifyFleetMachineState(now - FLEET_STALE_AFTER_MS, now)).toBe('online');
    expect(classifyFleetMachineState(now - FLEET_STALE_AFTER_MS - 1, now)).toBe('stale');
  });
});

describe('handleFleetMessage', () => {
  it('refuses requests from unprivileged connections without fetching fleet data', () => {
    const sent: ServerMessage[] = [];
    const fleet: FleetHubClient = { fetchFleet: vi.fn(async () => ({ now: 1_000, machines: [] })) };

    const handled = handleFleetMessage(
      { type: 'fleetRequest', requestId: 'request-1' },
      (message) => sent.push(message),
      { fleet, ledger: null, privileged: false },
    );

    expect(handled).toBe(true);
    expect(sent).toEqual([
      {
        type: 'fleetCommandResult',
        requestId: 'request-1',
        ok: false,
        code: 'forbidden',
        reason: FLEET_REASON_READ_ONLY,
      },
    ]);
    expect(fleet.fetchFleet).not.toHaveBeenCalled();
  });
});

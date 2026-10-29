import { describe, expect, it } from 'vitest';

import type { FleetMachineSnapshot, LedgerSession } from '../../core/src/messages.js';
import {
  buildUnifiedAgentSessions,
  filterUnifiedAgentSessions,
} from '../src/company/agentSessions.js';

function localSession(sessionId: string, agentKind: string): LedgerSession {
  const open = agentKind !== 'closed' && !sessionId.endsWith('-closed');
  return {
    sessionId,
    agentKind,
    agentName: agentKind,
    open,
    live: open,
    state: open ? 'running' : 'ended',
    cwd: `C:/work/${sessionId}`,
    repo: null,
    checkout: null,
    branch: `branch-${sessionId}`,
    lastIntent: null,
    lastCallAt: null,
    calls5m: 0,
    calls30m: 0,
    spamming: false,
    spamReason: null,
    pid: null,
  };
}

function cloudMachine(): FleetMachineSnapshot {
  return {
    agentId: 'instabox-1',
    receivedAt: 1,
    state: 'online',
    sessionCount: 1,
    engines: ['codex'],
    repos: [],
    tmuxSessions: [{ name: 'cloud-codex', attached: true, idleSeconds: 5, engine: 'codex', cwd: '/work/cloud', branch: 'cloud-branch' }],
  };
}

describe('unified agent sessions', () => {
  it('lists every local CLI kind and cloud sessions with provider, path, branch and status', () => {
    const rows = buildUnifiedAgentSessions([
      localSession('omp-open', 'main'),
      localSession('claude-open', 'claude'),
      localSession('agy-open', 'agy'),
      localSession('codex-closed', 'codex'),
      localSession('pi-closed', 'pi'),
      localSession('thinkrail-closed', 'thinkrail'),
      localSession('ended', 'closed'),
    ], [cloudMachine()]);

    expect(rows.map((row) => [row.engine, row.machine, row.status])).toEqual([
      ['omp', 'local', 'running'],
      ['claude', 'local', 'running'],
      ['agy', 'local', 'running'],
      ['codex', 'local', 'ended'],
      ['pi', 'local', 'ended'],
      ['thinkrail', 'local', 'ended'],
      ['unknown', 'local', 'ended'],
      ['codex', 'instabox-1', 'running'],
    ]);
    expect(rows.find((row) => row.sessionId === 'codex-closed')).toMatchObject({
      cwd: 'C:/work/codex-closed',
      branch: 'branch-codex-closed',
    });
    expect(rows.find((row) => row.sessionId === 'cloud-codex')).toMatchObject({
      cwd: '/work/cloud',
      branch: 'cloud-branch',
    });
  });

  it('filters by provider and machine without dropping ended sessions', () => {
    const rows = buildUnifiedAgentSessions([
      localSession('codex-local', 'codex'),
      localSession('pi-local', 'pi'),
    ], [cloudMachine()]);

    expect(filterUnifiedAgentSessions(rows, { engine: 'codex', machine: 'instabox-1' }).map((row) => row.sessionId))
      .toEqual(['cloud-codex']);
    expect(filterUnifiedAgentSessions(rows, { engine: 'pi', machine: 'local' }).map((row) => row.sessionId))
      .toEqual(['pi-local']);
  });
});

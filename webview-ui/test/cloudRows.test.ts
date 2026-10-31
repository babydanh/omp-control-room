import { describe, expect, it } from 'vitest';

import type { FleetMachineSnapshot } from '../../core/src/messages.js';
import { pendingCloudRow } from '../src/company/fleet/cloudRows.js';
import type { FleetAction } from '../src/company/fleet/fleetStore.js';
import { drawerSubjectKey } from '../src/company/selection.js';
import { previewTargetOfSubject } from '../src/company/terminalPreview.js';

function machine(agentId: string, sessions: readonly string[]): FleetMachineSnapshot {
  return {
    agentId,
    receivedAt: 0,
    state: 'online',
    sessionCount: 0,
    engines: [],
    repos: [],
    tmuxSessions: sessions.map((name) => ({ name, attached: false, idleSeconds: 0 })),
  };
}

const taskAction: FleetAction = { requestId: 'r1', kind: 'task', machine: 'danh', session: 'sua-loi-ab12' };

describe('pendingCloudRow', () => {
  it('holds a row while the task is being created, before tmux exists', () => {
    expect(pendingCloudRow({ action: taskAction, createdTask: null }, [machine('danh', [])])).toEqual({
      machine: 'danh',
      session: 'sua-loi-ab12',
    });
  });

  it('keeps the row after creation until the machine reports the tmux session', () => {
    const created = { machine: 'danh', session: 'sua-loi-ab12' };
    expect(pendingCloudRow({ action: null, createdTask: created }, [machine('danh', ['other'])])).toEqual(created);
    expect(pendingCloudRow({ action: null, createdTask: created }, [machine('danh', ['other', 'sua-loi-ab12'])])).toBeNull();
  });

  it('shows nothing for other actions or when nothing was created', () => {
    expect(pendingCloudRow({ action: { ...taskAction, kind: 'terminal' }, createdTask: null }, [])).toBeNull();
    expect(pendingCloudRow({ action: null, createdTask: null }, [])).toBeNull();
  });

  it('matches the reported session on its own machine only', () => {
    const created = { machine: 'danh', session: 'x-1' };
    expect(pendingCloudRow({ action: null, createdTask: created }, [machine('danh3', ['x-1'])])).toEqual(created);
  });
});

describe('cloud drawer subject', () => {
  it('keys a cloud session by machine and name, apart from other subjects', () => {
    expect(drawerSubjectKey({ kind: 'cloud', machine: 'danh', session: 'a' })).toBe('cloud:danh/a');
    expect(drawerSubjectKey({ kind: 'cloud', machine: 'danh', session: 'a' })).not.toBe(
      drawerSubjectKey({ kind: 'cloud', machine: 'danh3', session: 'a' }),
    );
  });

  it('has no local row whose preview must stay shut', () => {
    expect(previewTargetOfSubject({ kind: 'cloud', machine: 'danh', session: 'a' })).toBeNull();
  });
});

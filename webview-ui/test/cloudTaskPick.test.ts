import { describe, expect, it } from 'vitest';

import type { FleetMachineSnapshot } from '../../core/src/messages.js';
import { pickMachine, PROJECT_REPOS, slugFromPrompt } from '../src/company/fleet/cloudTaskPick.js';

function machine(agentId: string, sessions: number, repos = PROJECT_REPOS): FleetMachineSnapshot {
  return {
    agentId,
    receivedAt: 0,
    state: 'online',
    sessionCount: 0,
    engines: [],
    repos: repos.map((name) => ({ name, branch: 'main', ahead: 0, behind: 0, dirtyCount: 0 })),
    tmuxSessions: Array.from({ length: sessions }, (_, i) => ({ name: `s${i}`, attached: false, idleSeconds: 0 })),
  };
}

describe('pickMachine', () => {
  it('takes the least busy machine that has all three project repositories', () => {
    expect(pickMachine([machine('danh', 2), machine('danh1', 1), machine('danh4', 0, [])])).toBe('danh1');
  });

  it('skips machines already running three agents and returns null when all are full', () => {
    expect(pickMachine([machine('danh', 3), machine('danh3', 2)])).toBe('danh3');
    expect(pickMachine([machine('danh', 3), machine('danh1', 4)])).toBeNull();
  });
});

describe('slugFromPrompt', () => {
  it('turns a Vietnamese request into a valid task name', () => {
    const slug = slugFromPrompt('Sửa lỗi xếp sân đôi khi Đổi giờ thi đấu', 'ab12');
    expect(slug).toBe('sua-loi-xep-san-doi-ab12');
    expect(slug).toMatch(/^[a-z0-9][a-z0-9-]{0,39}$/);
  });

  it('falls back to a generic name when the request has no letters or digits', () => {
    expect(slugFromPrompt('!!! ???', 'zz99')).toBe('viec-zz99');
  });
});

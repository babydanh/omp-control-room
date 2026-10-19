import { describe, expect, it } from 'vitest';

import type { AgentRole, WorkItemStatus } from '../../core/src/messages.js';
import {
  type MemberSources,
  samePath,
  type SquadAgentView,
  squadMembers,
} from '../src/company/squad/squadWiring.js';

const FOLDER = 'V:\\pixel-agents\\app';

function pane(overrides: Partial<SquadAgentView> & { paneId: string }): SquadAgentView {
  return { status: 'idle', workspacePath: FOLDER, ...overrides };
}

function sources(overrides: Partial<MemberSources> = {}): MemberSources {
  return {
    workspacePath: FOLDER,
    herdr: undefined,
    sessions: [],
    roles: [],
    items: [],
    ...overrides,
  };
}

function live(
  paneId: string,
  status: WorkItemStatus,
): { assignee: { kind: 'herdr'; paneId: string }; status: WorkItemStatus } {
  return { assignee: { kind: 'herdr', paneId }, status };
}

describe('squadMembers', () => {
  it('lists the panes tagged with this folder, with their role note and live item count', () => {
    const role: AgentRole = {
      agent: { kind: 'herdr', paneId: 'wA:p1' },
      description: 'Frontend',
      updatedAt: '2026-05-01T08:00:00.000Z',
    };
    const members = squadMembers(
      sources({
        herdr: {
          snapshot: () => ({
            available: true,
            agents: [
              pane({
                paneId: 'wA:p1',
                name: 'UI',
                repo: 'app',
                branch: 'main',
                cwd: 'V:\\pixel-agents\\app\\ui',
              }),
              pane({ paneId: 'wA:p2', workspacePath: 'V:\\other' }),
              pane({ paneId: 'wA:p3', workspacePath: undefined }),
            ],
          }),
        },
        roles: [role],
        items: [live('wA:p1', 'queued'), live('wA:p1', 'done'), live('wA:p1', 'running')],
      }),
    );
    expect(members).toEqual([
      {
        ref: 'herdr:wA:p1',
        kind: 'herdr',
        assignee: { kind: 'herdr', paneId: 'wA:p1' },
        label: 'UI',
        status: 'idle',
        repo: 'app',
        branch: 'main',
        cwd: 'V:\\pixel-agents\\app\\ui',
        role: 'Frontend',
        queued: 2,
      },
    ]);
  });

  it('lists no panes while the herdr link is unavailable', () => {
    const members = squadMembers(
      sources({
        herdr: { snapshot: () => ({ available: false, agents: [pane({ paneId: 'wA:p1' })] }) },
      }),
    );
    expect(members).toEqual([]);
  });

  it('lists omp sessions the coordinator still reports, and drops gone ones', () => {
    const members = squadMembers(
      sources({
        sessions: [
          { id: 's1', code: 'S1', name: 'Dev', status: 'idle' },
          { id: 's2', code: 'S2', name: '', status: 'busy' },
          { id: 's3', code: 'S3', name: 'Cũ', status: 'stopped' },
        ],
        roles: [
          {
            agent: { kind: 'session', sessionId: 's2' },
            description: 'QA',
            updatedAt: '2026-05-01T08:00:00.000Z',
          },
        ],
      }),
    );
    expect(members.map((member) => member.ref)).toEqual(['session:s1', 'session:s2']);
    expect(members[0]).toMatchObject({ label: 'Dev', role: '', queued: 0 });
    expect(members[1]).toMatchObject({ label: 'S2', role: 'QA', status: 'busy' });
  });

  it('counts a session item as queued only while it is still live', () => {
    const members = squadMembers(
      sources({
        sessions: [{ id: 's1', code: 'S1', name: 'Dev', status: 'idle' }],
        items: [
          { assignee: { kind: 'session', sessionId: 's1' }, status: 'needs_input' },
          { assignee: { kind: 'session', sessionId: 's1' }, status: 'failed' },
        ],
      }),
    );
    expect(members[0]?.queued).toBe(1);
  });
});

describe('samePath', () => {
  it('ignores slash style, trailing slashes and letter case', () => {
    expect(samePath('V:\\Pixel-Agents\\App\\', 'v:/pixel-agents/app')).toBe(true);
    expect(samePath('V:/pixel-agents/app', 'V:/pixel-agents/other')).toBe(false);
  });
});

import { describe, expect, it, vi } from 'vitest';

import type { SessionRow } from '../src/ledger/ledgerDb.js';
import { type SessionWakeDeps, wakeEndedSession } from '../src/projects/sessionWake.js';

const OMP_ID = '01a17c64-05ec-7096-9639-6d082d87aec8';
const CLAUDE_ID = '5320e2e5-e5ac-4fe5-94b2-ce1e84d6ed51';

function row(extra: Partial<SessionRow>): SessionRow {
  return {
    sessionId: OMP_ID,
    pid: 10,
    cwd: 'V:/repo',
    agentKind: 'omp',
    agentName: null,
    parentId: null,
    sessionFile: `C:/sessions/2026-10-27T08-04-52-332Z_${OMP_ID}.jsonl`,
    startedAt: '2026-10-27T08:00:00.000Z',
    lastSeen: '2026-10-27T09:00:00.000Z',
    endedAt: '2026-10-27T09:00:00.000Z',
    state: 'ended',
    heartbeat: null,
    ...extra,
  };
}

function deps(rows: SessionRow[], extra: Partial<SessionWakeDeps> = {}) {
  const startAgent = vi.fn<SessionWakeDeps['startAgent']>(async () => 'p_new');
  return {
    startAgent,
    deps: {
      sessionRows: () => rows,
      startAgent,
      findAgent: () => undefined,
      isDirectory: () => true,
      ...extra,
    } satisfies SessionWakeDeps,
  };
}

describe('wakeEndedSession', () => {
  it('reopens an ended omp session from its file and a Claude one from its id, in the folder it ran in', async () => {
    const omp = deps([row({})]);
    await expect(wakeEndedSession(OMP_ID, 'làm tiếp', omp.deps)).resolves.toEqual({ paneId: 'p_new' });
    expect(omp.startAgent).toHaveBeenCalledWith({
      cwd: 'V:/repo',
      kind: 'omp',
      name: 'omp-2d87aec8',
      args: ['--resume', `C:/sessions/2026-10-27T08-04-52-332Z_${OMP_ID}.jsonl`],
      prompt: 'làm tiếp',
    });

    const claude = deps([row({ sessionId: CLAUDE_ID, agentKind: 'claude-code', sessionFile: null })]);
    await wakeEndedSession(CLAUDE_ID, '', claude.deps);
    expect(claude.startAgent).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'claude', name: 'claude-84d6ed51', args: ['--resume', CLAUDE_ID] }),
    );
  });

  it('opens the pane of a wake already under way instead of starting a second agent', async () => {
    const twice = deps([row({})], { findAgent: (name) => (name === 'omp-2d87aec8' ? { paneId: 'p_first' } : undefined) });
    await expect(wakeEndedSession(OMP_ID, '', twice.deps)).resolves.toEqual({ paneId: 'p_first' });
    expect(twice.startAgent).not.toHaveBeenCalled();
  });

  it('reopens an omp session a board chat ran as that chat, never as a second process on its file', async () => {
    const reopenBoardChat = vi.fn<NonNullable<SessionWakeDeps['reopenBoardChat']>>(async () => ({ folder: 'V:/repo', sessionId: 'board-1' }));
    const board = deps([row({})], { reopenBoardChat });
    await expect(wakeEndedSession(OMP_ID, 'làm tiếp', board.deps)).resolves.toEqual({ boardSessionId: 'board-1', folder: 'V:/repo' });
    expect(reopenBoardChat).toHaveBeenCalledWith({ nativeSessionId: OMP_ID, cwd: 'V:/repo', prompt: 'làm tiếp' });
    expect(board.startAgent).not.toHaveBeenCalled();

    // No board chat ran it: it resumes in herdr.
    const plain = deps([row({})], { reopenBoardChat: async () => undefined });
    await expect(wakeEndedSession(OMP_ID, '', plain.deps)).resolves.toEqual({ paneId: 'p_new' });
  });

  it('refuses a live session, a subagent, another agent kind and a folder that is gone', async () => {
    const refused = async (rows: SessionRow[], extra: Partial<SessionWakeDeps> = {}) => {
      const { deps: wakeDeps, startAgent } = deps(rows, extra);
      const error = await wakeEndedSession(OMP_ID, '', wakeDeps).catch((caught: unknown) => caught);
      expect(startAgent).not.toHaveBeenCalled();
      return error instanceof Error ? error.message : String(error);
    };
    expect(await refused([row({ endedAt: null })])).toBe('Phiên này vẫn đang chạy.');
    expect(await refused([row({ agentKind: 'sub' })])).toMatch(/phiên cha/);
    expect(await refused([row({ agentKind: 'agy' })])).toMatch(/omp và Claude/);
    expect(await refused([row({})], { isDirectory: () => false })).toBe('Thư mục của phiên không còn nữa.');
    expect(await refused([])).toBe('Sổ hoạt động không còn ghi phiên này.');
  });
});

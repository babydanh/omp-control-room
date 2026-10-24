import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { emptyWorkItemsFile, parseWorkItemsFile } from '../src/company/workItems/workItemModel.js';
import { type WorkItemPorts,WorkItemService } from '../src/company/workItems/workItemService.js';

const ISSUE_URL = 'https://github.com/babydanh/agent-orchestrator/issues/42';
const COMMENT = JSON.stringify([{
  body: [
    '**OMP Orchestrator:**',
    '✅ Hoàn tất trên cloud',
    '- repo: nhánh omp/issue-42, 3 file khác main',
    'Log: https://github.com/babydanh/agent-orchestrator/actions/runs/123',
  ].join('\n'),
}]);

type CommandResult = { code: number; stdout: string; stderr: string };
type CommandHandler = (
  file: string,
  argv: readonly string[],
  cwd: string,
  timeoutMs: number,
) => Promise<CommandResult>;

interface CloudFixture {
  readonly service: WorkItemService;
  readonly itemId: string;
  readonly repo: string;
  readonly worktree: string;
  readonly calls: { file: string; argv: readonly string[]; cwd: string; timeoutMs: number }[];
  readonly setHandler: (handler: CommandHandler) => void;
  handoff: string | undefined;
}

function fixture(): CloudFixture {
  const workspace = join(process.cwd(), 'cloud-workspace');
  const repo = join(workspace, 'repo');
  const worktree = join(repo, '.worktrees', 'squad-42');
  const itemId = randomUUID();
  const at = '2026-05-01T08:00:00.000Z';
  const rawItem = {
    id: itemId,
    text: 'Sửa endpoint đăng nhập',
    assignee: { kind: 'new-session' },
    status: 'review',
    sequence: 1,
    priority: 2,
    dependsOn: [],
    repo,
    worktree: { path: worktree, branch: 'squad-42' },
    createdAt: at,
    updatedAt: at,
    history: [{ at, kind: 'created' }, { at, kind: 'note', message: 'Đã kiểm tra API' }],
  };
  const saved = { ...emptyWorkItemsFile(), nextSequence: 2, items: [rawItem] };
  const calls: CloudFixture['calls'] = [];
  const handler: { current: CommandHandler } = {
    current: async () => ({ code: 0, stdout: '', stderr: '' }),
  };
  const state: { handoff?: string } = {};
  const ports = {
    roster: { panes: () => ({ available: false, panes: [] }), prompt: async () => undefined, screenText: async () => '' },
    sessions: {
      list: () => [],
      submit: async () => undefined,
      wake: async () => undefined,
      park: async () => false,
      lastReply: async () => undefined,
      openChat: async () => 'session',
    },
    persistence: { load: async () => parseWorkItemsFile(saved), save: async () => undefined },
    worktrees: { create: async () => ({ path: worktree, branch: 'squad-42' }), remove: async () => 'removed', exists: () => true },
    publish: () => undefined,
    now: () => Date.parse(at),
    newId: () => randomUUID(),
    schedule: () => () => undefined,
    catalog: async () => ({ repos: [repo], agents: [], claudeAgents: [] }),
    freeMemoryBytes: () => 8 * 1024 ** 3,
    freeDiskBytes: async () => 20 * 1024 ** 3,
    judge: async () => '',
    overlaps: async () => [],
    boardWatching: () => false,
    claude: { onChange: () => () => undefined },
    agy: { onChange: () => () => undefined },
    claudeAuth: { current: () => null },
    claudeMcp: { names: () => [] },
    cloud: {
      fastHandoffScript: 'C:\\Users\\GIGABYTE\\.omp\\scripts\\fast-handoff.ps1',
      run: async (file: string, argv: readonly string[], cwd: string, timeoutMs: number) => {
        calls.push({ file, argv: [...argv], cwd, timeoutMs });
        return handler.current(file, argv, cwd, timeoutMs);
      },
      readHandoff: async () => state.handoff,
      writeHandoff: async (_path: string, content: string) => { state.handoff = content; },
    },
  } as unknown as WorkItemPorts;
  const service = new WorkItemService(workspace, ports);
  return {
    service,
    itemId,
    repo,
    worktree,
    calls,
    setHandler: (current) => { handler.current = current; },
    get handoff() { return state.handoff; },
    set handoff(content) { state.handoff = content; },
  };
}

async function startCloud(f: CloudFixture): Promise<void> {
  await f.service.load();
  f.setHandler((_file, argv) => argv[0] === 'status'
    ? Promise.resolve({ code: 0, stdout: '', stderr: '' })
    : argv[0] === '-NoProfile'
      ? Promise.resolve({ code: 0, stdout: `LINK ISSUE: ${ISSUE_URL}`, stderr: '' })
      : Promise.resolve({ code: 0, stdout: '', stderr: '' }));
  await f.service.pushToCloud({ requestId: randomUUID(), id: f.itemId });
}

function completionHandler(options: {
  readonly fetch?: CommandResult;
  readonly status?: string;
  readonly merge?: CommandResult;
  readonly gh?: CommandResult;
} = {}): CommandHandler {
  return async (_file, argv) => {
    if (argv[0] === 'api') {
      if (argv.some((part) => part.endsWith('/comments'))) {
        return options.gh ?? { code: 0, stdout: COMMENT, stderr: '' };
      }
      return { code: 0, stdout: JSON.stringify({ state: 'open' }), stderr: '' };
    }
    if (argv[0] === 'fetch') return options.fetch ?? { code: 0, stdout: '', stderr: '' };
    if (argv[0] === 'status') return { code: 0, stdout: options.status ?? '', stderr: '' };
    if (argv.includes('merge')) return options.merge ?? { code: 0, stdout: '', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
}

describe('WorkItemService cloud handoff', () => {
  it('refuses every dirty worktree file before writing HANDOFF or starting Powershell', async () => {
    const f = fixture();
    await f.service.load();
    f.setHandler((_file, argv) => argv[0] === 'status'
      ? Promise.resolve({ code: 0, stdout: ' M source.ts\n?? new.txt\n', stderr: '' })
      : Promise.resolve({ code: 0, stdout: `LINK ISSUE: ${ISSUE_URL}`, stderr: '' }));

    await expect(f.service.pushToCloud({ requestId: randomUUID(), id: f.itemId })).rejects.toMatchObject({
      message: 'Worktree còn 2 file chưa commit: commit hẹp đúng file của việc trước rồi mới đẩy lên cloud.',
    });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]?.argv[0]).toBe('status');
    expect(f.handoff).toBeUndefined();
  });

  it('counts .ripwire_quality_baseline as dirty before handoff', async () => {
    const f = fixture();
    await f.service.load();
    f.setHandler((_file, argv) => argv[0] === 'status'
      ? Promise.resolve({ code: 0, stdout: '?? .ripwire_quality_baseline\n', stderr: '' })
      : Promise.resolve({ code: 0, stdout: `LINK ISSUE: ${ISSUE_URL}`, stderr: '' }));

    await expect(f.service.pushToCloud({ requestId: randomUUID(), id: f.itemId })).rejects.toMatchObject({
      message: 'Worktree còn 1 file chưa commit: commit hẹp đúng file của việc trước rồi mới đẩy lên cloud.',
    });
    expect(f.calls).toHaveLength(1);
    expect(f.handoff).toBeUndefined();
  });

  it('commits only HANDOFF.md before fast-handoff and omits -SkipHandoffFile', async () => {
    const f = fixture();
    f.handoff = '# Bàn giao cũ\nNội dung giữ nguyên.\n';
    await startCloud(f);

    expect(f.calls.map((call) => call.argv[0])).toEqual(['status', 'add', 'commit', 'status', '-NoProfile']);
    expect(f.calls[3]?.argv[0]).toBe('status');
    expect(f.calls[4]?.argv[0]).toBe('-NoProfile');
    expect(f.calls[1]?.argv).toEqual(['add', '--', 'HANDOFF.md']);
    expect(f.calls[2]?.argv).toContain('docs(handoff): bàn giao #1 lên cloud');
    expect(f.calls[2]?.argv).toContain('HANDOFF.md');
    expect(f.calls[4]?.argv).not.toContain('-SkipHandoffFile');
    expect(f.handoff).toContain('# Bàn giao cũ\nNội dung giữ nguyên.');
    expect(f.handoff).toContain('## Cập nhật ');
    expect(f.handoff).toContain('Mục tiêu');
    expect(f.handoff).toContain('Đã kiểm tra API');
    expect(f.service.get(f.itemId)?.cloud).toMatchObject({
      issue: 42,
      url: ISSUE_URL,
      branch: 'squad-42',
      repo: f.repo,
      state: 'running',
    });
  });

  it('does not publish cloud state when fast-handoff exits 2', async () => {
    const f = fixture();
    await f.service.load();
    f.setHandler((_file, argv) => argv[0] === 'status'
      ? Promise.resolve({ code: 0, stdout: '', stderr: '' })
      : argv[0] === '-NoProfile'
        ? Promise.resolve({ code: 2, stdout: '>>> DUNG HANDOFF: khong tao duoc Issue', stderr: '' })
        : Promise.resolve({ code: 0, stdout: '', stderr: '' }));

    await expect(f.service.pushToCloud({ requestId: randomUUID(), id: f.itemId })).rejects.toThrow('DUNG HANDOFF');
    expect(f.service.get(f.itemId)?.cloud).toBeUndefined();
  });
});

describe('WorkItemService cloud tracking and pull', () => {
  it('moves running to finished on an orchestrator comment, then handles a missing remote branch', async () => {
    const f = fixture();
    await startCloud(f);
    f.calls.length = 0;
    f.setHandler(completionHandler({
      fetch: { code: 128, stdout: '', stderr: "fatal: couldn't find remote ref omp/issue-42" },
    }));

    await f.service.refreshDeliveries();

    expect(f.service.get(f.itemId)?.cloud).toMatchObject({
      issue: 42,
      state: 'no_changes',
      summary: '✅ Hoàn tất trên cloud',
      logUrl: 'https://github.com/babydanh/agent-orchestrator/actions/runs/123',
    });
    expect(f.calls.some((call) => call.argv.includes('merge'))).toBe(false);
    expect(f.service.snapshot().items[0]?.history.some((event) => event.message?.includes('Đã đẩy lên cloud'))).toBe(true);
  });

  it('keeps running unchanged when GitHub cannot return the Issue comments', async () => {
    const f = fixture();
    await startCloud(f);
    f.calls.length = 0;
    f.setHandler(completionHandler({ gh: { code: 1, stdout: '', stderr: 'network error' } }));

    await f.service.refreshDeliveries();

    expect(f.service.get(f.itemId)?.cloud).toMatchObject({ issue: 42, state: 'running' });
    expect(f.calls.some((call) => call.argv[0] === 'fetch')).toBe(false);
  });

  it.each([
    { state: 'waiting_clean', status: ' M edit.ts\n', merge: false },
    { state: 'pulled', status: '', merge: true },
    { state: 'diverged', status: '', merge: true },
  ])('safely handles automatic pull state $state', async ({ state, status, merge }) => {
    const f = fixture();
    await startCloud(f);
    f.calls.length = 0;
    f.setHandler(completionHandler({
      status,
      merge: state === 'diverged'
        ? { code: 1, stdout: '', stderr: 'not a fast-forward' }
        : { code: 0, stdout: '', stderr: '' },
    }));

    await f.service.refreshDeliveries();

    expect(f.service.get(f.itemId)?.cloud?.state).toBe(state);
    expect(f.calls.some((call) => call.argv.includes('merge'))).toBe(merge);
    if (state === 'pulled') {
      expect(f.service.get(f.itemId)?.history.some((event) => event.message?.includes('Đã kéo kết quả cloud về'))).toBe(true);
    }
  });
});

import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { WorkItem } from '../../core/src/messages.js';
import { BUNDLED_AGENTS } from '../src/company/workItems/agentCatalog.js';
import { GIB, SQUAD_SETTINGS_DEFAULT } from '../src/company/workItems/squadSettings.js';
import {
  parseWorkItemsFile,
  WORK_ITEM_REASON,
  type WorkItemsFile,
} from '../src/company/workItems/workItemModel.js';
import { WorkItemService } from '../src/company/workItems/workItemService.js';
import { FakeAgyRuns } from './fakeAgy.js';
import { FakeClaudeAuth, FakeClaudeMcp, FakeClaudeRuns } from './fakeClaude.js';

const T0 = Date.parse('2026-05-01T08:00:00.000Z');
const REPO = '/work/folder/app';
/** The window run output waits for before one status pass covers it. */
const BURST_MS = 1000;

/** In-memory ports for the service. Claude Code runs are driven by the test through `FakeClaudeRuns`. */
class Fixture {
  readonly claude = new FakeClaudeRuns();
  readonly agy = new FakeAgyRuns();
  readonly claudeAuth = new FakeClaudeAuth();
  readonly claudeMcp = new FakeClaudeMcp();
  readonly saves: WorkItemsFile[] = [];
  readonly worktreesMade: string[] = [];
  now = T0;
  private timers: { run: () => void; cancelled: boolean }[] = [];
  readonly service: WorkItemService;

  constructor(saved: WorkItemsFile | null = null) {
    this.service = new WorkItemService('/work/folder', {
      roster: {
        panes: () => ({ available: false, panes: [] }),
        prompt: async () => undefined,
        screenText: async () => '',
      },
      sessions: {
        list: () => [],
        submit: async () => undefined,
        openChat: async () => {
          throw new Error('no omp session in these tests');
        },
        wake: async () => undefined,
        park: async () => true,
      },
      persistence: {
        load: async () => parseWorkItemsFile(saved),
        save: async (file) => {
          this.saves.push(structuredClone(file));
        },
      },
      publish: () => undefined,
      now: () => this.now,
      newId: () => randomUUID(),
      schedule: (run) => {
        const timer = { run, cancelled: false };
        this.timers.push(timer);
        return () => {
          timer.cancelled = true;
        };
      },
      catalog: async () => ({
        repos: [REPO],
        agents: BUNDLED_AGENTS,
        claudeAgents: ['reviewer'],
      }),
      freeMemoryBytes: () => 8 * GIB,
      worktrees: {
        create: async (repo, shortId) => {
          this.worktreesMade.push(shortId);
          return { path: `${repo}/.worktrees/squad-${shortId}`, branch: `squad-${shortId}` };
        },
        remove: async () => 'removed',
      },
      judge: () => new Promise<string>(() => undefined),
      overlaps: async () => [],
      boardWatching: () => false,
      claude: this.claude,
      agy: this.agy,
      claudeAuth: this.claudeAuth,
      claudeMcp: this.claudeMcp,
    });
  }

  /** Moves the clock, runs the checks scheduled so far, and waits for the status pass they start. */
  async elapse(ms: number): Promise<void> {
    this.now += ms;
    const due = this.timers.filter((timer) => !timer.cancelled);
    this.timers = [];
    for (const timer of due) timer.run();
    await this.service.reconcileNow();
  }
}

function itemOf(f: Fixture, id: string): WorkItem {
  const item = f.service.snapshot().items.find((entry) => entry.id === id);
  if (item === undefined) throw new Error(`no work item ${id}`);
  return item;
}

/** The worktree the squad makes for an item of this id in REPO. */
function worktreeOf(id: string): string {
  return `${REPO}/.worktrees/squad-${id.slice(0, 8)}`;
}

type StartRecord = FakeClaudeRuns['starts'][number];

function lastStart(f: Fixture): StartRecord {
  const start = f.claude.starts.at(-1);
  if (start === undefined) throw new Error('no Claude Code run started');
  return start;
}

/** Lets the queued store writes land. Each write waits on the one before it, in microtasks only. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
}

/** A claude item the service dispatches at once, in a repo of the folder. */
function createClaudeItem(f: Fixture, text = 'Sửa form'): Promise<string> {
  return f.service.create({
    requestId: randomUUID(),
    text,
    assignee: { kind: 'claude' },
    repo: REPO,
  });
}

describe('Claude Code runs: start and end', () => {
  it('starts an editing run in the item worktree, with the squad limits', async () => {
    const f = new Fixture();
    await f.service.load();
    const id = await createClaudeItem(f);
    expect(itemOf(f, id)).toMatchObject({
      status: 'running',
      assignee: { kind: 'claude' },
      claudeRun: { mode: 'edit' },
    });
    expect(lastStart(f).input).toMatchObject({
      cwd: worktreeOf(id),
      mode: 'edit',
      resume: false,
      maxTurns: SQUAD_SETTINGS_DEFAULT.claudeMaxTurns,
      maxBudgetUsd: SQUAD_SETTINGS_DEFAULT.claudeMaxBudgetUsd,
    });
    expect(lastStart(f).input.agent).toBeUndefined();
  });

  it('passes the folder permission mode and tool allowlist into an editing run', async () => {
    const f = new Fixture();
    await f.service.load();
    await f.service.setSettings({
      requestId: randomUUID(),
      settings: {
        ...SQUAD_SETTINGS_DEFAULT,
        claudePermission: 'acceptEdits',
        claudeAllowedTools: ['Bash(npm test*)'],
      },
    });
    await createClaudeItem(f);
    expect(lastStart(f).input).toMatchObject({
      permission: 'acceptEdits',
      allowedTools: ['Bash(npm test*)'],
    });
  });

  it('runs a read-only subagent in the repo itself, in plan mode, under that subagent name', async () => {
    const f = new Fixture();
    await f.service.load();
    const id = await f.service.create({
      requestId: randomUUID(),
      text: 'Rà soát',
      assignee: { kind: 'claude' },
      repo: REPO,
      agent: 'reviewer',
    });
    expect(itemOf(f, id)).toMatchObject({ status: 'running' });
    expect(lastStart(f).input).toMatchObject({ cwd: REPO, mode: 'read', agent: 'reviewer' });
    expect(f.worktreesMade).toEqual([]);
  });

  it('shows the run progress on the item while the run goes on', async () => {
    const f = new Fixture();
    await f.service.load();
    const id = await createClaudeItem(f);
    const { runId } = lastStart(f);
    f.claude.open(runId);
    f.claude.progress(runId, 'Đang đọc form.tsx');
    await f.elapse(BURST_MS);
    expect(itemOf(f, id).claudeRun).toMatchObject({ progress: 'Đang đọc form.tsx' });
  });

  it('moves a run that exits cleanly to review, with its result', async () => {
    const f = new Fixture();
    await f.service.load();
    const id = await createClaudeItem(f);
    const { runId } = lastStart(f);
    f.claude.open(runId);
    f.claude.finish(runId, 'Đã sửa form.');
    await f.elapse(BURST_MS);
    expect(itemOf(f, id)).toMatchObject({ status: 'review', result: 'Đã sửa form.' });
  });

  it('fails an item whose run exits with an error, with the reason', async () => {
    const f = new Fixture();
    await f.service.load();
    const id = await createClaudeItem(f);
    const { runId } = lastStart(f);
    f.claude.fail(runId, 'mã thoát 1');
    await f.elapse(BURST_MS);
    expect(itemOf(f, id)).toMatchObject({
      status: 'failed',
      reason: WORK_ITEM_REASON.claudeFailed('mã thoát 1'),
    });
  });

  it('fails an item whose run times out, with the timeout reason', async () => {
    const f = new Fixture();
    await f.service.load();
    const id = await createClaudeItem(f);
    f.claude.timeOut(lastStart(f).runId);
    await f.elapse(BURST_MS);
    expect(itemOf(f, id)).toMatchObject({
      status: 'failed',
      reason: WORK_ITEM_REASON.claudeTimeout,
    });
  });

  it('stops a run in flight when its item is marked failed, and forgets it', async () => {
    const f = new Fixture();
    await f.service.load();
    const id = await createClaudeItem(f);
    const { runId } = lastStart(f);
    await f.service.mark({ requestId: randomUUID(), id, verdict: 'failed' });
    expect(f.claude.killed).toEqual([runId]);
    expect(f.claude.forgotten).toEqual([runId]);
    expect(itemOf(f, id)).toMatchObject({ status: 'failed' });
  });

  it('checks the Claude Code auth status on demand, into the board snapshot', async () => {
    const f = new Fixture();
    await f.service.load();
    f.claudeAuth.set({ state: 'signed_in' });
    await f.service.checkClaude();
    expect(f.claudeAuth.checks).toBe(1);
    expect(f.service.snapshot().claudeStatus).toEqual({ state: 'signed_in' });
  });
});

describe('Claude Code runs: follow-ups, restarts and limits', () => {
  it('resumes the same session on a follow-up once the CLI has opened it', async () => {
    const f = new Fixture();
    await f.service.load();
    const id = await createClaudeItem(f);
    const first = lastStart(f);
    f.claude.open(first.runId);
    await f.elapse(BURST_MS);
    f.claude.finish(first.runId, 'Xong lượt một.');
    await f.elapse(BURST_MS);
    expect(itemOf(f, id)).toMatchObject({ status: 'review' });

    await f.service.followUp({ requestId: randomUUID(), id, text: 'Thêm kiểm thử' });
    const second = lastStart(f);
    expect(f.claude.starts).toHaveLength(2);
    expect(second.input).toMatchObject({
      cwd: worktreeOf(id),
      mode: 'edit',
      resume: true,
      sessionId: first.input.sessionId,
    });
    expect(second.input.prompt).toContain('Thêm kiểm thử');
  });

  it('starts a fresh session on a follow-up when the CLI never opened the first one', async () => {
    const f = new Fixture();
    await f.service.load();
    const id = await createClaudeItem(f);
    const first = lastStart(f);
    f.claude.fail(first.runId, 'không mở được');
    await f.elapse(BURST_MS);
    expect(itemOf(f, id)).toMatchObject({ status: 'failed' });

    await f.service.followUp({ requestId: randomUUID(), id, text: 'Thử lại' });
    const second = lastStart(f);
    expect(second.input.resume).toBe(false);
    expect(second.input.sessionId).not.toBe(first.input.sessionId);
  });

  it('marks a run that was in flight at restart as interrupted, and resumes it on a follow-up', async () => {
    const first = new Fixture();
    await first.service.load();
    const id = await createClaudeItem(first);
    const run = lastStart(first);
    first.claude.open(run.runId);
    await first.elapse(BURST_MS);
    await settle();
    const saved = first.saves.at(-1);
    if (saved === undefined) throw new Error('nothing was saved before the restart');

    first.service.dispose();
    expect(first.claude.killed).toEqual([run.runId]);
    expect(itemOf(first, id)).toMatchObject({ status: 'running' });

    const second = new Fixture(saved);
    await second.service.load();
    expect(itemOf(second, id)).toMatchObject({
      status: 'failed',
      reason: WORK_ITEM_REASON.claudeInterrupted,
      claudeRun: { interrupted: true, sessionId: run.input.sessionId },
    });

    await second.service.followUp({ requestId: randomUUID(), id, text: 'Tiếp tục' });
    expect(lastStart(second).input).toMatchObject({
      resume: true,
      sessionId: run.input.sessionId,
    });
  });

  it('keeps at most maxClaudeRuns runs at once; the next item waits for a slot', async () => {
    const f = new Fixture();
    await f.service.load();
    await f.service.setSettings({
      requestId: randomUUID(),
      settings: { ...SQUAD_SETTINGS_DEFAULT, maxClaudeRuns: 1 },
    });
    const first = await createClaudeItem(f, 'Việc một');
    const second = await createClaudeItem(f, 'Việc hai');
    expect(itemOf(f, first)).toMatchObject({ status: 'running' });
    expect(itemOf(f, second)).toMatchObject({
      status: 'queued',
      blocker: { kind: 'capacity' },
    });
    expect(f.claude.starts).toHaveLength(1);

    f.claude.finish(lastStart(f).runId, 'Xong.');
    await f.elapse(BURST_MS);
    expect(itemOf(f, first)).toMatchObject({ status: 'review' });
    expect(itemOf(f, second)).toMatchObject({ status: 'running' });
    expect(f.claude.starts).toHaveLength(2);
  });

  it('takes a Claude Code run for an auto item when Claude is selected', async () => {
    const f = new Fixture();
    await f.service.load();
    await f.service.setSettings({
      requestId: randomUUID(),
      settings: { ...SQUAD_SETTINGS_DEFAULT, engineWorker: 'claude' },
    });
    const id = await f.service.create({
      requestId: randomUUID(),
      text: 'Tự chọn',
      assignee: { kind: 'auto' },
      repo: REPO,
    });
    expect(itemOf(f, id)).toMatchObject({ status: 'running', assignee: { kind: 'claude' } });
  });
  it('runs an auto item through agy and publishes progress and result', async () => {
    const f = new Fixture();
    await f.service.load();
    await f.service.setSettings({
      requestId: randomUUID(),
      settings: { ...SQUAD_SETTINGS_DEFAULT, engineWorker: 'agy', maxAgyRuns: 1 },
    });
    const id = await f.service.create({
      requestId: randomUUID(),
      text: 'Tự chọn',
      assignee: { kind: 'auto' },
      repo: REPO,
    });

    expect(itemOf(f, id)).toMatchObject({
      status: 'running',
      assignee: { kind: 'agy' },
      agyRun: { mode: 'edit', pid: 5001 },
    });
    expect(f.agy.starts[0]?.input).toEqual({
      cwd: worktreeOf(id),
      prompt: expect.stringContaining('Tự chọn'),
    });

    f.agy.progress('agy-run-1', 'agent_response: Đang làm');
    await f.elapse(BURST_MS);
    expect(itemOf(f, id)).toMatchObject({ agyRun: { progress: 'agent_response: Đang làm' } });

    f.agy.finish('agy-run-1', 'Đã xong');
    await f.elapse(BURST_MS);
    expect(itemOf(f, id)).toMatchObject({ status: 'review', result: 'Đã xong' });
  });
  it('continues the agy conversation on a follow-up, so the agent keeps the task', async () => {
    const f = new Fixture();
    await f.service.load();
    await f.service.setSettings({
      requestId: randomUUID(),
      settings: { ...SQUAD_SETTINGS_DEFAULT, engineWorker: 'agy', maxAgyRuns: 1 },
    });
    const id = await f.service.create({ requestId: randomUUID(), text: 'Sửa lỗi đăng nhập', assignee: { kind: 'auto' }, repo: REPO });
    f.agy.conversation('agy-run-1', 'conv-1');
    f.agy.finish('agy-run-1', 'Đã sửa');
    await f.elapse(BURST_MS);
    expect(itemOf(f, id)).toMatchObject({ status: 'review', agyRun: { conversationId: 'conv-1' } });

    await f.service.followUp({ requestId: randomUUID(), id, text: 'Nêu file đã sửa và lệnh đã chạy' });
    expect(f.agy.starts[1]?.input).toMatchObject({ conversationId: 'conv-1', prompt: expect.stringContaining('Nêu file đã sửa') });
    // The first run had no conversation to continue.
    expect(f.agy.starts[0]?.input.conversationId).toBeUndefined();
  });
  it('stops the agy worker when the board is disposed', async () => {
    const f = new Fixture();
    await f.service.load();
    await f.service.setSettings({
      requestId: randomUUID(),
      settings: { ...SQUAD_SETTINGS_DEFAULT, engineWorker: 'agy' },
    });
    const id = await f.service.create({
      requestId: randomUUID(),
      text: 'Dừng khi đóng board',
      assignee: { kind: 'auto' },
      repo: REPO,
    });

    expect(itemOf(f, id)).toMatchObject({ status: 'running', assignee: { kind: 'agy' } });
    f.service.dispose();

    expect(f.agy.killed).toEqual(['agy-run-1']);
  });
});

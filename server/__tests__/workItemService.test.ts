import { randomUUID } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import type {
  CompanyWorkItemsMessage,
  HerdrAgent,
  OmpAgentInfo,
  WorkItem,
  WorkItemAssignee,
} from '../../core/src/messages.js';
import { CompanyError } from '../src/company/companyError.js';
import { BUNDLED_AGENTS } from '../src/company/workItems/agentCatalog.js';
import { composeDispatchPrompt } from '../src/company/workItems/dispatchPrompt.js';
import { GIB, SQUAD_SETTINGS_DEFAULT } from '../src/company/workItems/squadSettings.js';
import {
  parseWorkItemsFile,
  WORK_ITEM_FINISHED_KEEP,
  WORK_ITEM_GRACE_MS,
  WORK_ITEM_HOLD_RETRY_MS,
  WORK_ITEM_REASON,
  WORK_ITEM_TEXT_MAX_BYTES,
  type WorkItemDraft,
  type WorkItemsFile,
} from '../src/company/workItems/workItemModel.js';
import {
  type WorkItemPaneView,
  WorkItemService,
  type WorkItemSessionView,
} from '../src/company/workItems/workItemService.js';
import { LIBRARY_WORK_ITEM_ARCHIVE_AGE_MS } from '../src/library/storageHelpers.js';
import { FakeAgyRuns } from './fakeAgy.js';
import { FakeClaudeAuth, FakeClaudeMcp, FakeClaudeRuns } from './fakeClaude.js';
const T0 = Date.parse('2026-05-01T08:00:00.000Z');
const PANE_A = 'wA:p1';
const PANE_B = 'wA:p2';

const REPO = '/work/folder/app';

/** The prompt a plain item owes its agent: its text, the safe-work block, then acceptance. */
function promptOf(text: string, acceptance?: string): string {
  return composeDispatchPrompt({ text, acceptance, readOnly: false });
}

type PaneStatus = HerdrAgent['status'];

interface PaneState {
  paneId: string;
  status: PaneStatus;
  cwd?: string;
  kind?: string;
}

interface Timer {
  run: () => void;
  cancelled: boolean;
}

/** In-memory ports. Time moves only through `elapse`, and scheduled checks run only when it is called. */
class Fixture {
  readonly panes: PaneState[] = [];
  herdrAvailable = true;
  readonly prompts: { paneId: string; text: string }[] = [];
  promptError: Error | null = null;
  screen = '';
  /** The agent's last reply from its transcript; undefined = the transcript is unknown. */
  reply: string | undefined = undefined;
  readonly sessions: WorkItemSessionView[] = [];
  readonly submits: { sessionId: string; text: string; mode: 'chat' | 'company' }[] = [];
  chatsOpened = 0;
  readonly openedWith: { cwd: string; role: string }[] = [];
  poolFull = false;
  readonly worktreesMade: { repo: string; shortId: string }[] = [];
  worktreeError: Error | null = null;
  /** Whether a made worktree's directory is still on disk. */
  worktreeOnDisk = true;
  /** While set, making a worktree waits on it: a slow `git worktree add`. */
  worktreeGate: Promise<void> | null = null;
  readonly saves: WorkItemsFile[] = [];
  saveError: Error | null = null;
  repos: string[] = [];
  agents: readonly OmpAgentInfo[] = BUNDLED_AGENTS;
  freeBytes = 8 * GIB;
  readonly published: CompanyWorkItemsMessage[] = [];
  now = T0;
  readonly claude = new FakeClaudeRuns();
  readonly agy = new FakeAgyRuns();
  readonly claudeAuth = new FakeClaudeAuth();
  readonly claudeMcp = new FakeClaudeMcp();
  private timers: Timer[] = [];
  readonly service: WorkItemService;

  constructor() {
    this.service = new WorkItemService('/work/folder', {
      roster: {
        panes: () => ({
          available: this.herdrAvailable,
          panes: this.panes.map((pane): WorkItemPaneView => ({ ...pane })),
        }),
        prompt: async (paneId, text) => {
          if (this.promptError !== null) throw this.promptError;
          this.prompts.push({ paneId, text });
        },
        screenText: async () => this.screen,
        lastReply: async () => this.reply,
      },
      sessions: {
        list: () => this.sessions.map((session) => ({ ...session })),
        submit: async (sessionId, text, mode) => {
          this.submits.push({ sessionId, text, mode });
        },
        wake: async () => undefined,
        park: async () => true,
        openChat: async (input) => {
          if (this.poolFull) {
            throw new CompanyError('company_pool_full', 'Đã đủ phiên omp đang chạy.');
          }
          this.chatsOpened += 1;
          const id = `chat-${this.chatsOpened}`;
          this.openedWith.push({ cwd: input.cwd, role: input.role });
          this.sessions.push({ id, status: 'idle', role: input.role, cwd: input.cwd });
          return id;
        },
      },
      persistence: {
        load: async () => parseWorkItemsFile(null),
        save: async (file) => {
          if (this.saveError !== null) throw this.saveError;
          this.saves.push(structuredClone(file));
        },
      },
      publish: (message) => {
        this.published.push(message);
      },
      now: () => this.now,
      newId: () => randomUUID(),
      schedule: (run) => {
        const timer: Timer = { run, cancelled: false };
        this.timers.push(timer);
        return () => {
          timer.cancelled = true;
        };
      },
      catalog: async () => ({ repos: this.repos, agents: this.agents, claudeAgents: [] }),
      freeMemoryBytes: () => this.freeBytes,
      worktrees: {
        create: async (repo, shortId) => {
          if (this.worktreeError !== null) throw this.worktreeError;
          if (this.worktreeGate !== null) await this.worktreeGate;
          this.worktreesMade.push({ repo, shortId });
          return { path: `${repo}/.worktrees/squad-${shortId}`, branch: `squad-${shortId}` };
        },
        remove: async () => 'removed',
        exists: () => this.worktreeOnDisk,
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

  /** Moves the clock forward and runs every scheduled check still pending, then waits for the pass. */
  async elapse(ms: number): Promise<void> {
    this.now += ms;
    const due = this.timers.filter((timer) => !timer.cancelled);
    this.timers = [];
    for (const timer of due) timer.run();
    await this.service.reconcileNow();
  }

  setPane(paneId: string, status: PaneStatus): void {
    const pane = this.panes.find((entry) => entry.paneId === paneId);
    if (pane === undefined) throw new Error(`no pane ${paneId}`);
    pane.status = status;
  }
}

function herdr(paneId: string): WorkItemAssignee {
  return { kind: 'herdr', paneId };
}

/** The worktree the squad makes for an item of this id in REPO. */
function worktreeOf(id: string): string {
  return `${REPO}/.worktrees/squad-${id.slice(0, 8)}`;
}

function itemOf(f: Fixture, id: string): WorkItem {
  const item = f.service.snapshot().items.find((entry) => entry.id === id);
  if (item === undefined) throw new Error(`no work item ${id}`);
  return item;
}

async function openFixture(): Promise<Fixture> {
  const f = new Fixture();
  await f.service.load();
  return f;
}

describe('WorkItemService: dispatch and status', () => {
  it('sends a fresh item to a free pane and reviews it with the screen as its result', async () => {
    const f = await openFixture();
    f.panes.push({ paneId: PANE_A, status: 'idle' });
    const id = await f.service.create({
      requestId: randomUUID(),
      text: 'Sửa lỗi đăng nhập',
      assignee: herdr(PANE_A),
    });

    expect(f.prompts).toEqual([{ paneId: PANE_A, text: promptOf('Sửa lỗi đăng nhập') }]);
    expect(itemOf(f, id).status).toBe('running');

    f.setPane(PANE_A, 'working');
    await f.service.reconcileNow();
    expect(itemOf(f, id).status).toBe('running');

    f.setPane(PANE_A, 'idle');
    f.screen = '\nBước 1\n\nXong\n';
    await f.service.reconcileNow();
    expect(itemOf(f, id)).toMatchObject({ status: 'review', result: 'Bước 1\nXong' });
  });

  it('takes the agent reply from its transcript over the screen, which holds only the input box', async () => {
    const f = await openFixture();
    f.panes.push({ paneId: PANE_A, status: 'idle' });
    const id = await f.service.create({ requestId: randomUUID(), text: 'Khảo sát', assignee: herdr(PANE_A) });
    f.setPane(PANE_A, 'working');
    await f.service.reconcileNow();
    f.setPane(PANE_A, 'idle');
    f.screen = '❯\n auto mode on';
    f.reply = '## Báo cáo\n- route POST /api/v1/x';
    await f.service.reconcileNow();
    expect(itemOf(f, id)).toMatchObject({ status: 'review', result: '## Báo cáo\n- route POST /api/v1/x' });
  });

  it('asks a Claude pane to take the role, never the omp task tool it does not have', async () => {
    const f = await openFixture();
    f.panes.push({ paneId: PANE_A, status: 'idle', kind: 'claude' });
    await f.service.create({ requestId: randomUUID(), text: 'Khảo sát', assignee: herdr(PANE_A), agent: 'scout' });
    expect(f.prompts[0]?.text).toContain('subagent `Explore` của Claude Code (vai trò scout)');
    expect(f.prompts[0]?.text).not.toContain('subagent omp');
  });

  it('judges again a review item on its saved result: its pane may already run other work', async () => {
    const f = await openFixture();
    f.panes.push({ paneId: PANE_A, status: 'idle' });
    const id = await f.service.create({ requestId: randomUUID(), text: 'Khảo sát', assignee: herdr(PANE_A) });
    f.setPane(PANE_A, 'working');
    await f.service.reconcileNow();
    f.setPane(PANE_A, 'idle');
    f.screen = '❯';
    await f.service.reconcileNow();
    expect(itemOf(f, id).result).toBe('❯');
    f.reply = '## Báo cáo đầy đủ';
    await f.service.judgeAgain({ requestId: randomUUID(), id });
    expect(itemOf(f, id)).toMatchObject({ status: 'review', result: '❯', judge: { status: 'running' } });
  });

  it('queues a second item behind a busy agent and sends it when the agent frees up', async () => {
    const f = await openFixture();
    f.panes.push({ paneId: PANE_A, status: 'idle' });
    const first = await f.service.create({
      requestId: randomUUID(),
      text: 'A',
      assignee: herdr(PANE_A),
    });
    f.setPane(PANE_A, 'working');
    const second = await f.service.create({
      requestId: randomUUID(),
      text: 'B',
      assignee: herdr(PANE_A),
    });

    expect(itemOf(f, second)).toMatchObject({ status: 'queued', reason: WORK_ITEM_REASON.queued });

    f.setPane(PANE_A, 'idle');
    await f.service.reconcileNow();

    expect(itemOf(f, first).status).toBe('review');
    expect(itemOf(f, second).status).toBe('running');
    expect(f.prompts.map((prompt) => prompt.text)).toEqual([promptOf('A'), promptOf('B')]);
  });

  it('moves a running item to needs_input when the pane blocks, and back when it works again', async () => {
    const f = await openFixture();
    f.panes.push({ paneId: PANE_A, status: 'idle' });
    const id = await f.service.create({
      requestId: randomUUID(),
      text: 'Hỏi',
      assignee: herdr(PANE_A),
    });

    f.setPane(PANE_A, 'blocked');
    await f.service.reconcileNow();
    expect(itemOf(f, id)).toMatchObject({
      status: 'needs_input',
      reason: WORK_ITEM_REASON.needsInputHerdr,
    });

    f.setPane(PANE_A, 'working');
    await f.service.reconcileNow();
    expect(itemOf(f, id).status).toBe('running');
    expect(itemOf(f, id).reason).toBeUndefined();
  });

  it('reviews a dispatched item after the grace window when the agent never looked busy', async () => {
    const f = await openFixture();
    f.panes.push({ paneId: PANE_A, status: 'idle' });
    const id = await f.service.create({
      requestId: randomUUID(),
      text: 'Nhanh',
      assignee: herdr(PANE_A),
    });

    await f.service.reconcileNow();
    expect(itemOf(f, id).status).toBe('running');

    await f.elapse(WORK_ITEM_GRACE_MS);
    expect(itemOf(f, id).status).toBe('review');
  });

  it('tells listeners of each change, and of each item that reaches review', async () => {
    const f = await openFixture();
    f.panes.push({ paneId: PANE_A, status: 'idle' });
    let changes = 0;
    const reviewed: string[] = [];
    const stopChanges = f.service.onChange(() => {
      changes += 1;
    });
    const stopReviews = f.service.onItemSettled((item) => {
      if (item.status === 'review') reviewed.push(item.id);
    });
    const id = await f.service.create({ requestId: randomUUID(), text: 'Nhanh', assignee: herdr(PANE_A) });
    expect(changes).toBeGreaterThan(0);

    await f.service.reconcileNow();
    await f.elapse(WORK_ITEM_GRACE_MS);
    expect(reviewed).toEqual([id]);

    stopChanges();
    stopReviews();
    const before = changes;
    await f.service.reconcileNow();
    expect(changes).toBe(before);
  });

  it('fails every live item of a pane that disappears from herdr', async () => {
    const f = await openFixture();
    f.panes.push({ paneId: PANE_A, status: 'working' });
    const first = await f.service.create({
      requestId: randomUUID(),
      text: 'A',
      assignee: herdr(PANE_A),
    });
    const second = await f.service.create({
      requestId: randomUUID(),
      text: 'B',
      assignee: herdr(PANE_A),
    });

    f.panes.splice(0, f.panes.length);
    await f.service.reconcileNow();

    expect(itemOf(f, first)).toMatchObject({
      status: 'failed',
      reason: WORK_ITEM_REASON.herdrGone,
    });
    expect(itemOf(f, second)).toMatchObject({
      status: 'failed',
      reason: WORK_ITEM_REASON.herdrGone,
    });
  });

  it('fails the item with the send error when herdr refuses the prompt', async () => {
    const f = await openFixture();
    f.panes.push({ paneId: PANE_A, status: 'idle' });
    f.promptError = new Error('pane closed');
    const id = await f.service.create({
      requestId: randomUUID(),
      text: 'Gửi',
      assignee: herdr(PANE_A),
    });

    expect(itemOf(f, id)).toMatchObject({
      status: 'failed',
      reason: WORK_ITEM_REASON.sendFailed('pane closed'),
    });
  });

  it('stops scheduling checks once disposed', async () => {
    const f = await openFixture();
    f.panes.push({ paneId: PANE_A, status: 'idle' });
    const id = await f.service.create({
      requestId: randomUUID(),
      text: 'Dừng',
      assignee: herdr(PANE_A),
    });

    f.service.dispose();
    await f.elapse(WORK_ITEM_GRACE_MS);
    expect(itemOf(f, id).status).toBe('running');
  });
});

describe('WorkItemService: commands', () => {
  it('answers a resent create with the first item and sends nothing twice', async () => {
    const f = await openFixture();
    f.panes.push({ paneId: PANE_A, status: 'idle' });
    const requestId = randomUUID();
    const first = await f.service.create({ requestId, text: 'Một lần', assignee: herdr(PANE_A) });
    const again = await f.service.create({ requestId, text: 'Một lần', assignee: herdr(PANE_A) });

    expect(again).toBe(first);
    expect(f.service.snapshot().items).toHaveLength(1);
    expect(f.prompts).toHaveLength(1);
  });

  it('creates a squad run once, keyed by its run id', async () => {
    const f = await openFixture();
    f.panes.push({ paneId: PANE_A, status: 'working' });
    const squadRunId = randomUUID();
    const drafts = [
      { text: 'Bước 1', assignee: herdr(PANE_A) },
      { text: 'Bước 2', assignee: herdr(PANE_A) },
    ];

    const ids = await f.service.createWorkItems(drafts, { squadRunId });
    const again = await f.service.createWorkItems(drafts, { squadRunId });

    expect(ids).toHaveLength(2);
    expect(again).toEqual(ids);
    expect(f.service.snapshot().items).toHaveLength(2);
    expect(f.service.snapshot().items.every((item) => item.squadRunId === squadRunId)).toBe(true);
  });

  it('refuses a squad run id that is not a UUID', async () => {
    const f = await openFixture();
    await expect(f.service.createWorkItems([], { squadRunId: 'not-a-uuid' })).rejects.toMatchObject(
      { code: 'invalid_request' },
    );
  });

  it('refuses a create it cannot deliver and stores nothing', async () => {
    const f = await openFixture();
    f.panes.push({ paneId: PANE_A, status: 'idle' });
    const requestId = randomUUID();

    await expect(
      f.service.create({ requestId, text: 'x', assignee: herdr('wA:p9') }),
    ).rejects.toMatchObject({ code: 'assignee_unknown' });

    f.herdrAvailable = false;
    await expect(
      f.service.create({ requestId, text: 'x', assignee: herdr(PANE_A) }),
    ).rejects.toMatchObject({ code: 'herdr_unavailable' });
    f.herdrAvailable = true;

    await expect(
      f.service.create({ requestId, text: '   ', assignee: herdr(PANE_A) }),
    ).rejects.toMatchObject({ code: 'empty_text' });

    const oversized = 'x'.repeat(WORK_ITEM_TEXT_MAX_BYTES + 1);
    await expect(
      f.service.create({ requestId, text: oversized, assignee: herdr(PANE_A) }),
    ).rejects.toMatchObject({ code: 'prompt_too_large' });

    expect(f.service.snapshot().items).toHaveLength(0);
    expect(f.prompts).toHaveLength(0);
  });

  it('refuses a follow-up on a running item and sends one to a reviewed item', async () => {
    const f = await openFixture();
    f.panes.push({ paneId: PANE_A, status: 'idle' });
    const id = await f.service.create({
      requestId: randomUUID(),
      text: 'Đầu',
      assignee: herdr(PANE_A),
    });

    await expect(
      f.service.followUp({ requestId: randomUUID(), id, text: 'Sớm' }),
    ).rejects.toMatchObject({ code: 'work_item_busy' });

    f.setPane(PANE_A, 'working');
    await f.service.reconcileNow();
    f.setPane(PANE_A, 'idle');
    await f.service.reconcileNow();
    expect(itemOf(f, id).status).toBe('review');

    await f.service.followUp({ requestId: randomUUID(), id, text: 'Thêm chi tiết' });
    expect(f.prompts.at(-1)).toEqual({ paneId: PANE_A, text: promptOf('Thêm chi tiết') });
    expect(itemOf(f, id).status).toBe('running');
  });

  it('refuses reassigning a running item and cancels only a queued one', async () => {
    const f = await openFixture();
    f.panes.push({ paneId: PANE_A, status: 'idle' }, { paneId: PANE_B, status: 'idle' });
    const running = await f.service.create({
      requestId: randomUUID(),
      text: 'Chạy',
      assignee: herdr(PANE_A),
    });
    f.setPane(PANE_A, 'working');
    await f.service.reconcileNow();
    const queued = await f.service.create({
      requestId: randomUUID(),
      text: 'Chờ',
      assignee: herdr(PANE_A),
    });

    await expect(
      f.service.assign({ requestId: randomUUID(), id: running, assignee: herdr(PANE_B) }),
    ).rejects.toMatchObject({ code: 'work_item_busy' });
    await expect(f.service.cancel({ requestId: randomUUID(), id: running })).rejects.toMatchObject({
      code: 'work_item_busy',
    });

    await f.service.cancel({ requestId: randomUUID(), id: queued });
    expect(f.service.snapshot().items.map((item) => item.id)).toEqual([running]);
  });

  it('removes a finished item from the board, which a running one refuses', async () => {
    const f = await openFixture();
    f.panes.push({ paneId: PANE_A, status: 'idle' });
    const id = await f.service.create({ requestId: randomUUID(), text: 'Hỏng', assignee: herdr(PANE_A) });
    f.setPane(PANE_A, 'working');
    await f.service.reconcileNow();
    await expect(f.service.cancel({ requestId: randomUUID(), id })).rejects.toMatchObject({
      code: 'work_item_busy',
    });

    await f.service.mark({ requestId: randomUUID(), id, verdict: 'failed' });
    await f.service.cancel({ requestId: randomUUID(), id });
    expect(f.service.snapshot().items).toEqual([]);
  });

  it('keeps an agent note in the history without changing the status, and refuses an empty one', async () => {
    const f = await openFixture();
    f.panes.push({ paneId: PANE_A, status: 'idle' });
    const id = await f.service.create({ requestId: randomUUID(), text: 'Làm', assignee: herdr(PANE_A) });
    const before = itemOf(f, id).status;
    await f.service.note({ requestId: randomUUID(), id, text: '  xong API, đang viết test  ' });
    expect(itemOf(f, id).status).toBe(before);
    expect(itemOf(f, id).history.at(-1)).toMatchObject({ kind: 'note', message: 'Agent báo: xong API, đang viết test' });
    await expect(f.service.note({ requestId: randomUUID(), id, text: ' ' })).rejects.toMatchObject({ code: 'work_item_note' });
  });

  it('records a verdict without sending anything to an agent', async () => {
    const f = await openFixture();
    f.panes.push({ paneId: PANE_A, status: 'idle' });
    const id = await f.service.create({
      requestId: randomUUID(),
      text: 'Xong',
      assignee: herdr(PANE_A),
    });
    f.setPane(PANE_A, 'working');
    await f.service.reconcileNow();
    f.setPane(PANE_A, 'idle');
    await f.service.reconcileNow();

    await f.service.mark({ requestId: randomUUID(), id, verdict: 'done' });
    expect(itemOf(f, id).status).toBe('done');
    expect(f.prompts).toHaveLength(1);

    await expect(
      f.service.mark({ requestId: randomUUID(), id, verdict: 'failed' }),
    ).rejects.toBeInstanceOf(CompanyError);
    await expect(
      f.service.mark({ requestId: randomUUID(), id, verdict: 'done' }),
    ).rejects.toMatchObject({ code: 'work_item_status' });
  });

  it('hides old finished items from the board and restores them through the service store', async () => {
    const f = await openFixture();
    const id = await f.service.create({
      requestId: randomUUID(),
      text: 'Lưu trữ',
      assignee: { kind: 'new-session' },
    });
    await f.service.mark({ requestId: randomUUID(), id, verdict: 'done' });
    f.now += LIBRARY_WORK_ITEM_ARCHIVE_AGE_MS + 1;

    expect(f.service.snapshot().items).toHaveLength(0);
    expect(f.service.archivedItems().map((item) => item.id)).toEqual([id]);
    await f.service.restore(id);

    expect(f.service.snapshot().items.map((item) => item.id)).toEqual([id]);
    expect(f.saves.at(-1)?.items.find((item) => item.id === id)?.restoredAt).toBe(new Date(f.now).toISOString());
  });

  it('saves and clears role notes, and refuses a new-session role or an overlong one', async () => {
    const f = await openFixture();
    await f.service.setRole({
      requestId: randomUUID(),
      agent: herdr(PANE_A),
      description: 'Chuyên kiểm thử',
    });
    expect(f.service.snapshot().roles).toEqual([
      expect.objectContaining({ agent: herdr(PANE_A), description: 'Chuyên kiểm thử' }),
    ]);

    await f.service.setRole({ requestId: randomUUID(), agent: herdr(PANE_A), description: '' });
    expect(f.service.snapshot().roles).toEqual([]);

    await expect(
      f.service.setRole({
        requestId: randomUUID(),
        agent: { kind: 'new-session' },
        description: 'x',
      }),
    ).rejects.toMatchObject({ code: 'assignee_invalid' });

    await expect(
      f.service.setRole({
        requestId: randomUUID(),
        agent: herdr(PANE_A),
        description: 'x'.repeat(1001),
      }),
    ).rejects.toMatchObject({ code: 'role_invalid' });
  });

  it('opens a chat for a new-session item and sends it there in chat mode', async () => {
    const f = await openFixture();
    const id = await f.service.create({
      requestId: randomUUID(),
      text: 'Việc mới',
      assignee: { kind: 'new-session' },
    });

    expect(f.chatsOpened).toBe(1);
    expect(itemOf(f, id)).toMatchObject({
      status: 'running',
      assignee: { kind: 'session', sessionId: 'chat-1' },
    });
    expect(f.submits).toEqual([
      { sessionId: 'chat-1', text: promptOf('Việc mới'), mode: 'chat' },
    ]);
    // The chat opened mid-pass is judged on the next pass, not failed or re-sent.
    await f.service.reconcileNow();
    expect(itemOf(f, id)).toMatchObject({
      status: 'running',
      assignee: { kind: 'session', sessionId: 'chat-1' },
    });
    expect(f.submits).toHaveLength(1);
  });

  it('sends to a worker session in company mode', async () => {
    const f = await openFixture();
    f.sessions.push({ id: 's-worker', status: 'idle', role: 'worker' });
    const id = await f.service.create({
      requestId: randomUUID(),
      text: 'Cho worker',
      assignee: { kind: 'session', sessionId: 's-worker' },
    });

    expect(itemOf(f, id).status).toBe('running');
    expect(f.submits).toEqual([
      { sessionId: 's-worker', text: promptOf('Cho worker'), mode: 'company' },
    ]);
  });

  it('sends nothing and keeps nothing when the new item cannot be saved', async () => {
    const f = await openFixture();
    f.panes.push({ paneId: PANE_A, status: 'idle' });
    f.saveError = new Error('disk full');

    await expect(
      f.service.create({ requestId: randomUUID(), text: 'Lưu', assignee: herdr(PANE_A) }),
    ).rejects.toMatchObject({ code: 'company_command_failed' });
    // Later passes, once the disk is back, must not send the refused item either.
    f.saveError = null;
    await f.service.reconcileNow();
    expect(f.prompts).toEqual([]);
    expect(f.service.snapshot().items).toEqual([]);
  });

  it('sends no follow-up and restores the item when the follow-up cannot be saved', async () => {
    const f = await openFixture();
    f.panes.push({ paneId: PANE_A, status: 'idle' });
    const id = await f.service.create({
      requestId: randomUUID(),
      text: 'Đầu',
      assignee: herdr(PANE_A),
    });
    f.setPane(PANE_A, 'working');
    await f.service.reconcileNow();
    f.setPane(PANE_A, 'idle');
    await f.service.reconcileNow();
    expect(itemOf(f, id).status).toBe('review');

    f.saveError = new Error('disk full');
    await expect(
      f.service.followUp({ requestId: randomUUID(), id, text: 'Thêm' }),
    ).rejects.toMatchObject({ code: 'company_command_failed' });
    f.saveError = null;
    await f.service.reconcileNow();
    expect(f.prompts.map((prompt) => prompt.text)).toEqual([promptOf('Đầu')]);
    expect(itemOf(f, id).status).toBe('review');
  });

  it('creates the item but sends nothing when only the save before sending fails', async () => {
    const f = await openFixture();
    f.panes.push({ paneId: PANE_A, status: 'idle' });
    // The item itself saves; every later save (the running state before sending) fails.
    const firstSave = f.saves.length + 1;
    Object.defineProperty(f, 'saveError', {
      get: () => (f.saves.length >= firstSave ? new Error('disk full') : null),
      configurable: true,
    });

    const id = await f.service.create({
      requestId: randomUUID(),
      text: 'Lưu rồi',
      assignee: herdr(PANE_A),
    });

    expect(f.prompts).toEqual([]);
    expect(itemOf(f, id)).toMatchObject({ status: 'queued', reason: WORK_ITEM_REASON.saveFailed });
    await f.service.reconcileNow();
    expect(f.prompts).toEqual([]);
  });

  it('does not send a queued item while its running state cannot be saved', async () => {
    const f = await openFixture();
    f.panes.push({ paneId: PANE_A, status: 'working' });
    const id = await f.service.create({
      requestId: randomUUID(),
      text: 'Chờ',
      assignee: herdr(PANE_A),
    });
    expect(itemOf(f, id).status).toBe('queued');

    f.saveError = new Error('disk full');
    f.setPane(PANE_A, 'idle');
    await f.service.reconcileNow();
    expect(f.prompts).toEqual([]);
    expect(itemOf(f, id)).toMatchObject({ status: 'queued', reason: WORK_ITEM_REASON.saveFailed });

    f.saveError = null;
    await f.service.reconcileNow();
    expect(f.prompts).toEqual([{ paneId: PANE_A, text: promptOf('Chờ') }]);
    expect(itemOf(f, id).status).toBe('running');
  });

  it('publishes the whole folder and saves it after every change', async () => {
    const f = await openFixture();
    f.panes.push({ paneId: PANE_A, status: 'idle' });
    await f.service.create({ requestId: randomUUID(), text: 'Phát', assignee: herdr(PANE_A) });

    const last = f.published.at(-1);
    expect(last).toMatchObject({ type: 'companyWorkItems', workspacePath: '/work/folder' });
    expect(last?.items).toHaveLength(1);
    expect(last?.revision).toBe(f.service.snapshot().revision);
    expect(f.saves.at(-1)?.items).toHaveLength(1);
  });
});

describe('WorkItemService: priority, waits, and acceptance', () => {
  it('sends the acceptance after the text and keeps the item text plain', async () => {
    const f = await openFixture();
    f.panes.push({ paneId: PANE_A, status: 'idle' });
    const id = await f.service.create({
      requestId: randomUUID(),
      text: 'Sửa lỗi đăng nhập',
      assignee: herdr(PANE_A),
      acceptance: 'Đăng nhập được bằng mật khẩu mới',
    });
    expect(f.prompts).toEqual([
      { paneId: PANE_A, text: promptOf('Sửa lỗi đăng nhập', 'Đăng nhập được bằng mật khẩu mới') },
    ]);
    expect(itemOf(f, id)).toMatchObject({
      text: 'Sửa lỗi đăng nhập',
      acceptance: 'Đăng nhập được bằng mật khẩu mới',
      priority: 2,
    });
  });

  it('refuses a priority outside P0 to P3 and sends nothing', async () => {
    const f = await openFixture();
    f.panes.push({ paneId: PANE_A, status: 'idle' });
    await expect(
      f.service.create({ requestId: randomUUID(), text: 'Việc', assignee: herdr(PANE_A), priority: 4 }),
    ).rejects.toMatchObject({ code: 'priority_invalid' });
    expect(f.prompts).toEqual([]);
    expect(f.service.snapshot().items).toEqual([]);
  });

  it('takes the queue by priority, then by creation, as the agent frees up', async () => {
    const f = await openFixture();
    f.panes.push({ paneId: PANE_A, status: 'working' });
    await f.service.create({ requestId: randomUUID(), text: 'Thường một', assignee: herdr(PANE_A), priority: 1 });
    await f.service.create({ requestId: randomUUID(), text: 'Thường hai', assignee: herdr(PANE_A), priority: 1 });
    const urgent = await f.service.create({
      requestId: randomUUID(),
      text: 'Gấp',
      assignee: herdr(PANE_A),
      priority: 0,
    });
    expect(f.prompts).toEqual([]);
    expect(itemOf(f, urgent)).toMatchObject({
      status: 'queued',
      blocker: { kind: 'agent' },
      reason: 'Chờ agent rảnh để nhận việc.',
    });

    f.setPane(PANE_A, 'idle');
    await f.service.reconcileNow();
    expect(f.prompts.map((prompt) => prompt.text)).toEqual([promptOf('Gấp')]);
    await f.service.mark({ requestId: randomUUID(), id: urgent, verdict: 'done' });
    expect(f.prompts.map((prompt) => prompt.text)).toEqual([promptOf('Gấp'), promptOf('Thường một')]);
  });

  it('passes over a blocked item for a ready one, and sends the blocked one once its wait ends', async () => {
    const f = await openFixture();
    f.panes.push({ paneId: PANE_A, status: 'idle' }, { paneId: PANE_B, status: 'idle' });
    const wait = await f.service.create({ requestId: randomUUID(), text: 'Nền', assignee: herdr(PANE_B) });
    const current = await f.service.create({ requestId: randomUUID(), text: 'Đang làm', assignee: herdr(PANE_A) });
    const blocked = await f.service.create({
      requestId: randomUUID(),
      text: 'Gấp chờ nền',
      assignee: herdr(PANE_A),
      priority: 0,
      dependsOn: [wait],
    });
    await f.service.create({ requestId: randomUUID(), text: 'Thường', assignee: herdr(PANE_A), priority: 3 });
    expect(f.prompts.map((prompt) => prompt.text)).toEqual([promptOf('Nền'), promptOf('Đang làm')]);
    expect(itemOf(f, blocked)).toMatchObject({
      status: 'queued',
      blocker: { kind: 'dependency', sequence: itemOf(f, wait).sequence },
    });

    // The current item finishes: the blocked item still waits, so the ready one goes first.
    await f.service.mark({ requestId: randomUUID(), id: current, verdict: 'done' });
    expect(f.prompts.map((prompt) => prompt.text)).toEqual([
      promptOf('Nền'),
      promptOf('Đang làm'),
      promptOf('Thường'),
    ]);
    expect(itemOf(f, blocked).status).toBe('queued');

    // The agent must be seen working before its finished item counts as done.
    f.setPane(PANE_A, 'working');
    await f.service.reconcileNow();
    f.setPane(PANE_A, 'idle');

    // The wait finishes; the next pass reads the freed agent's finished item, then sends the blocked one.
    await f.service.mark({ requestId: randomUUID(), id: wait, verdict: 'done' });
    await f.service.reconcileNow();
    expect(f.prompts.map((prompt) => prompt.text)).toEqual([
      promptOf('Nền'),
      promptOf('Đang làm'),
      promptOf('Thường'),
      promptOf('Gấp chờ nền'),
    ]);
  });

  it('sends a dependent only after its dependency is done, not while it is in review', async () => {
    const f = await openFixture();
    f.panes.push({ paneId: PANE_A, status: 'idle' }, { paneId: PANE_B, status: 'idle' });
    const first = await f.service.create({ requestId: randomUUID(), text: 'Trước', assignee: herdr(PANE_A) });
    const second = await f.service.create({
      requestId: randomUUID(),
      text: 'Sau',
      assignee: herdr(PANE_B),
      dependsOn: [first],
    });
    const sequence = itemOf(f, first).sequence;
    expect(f.prompts.map((prompt) => prompt.text)).toEqual([promptOf('Trước')]);
    expect(itemOf(f, second)).toMatchObject({
      status: 'queued',
      reason: `Chờ việc #${sequence} xong.`,
      blocker: { kind: 'dependency', sequence },
    });

    f.setPane(PANE_A, 'working');
    await f.service.reconcileNow();
    f.setPane(PANE_A, 'idle');
    f.screen = 'Xong';
    await f.service.reconcileNow();
    expect(itemOf(f, first).status).toBe('review');
    expect(f.prompts.map((prompt) => prompt.text)).toEqual([promptOf('Trước')]);

    await f.service.mark({ requestId: randomUUID(), id: first, verdict: 'done' });
    expect(f.prompts.map((prompt) => prompt.text)).toEqual([promptOf('Trước'), promptOf('Sau')]);
    expect(itemOf(f, second).status).toBe('running');
  });

  it('leaves a dependent waiting on a failed dependency and names the failed #n', async () => {
    const f = await openFixture();
    f.panes.push({ paneId: PANE_A, status: 'idle' }, { paneId: PANE_B, status: 'idle' });
    const first = await f.service.create({ requestId: randomUUID(), text: 'Trước', assignee: herdr(PANE_A) });
    const second = await f.service.create({
      requestId: randomUUID(),
      text: 'Sau',
      assignee: herdr(PANE_B),
      dependsOn: [first],
    });
    const sequence = itemOf(f, first).sequence;

    await f.service.mark({ requestId: randomUUID(), id: first, verdict: 'failed' });
    expect(itemOf(f, second)).toMatchObject({
      status: 'queued',
      reason: `Việc #${sequence} bị lỗi, gỡ chờ hoặc giao lại.`,
      blocker: { kind: 'failed', sequence },
    });
    await f.service.reconcileNow();
    expect(f.prompts.map((prompt) => prompt.text)).toEqual([promptOf('Trước')]);
  });

  it('refuses to cancel an item that open items wait for, and names every #n that waits', async () => {
    const f = await openFixture();
    f.panes.push({ paneId: PANE_A, status: 'working' }, { paneId: PANE_B, status: 'working' });
    const first = await f.service.create({ requestId: randomUUID(), text: 'Trước', assignee: herdr(PANE_A) });
    const second = await f.service.create({
      requestId: randomUUID(),
      text: 'Chờ',
      assignee: herdr(PANE_B),
      dependsOn: [first],
    });
    const third = await f.service.create({
      requestId: randomUUID(),
      text: 'Cũng chờ',
      assignee: herdr(PANE_A),
      dependsOn: [first],
    });
    const secondSequence = itemOf(f, second).sequence;
    const thirdSequence = itemOf(f, third).sequence;

    await expect(f.service.cancel({ requestId: randomUUID(), id: first })).rejects.toMatchObject({
      code: 'work_item_awaited',
      message: `Không huỷ được: #${secondSequence}, #${thirdSequence} đang chờ việc này. Hãy bỏ việc này khỏi danh sách chờ của các việc đó trước.`,
    });
    expect(itemOf(f, first).status).toBe('queued');

    // Once nothing open waits for it, the item can go.
    await f.service.cancel({ requestId: randomUUID(), id: second });
    await f.service.cancel({ requestId: randomUUID(), id: third });
    await f.service.cancel({ requestId: randomUUID(), id: first });
    expect(f.service.snapshot().items).toEqual([]);
  });

  it('lets an item go once every item that waited for it is finished', async () => {
    const f = await openFixture();
    f.panes.push({ paneId: PANE_A, status: 'working' }, { paneId: PANE_B, status: 'working' });
    const first = await f.service.create({ requestId: randomUUID(), text: 'Trước', assignee: herdr(PANE_A) });
    const second = await f.service.create({
      requestId: randomUUID(),
      text: 'Sau',
      assignee: herdr(PANE_B),
      dependsOn: [first],
    });
    await f.service.mark({ requestId: randomUUID(), id: second, verdict: 'done' });

    await f.service.cancel({ requestId: randomUUID(), id: first });
    expect(f.service.snapshot().items.map((item) => item.id)).toEqual([second]);
  });

  it('never prunes a finished item an open item waits for, and prunes the rest past the keep limit', async () => {
    const f = await openFixture();
    f.panes.push({ paneId: PANE_A, status: 'working' }, { paneId: PANE_B, status: 'working' });
    const finishOne = async (text: string, dependsOn: string[] = []): Promise<string> => {
      f.now += 1000;
      const id = await f.service.create({
        requestId: randomUUID(),
        text,
        assignee: herdr(PANE_A),
        dependsOn,
      });
      f.now += 1000;
      await f.service.mark({ requestId: randomUUID(), id, verdict: 'done' });
      return id;
    };
    const oldest = await finishOne('Cũ nhất');
    f.now += 1000;
    const waiter = await f.service.create({
      requestId: randomUUID(),
      text: 'Đang chờ việc cũ',
      assignee: herdr(PANE_B),
      dependsOn: [oldest],
    });
    const second = await finishOne('Thứ hai');
    for (let n = 0; n < WORK_ITEM_FINISHED_KEEP; n += 1) await finishOne(`Việc ${n}`);

    // The newest finished items are kept; the one just behind them goes. The oldest stays while
    // the open waiter still names it.
    const kept = f.service.snapshot().items.map((item) => item.id);
    expect(kept).toContain(oldest);
    expect(kept).toContain(waiter);
    expect(kept).not.toContain(second);

    // Once nothing open waits for it, the next save lets it go.
    await f.service.cancel({ requestId: randomUUID(), id: waiter });
    expect(f.service.snapshot().items.map((item) => item.id)).not.toContain(oldest);
  });

  it('sends an item at once when everything it waits for is already done', async () => {
    const f = await openFixture();
    f.panes.push({ paneId: PANE_A, status: 'idle' }, { paneId: PANE_B, status: 'idle' });
    const first = await f.service.create({ requestId: randomUUID(), text: 'Trước', assignee: herdr(PANE_A) });
    await f.service.mark({ requestId: randomUUID(), id: first, verdict: 'done' });
    const second = await f.service.create({
      requestId: randomUUID(),
      text: 'Sau',
      assignee: herdr(PANE_B),
      dependsOn: [first],
    });
    expect(f.prompts.map((prompt) => prompt.text)).toEqual([promptOf('Trước'), promptOf('Sau')]);
    expect(itemOf(f, second).status).toBe('running');
  });

  it('refuses a wait that would close a loop or wait on itself, and keeps the old list', async () => {
    const f = await openFixture();
    f.panes.push({ paneId: PANE_A, status: 'working' });
    const first = await f.service.create({ requestId: randomUUID(), text: 'Một', assignee: herdr(PANE_A) });
    const second = await f.service.create({ requestId: randomUUID(), text: 'Hai', assignee: herdr(PANE_A) });
    await f.service.setDependencies({ requestId: randomUUID(), id: first, dependsOn: [second] });

    await expect(
      f.service.setDependencies({ requestId: randomUUID(), id: second, dependsOn: [first] }),
    ).rejects.toMatchObject({ code: 'dependency_invalid' });
    await expect(
      f.service.setDependencies({ requestId: randomUUID(), id: second, dependsOn: [second] }),
    ).rejects.toMatchObject({ code: 'dependency_invalid' });
    expect(itemOf(f, second).dependsOn).toEqual([]);
    expect(itemOf(f, first).dependsOn).toEqual([second]);
  });

  it('refuses more than ten waits and a wait on an item that is no longer on the board', async () => {
    const f = await openFixture();
    f.panes.push({ paneId: PANE_A, status: 'working' });
    const id = await f.service.create({ requestId: randomUUID(), text: 'Một', assignee: herdr(PANE_A) });
    const eleven = Array.from({ length: 11 }, () => randomUUID());
    await expect(
      f.service.setDependencies({ requestId: randomUUID(), id, dependsOn: eleven }),
    ).rejects.toMatchObject({ code: 'dependency_invalid' });
    await expect(
      f.service.setDependencies({ requestId: randomUUID(), id, dependsOn: [randomUUID()] }),
    ).rejects.toMatchObject({ code: 'dependency_invalid' });
    expect(itemOf(f, id).dependsOn).toEqual([]);
  });

  it('restores the old wait list when a dependency edit fails to save, and sends nothing', async () => {
    const f = await openFixture();
    f.panes.push({ paneId: PANE_A, status: 'idle' }, { paneId: PANE_B, status: 'idle' });
    const wait = await f.service.create({ requestId: randomUUID(), text: 'Nền', assignee: herdr(PANE_B) });
    const id = await f.service.create({
      requestId: randomUUID(),
      text: 'Sau',
      assignee: herdr(PANE_A),
      dependsOn: [wait],
    });
    const sequence = itemOf(f, wait).sequence;

    f.saveError = new Error('disk full');
    await expect(
      f.service.setDependencies({ requestId: randomUUID(), id, dependsOn: [] }),
    ).rejects.toMatchObject({ code: 'company_command_failed' });
    f.saveError = null;
    await f.service.reconcileNow();
    expect(f.prompts.map((prompt) => prompt.text)).toEqual([promptOf('Nền')]);
    expect(itemOf(f, id)).toMatchObject({
      dependsOn: [wait],
      blocker: { kind: 'dependency', sequence },
    });

    await f.service.setDependencies({ requestId: randomUUID(), id, dependsOn: [] });
    expect(f.prompts.map((prompt) => prompt.text)).toEqual([promptOf('Nền'), promptOf('Sau')]);
  });

  it('links squad rows by batch position and refuses a loop inside the batch', async () => {
    const f = await openFixture();
    f.panes.push({ paneId: PANE_A, status: 'working' }, { paneId: PANE_B, status: 'working' });
    const ids = await f.service.createWorkItems(
      [
        { text: 'Bước một', assignee: herdr(PANE_A) },
        { text: 'Bước hai', assignee: herdr(PANE_B), dependsOnDrafts: [0] },
      ],
      { squadRunId: randomUUID() },
    );
    const [first, second] = ids;
    if (first === undefined || second === undefined) throw new Error('expected two items');
    expect(itemOf(f, second).dependsOn).toEqual([first]);

    await expect(
      f.service.createWorkItems(
        [
          { text: 'Vòng một', assignee: herdr(PANE_A), dependsOnDrafts: [1] },
          { text: 'Vòng hai', assignee: herdr(PANE_B), dependsOnDrafts: [0] },
        ],
        { squadRunId: randomUUID() },
      ),
    ).rejects.toMatchObject({ code: 'dependency_invalid' });
    expect(f.service.snapshot().items).toHaveLength(2);
  });

  it('finds an open item by its #n and forgets it once it is finished', async () => {
    const f = await openFixture();
    f.panes.push({ paneId: PANE_A, status: 'idle' });
    const id = await f.service.create({ requestId: randomUUID(), text: 'Mở', assignee: herdr(PANE_A) });
    const sequence = itemOf(f, id).sequence;
    expect(f.service.findOpen(sequence)?.id).toBe(id);

    await f.service.mark({ requestId: randomUUID(), id, verdict: 'done' });
    expect(f.service.findOpen(sequence)).toBeUndefined();
  });
});

describe('WorkItemService: squad fields, auto assignee, and settings', () => {
  const SETTINGS = {
    ...SQUAD_SETTINGS_DEFAULT,
    maxParallel: 4,
    maxSquadSessions: 3,
    minFreeRamGb: 2,
    autoJudge: true,
    autoApproveNext: false,
  };

  /** A fixture whose folder holds one repo, REPO, before any command runs. */
  async function repoFixture(): Promise<Fixture> {
    const f = new Fixture();
    f.repos.push(REPO);
    await f.service.load();
    return f;
  }

  it('normalizes the repo, role and areas an item names, and clears them on a new assignee', async () => {
    const f = await repoFixture();
    f.panes.push(
      { paneId: PANE_A, status: 'working' },
      { paneId: PANE_B, status: 'idle', cwd: REPO },
    );
    const id = await f.service.create({
      requestId: randomUUID(),
      text: 'Sửa form',
      assignee: herdr(PANE_A),
      repo: `${REPO}/`,
      role: 'qa',
      areas: [' Web/UI ', 'web/ui', 'api/'],
    });
    expect(itemOf(f, id)).toMatchObject({ repo: REPO, role: 'qa', areas: ['web/ui', 'api'] });

    await f.service.assign({ requestId: randomUUID(), id, assignee: herdr(PANE_B) });
    const moved = itemOf(f, id);
    expect(moved.status).toBe('running');
    expect(moved.repo).toBeUndefined();
    expect(moved.role).toBeUndefined();
    expect(moved.areas).toEqual([]);
  });

  it('refuses a repo outside the folder, a director role, an unknown agent, and bad areas', async () => {
    const f = await repoFixture();
    f.panes.push({ paneId: PANE_A, status: 'idle', cwd: REPO });
    const attempt = (extra: Partial<Omit<WorkItemDraft, 'text' | 'assignee'>>): Promise<string> =>
      f.service.create({
        requestId: randomUUID(),
        text: 'Việc',
        assignee: herdr(PANE_A),
        ...extra,
      });

    await expect(attempt({ repo: '/elsewhere' })).rejects.toMatchObject({ code: 'repo_invalid' });
    await expect(attempt({ role: 'director' })).rejects.toMatchObject({
      code: 'item_role_invalid',
    });
    await expect(attempt({ agent: 'nope' })).rejects.toMatchObject({ code: 'agent_unknown' });
    await expect(
      attempt({ areas: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'] }),
    ).rejects.toMatchObject({ code: 'areas_invalid' });
    await expect(attempt({ areas: ['x'.repeat(121)] })).rejects.toMatchObject({
      code: 'areas_invalid',
    });
    expect(f.service.snapshot().items).toHaveLength(0);
  });

  it('lets an auto item pick the idle pane in its repo, and never one outside it', async () => {
    const f = await repoFixture();
    f.panes.push(
      { paneId: PANE_A, status: 'idle', cwd: REPO },
      { paneId: PANE_B, status: 'idle', cwd: '/work/folder/other' },
    );
    const id = await f.service.create({
      requestId: randomUUID(),
      text: 'Tự chọn',
      assignee: { kind: 'auto' },
      repo: REPO,
    });
    expect(itemOf(f, id)).toMatchObject({ status: 'running', assignee: herdr(PANE_A) });
    expect(f.openedWith).toEqual([]);
  });

  it('opens a new session in the item repo with the item role', async () => {
    const f = await repoFixture();
    const id = await f.service.create({
      requestId: randomUUID(),
      text: 'Viết test',
      assignee: { kind: 'new-session' },
      repo: REPO,
      role: 'worker',
    });
    expect(f.openedWith).toEqual([{ cwd: worktreeOf(id), role: 'worker' }]);
    expect(itemOf(f, id)).toMatchObject({
      status: 'running',
      assignee: { kind: 'session', sessionId: 'chat-1' },
    });
  });

  it('opens a session for an auto item, then reuses that squad session for the next qa item', async () => {
    const f = await repoFixture();
    f.panes.push({ paneId: PANE_A, status: 'working', cwd: REPO });
    const first = await f.service.create({
      requestId: randomUUID(),
      text: 'Lần đầu',
      assignee: { kind: 'auto' },
      repo: REPO,
      role: 'qa',
    });
    expect(f.openedWith).toEqual([{ cwd: worktreeOf(first), role: 'qa' }]);
    expect(itemOf(f, first)).toMatchObject({
      status: 'running',
      assignee: { kind: 'session', sessionId: 'chat-1' },
    });

    await f.elapse(WORK_ITEM_GRACE_MS);
    expect(itemOf(f, first).status).toBe('review');

    f.setPane(PANE_A, 'idle');
    const second = await f.service.create({
      requestId: randomUUID(),
      text: 'Lần hai',
      assignee: { kind: 'auto' },
      repo: REPO,
      role: 'qa',
    });
    expect(itemOf(f, second)).toMatchObject({
      status: 'running',
      assignee: { kind: 'session', sessionId: 'chat-1' },
    });
    expect(f.openedWith).toHaveLength(1);
  });

  it('holds an explicit item behind the parallel cap, then starts it when the first finishes', async () => {
    const f = await repoFixture();
    await f.service.setSettings({
      requestId: randomUUID(),
      settings: { ...SETTINGS, maxParallel: 1 },
    });
    f.panes.push(
      { paneId: PANE_A, status: 'idle', cwd: REPO },
      { paneId: PANE_B, status: 'idle', cwd: '/work/folder/other' },
    );
    const first = await f.service.create({
      requestId: randomUUID(),
      text: 'Một',
      assignee: herdr(PANE_A),
    });
    const second = await f.service.create({
      requestId: randomUUID(),
      text: 'Hai',
      assignee: herdr(PANE_B),
    });
    expect(itemOf(f, second)).toMatchObject({
      status: 'queued',
      blocker: { kind: 'capacity', running: 1, limit: 1 },
    });

    await f.elapse(WORK_ITEM_GRACE_MS);
    expect(itemOf(f, first).status).toBe('review');
    expect(itemOf(f, second).status).toBe('running');
  });

  it('holds an explicit item behind an overlapping area that a running item holds', async () => {
    const f = await repoFixture();
    f.panes.push(
      { paneId: PANE_A, status: 'idle', cwd: REPO },
      { paneId: PANE_B, status: 'idle', cwd: '/work/folder/other' },
    );
    const first = await f.service.create({
      requestId: randomUUID(),
      text: 'Giao diện',
      assignee: herdr(PANE_A),
      areas: ['web'],
    });
    const second = await f.service.create({
      requestId: randomUUID(),
      text: 'Nút',
      assignee: herdr(PANE_B),
      areas: ['web/ui'],
    });
    expect(itemOf(f, second).blocker).toEqual({
      kind: 'area',
      sequence: itemOf(f, first).sequence,
      area: 'web/ui',
    });

    await f.elapse(WORK_ITEM_GRACE_MS);
    expect(itemOf(f, first).status).toBe('review');
    expect(itemOf(f, second).status).toBe('running');
  });

  it('lets a read-only agent share an area with an editing item', async () => {
    const f = await repoFixture();
    f.panes.push(
      { paneId: PANE_A, status: 'idle', cwd: REPO },
      { paneId: PANE_B, status: 'idle', cwd: '/work/folder/other' },
    );
    const reader = await f.service.create({
      requestId: randomUUID(),
      text: 'Đọc',
      assignee: herdr(PANE_A),
      agent: 'scout',
      areas: ['web'],
    });
    const editor = await f.service.create({
      requestId: randomUUID(),
      text: 'Sửa',
      assignee: herdr(PANE_B),
      areas: ['web/ui'],
    });
    expect(itemOf(f, reader).status).toBe('running');
    expect(itemOf(f, editor).status).toBe('running');
  });

  it('leaves an auto item queued with a reason while the squad cap or free memory blocks it', async () => {
    const f = await repoFixture();
    await f.service.setSettings({
      requestId: randomUUID(),
      settings: { ...SETTINGS, maxSquadSessions: 0 },
    });
    const id = await f.service.create({
      requestId: randomUUID(),
      text: 'Không chỗ',
      assignee: { kind: 'auto' },
      repo: REPO,
    });
    expect(itemOf(f, id)).toMatchObject({ status: 'queued', blocker: { kind: 'no_member' } });
    expect(itemOf(f, id).reason).toContain('đội đã mở 0/0 phiên');
    expect(f.openedWith).toEqual([]);

    f.freeBytes = 1 * GIB;
    await f.service.setSettings({ requestId: randomUUID(), settings: SETTINGS });
    expect(itemOf(f, id)).toMatchObject({ status: 'queued', blocker: { kind: 'no_member' } });
    expect(itemOf(f, id).reason).toContain('RAM trống 1.0 GB, cần 2.0 GB');
    expect(f.openedWith).toEqual([]);

    // Memory frees up: the next pass opens the session in the repo with the default chat role.
    f.freeBytes = 8 * GIB;
    await f.service.reconcileNow();
    expect(f.openedWith).toEqual([{ cwd: worktreeOf(id), role: 'chat' }]);
    expect(itemOf(f, id).status).toBe('running');
  });

  it('runs an editing new session in its own worktree, made before its session opens', async () => {
    const f = await repoFixture();
    const id = await f.service.create({
      requestId: randomUUID(),
      text: 'Sửa API',
      assignee: { kind: 'new-session' },
      repo: REPO,
      role: 'worker',
    });
    expect(f.worktreesMade).toEqual([{ repo: REPO, shortId: id.slice(0, 8) }]);
    expect(f.openedWith).toEqual([{ cwd: worktreeOf(id), role: 'worker' }]);
    expect(itemOf(f, id)).toMatchObject({
      status: 'running',
      worktree: { path: worktreeOf(id), branch: `squad-${id.slice(0, 8)}` },
    });
  });

  it('says the worktree is being made, and keeps it on an item marked done meanwhile without starting it', async () => {
    const f = await repoFixture();
    let release = (): void => undefined;
    f.worktreeGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const created = f.service.create({
      requestId: randomUUID(),
      text: 'Sửa API',
      assignee: { kind: 'new-session' },
      repo: REPO,
      role: 'worker',
    });
    await vi.waitFor(() =>
      expect(f.service.snapshot().items[0]?.history.some((event) => event.message?.startsWith('Đang tạo worktree'))).toBe(true),
    );
    const id = f.service.snapshot().items[0]?.id ?? '';
    const marked = f.service.mark({ requestId: randomUUID(), id, verdict: 'done' });
    release();
    await Promise.all([created, marked]);

    expect(itemOf(f, id)).toMatchObject({ status: 'done', worktree: { path: worktreeOf(id) } });
    expect(f.openedWith).toEqual([]);
  });

  it('keeps a failed item whose worktree is still on disk, and removes it once the worktree is gone', async () => {
    const f = await repoFixture();
    const id = await f.service.create({
      requestId: randomUUID(),
      text: 'Sửa API',
      assignee: { kind: 'new-session' },
      repo: REPO,
      role: 'worker',
    });
    await f.service.mark({ requestId: randomUUID(), id, verdict: 'failed' });

    await expect(f.service.cancel({ requestId: randomUUID(), id })).rejects.toMatchObject({
      code: 'work_item_status',
      message: expect.stringContaining('Worktree của việc này còn trên đĩa'),
    });
    expect(itemOf(f, id).status).toBe('failed');

    f.worktreeOnDisk = false;
    await f.service.cancel({ requestId: randomUUID(), id });
    expect(f.service.snapshot().items).toEqual([]);
  });

  it('opens a read-only agent in the repo itself, with no worktree', async () => {
    const f = await repoFixture();
    const id = await f.service.create({
      requestId: randomUUID(),
      text: 'Tìm lỗi',
      assignee: { kind: 'new-session' },
      repo: REPO,
      role: 'worker',
      agent: 'scout',
    });
    expect(f.worktreesMade).toEqual([]);
    expect(f.openedWith).toEqual([{ cwd: REPO, role: 'worker' }]);
    expect(itemOf(f, id)).toMatchObject({ status: 'running' });
    expect(itemOf(f, id).worktree).toBeUndefined();
  });

  it('keeps an editing item queued with a worktree reason when its worktree fails, then retries', async () => {
    const f = await repoFixture();
    f.worktreeError = new Error('git fetch origin lỗi: không kết nối');
    const id = await f.service.create({
      requestId: randomUUID(),
      text: 'Sửa API',
      assignee: { kind: 'new-session' },
      repo: REPO,
      role: 'worker',
    });
    expect(f.chatsOpened).toBe(0);
    expect(itemOf(f, id)).toMatchObject({
      status: 'queued',
      blocker: { kind: 'worktree', detail: 'git fetch origin lỗi: không kết nối' },
    });
    expect(itemOf(f, id).reason).toContain('Chưa tạo được worktree riêng');

    f.worktreeError = null;
    await f.elapse(WORK_ITEM_HOLD_RETRY_MS);
    expect(f.worktreesMade).toHaveLength(1);
    // The retry does not repeat the "making a worktree" note.
    expect(itemOf(f, id).history.filter((event) => event.message?.startsWith('Đang tạo worktree'))).toHaveLength(1);
    expect(itemOf(f, id)).toMatchObject({
      status: 'running',
      assignee: { kind: 'session', sessionId: 'chat-1' },
    });
  });

  it('waits for a free runner slot when the omp pool is full, and keeps the worktree it made', async () => {
    const f = await repoFixture();
    f.poolFull = true;
    const id = await f.service.create({
      requestId: randomUUID(),
      text: 'Sửa API',
      assignee: { kind: 'new-session' },
      repo: REPO,
      role: 'worker',
    });
    expect(itemOf(f, id)).toMatchObject({ status: 'queued', blocker: { kind: 'pool_full' } });
    expect(itemOf(f, id).reason).toContain('Đã đủ phiên omp');

    f.poolFull = false;
    await f.elapse(WORK_ITEM_HOLD_RETRY_MS);
    expect(itemOf(f, id)).toMatchObject({
      status: 'running',
      assignee: { kind: 'session', sessionId: 'chat-1' },
    });
    // The worktree made on the first try is reused, not made again.
    expect(f.worktreesMade).toHaveLength(1);
  });

  it('holds an auto item while a busy agent locks the checkout of the idle one', async () => {
    const f = await repoFixture();
    f.sessions.push(
      { id: 'busy-ext', status: 'busy', role: 'worker', cwd: REPO },
      { id: 'idle-ext', status: 'idle', role: 'chat', cwd: REPO },
    );
    const id = await f.service.create({
      requestId: randomUUID(),
      text: 'Sửa API',
      assignee: { kind: 'auto' },
      repo: REPO,
      role: 'worker',
    });
    expect(itemOf(f, id)).toMatchObject({
      status: 'queued',
      blocker: { kind: 'busy_checkout', area: 'app' },
    });
    expect(f.submits).toEqual([]);
    expect(f.chatsOpened).toBe(0);

    // The busy agent finishes: the item goes to a free member of the repo, not to a new session.
    f.sessions[0] = { ...f.sessions[0], status: 'idle' };
    await f.service.reconcileNow();
    expect(itemOf(f, id).status).toBe('running');
    expect(f.chatsOpened).toBe(0);
  });

  it('sends a subagent to an omp session in the repo, never to a herdr pane, and opens a read-only one at the repo root', async () => {
    const f = await repoFixture();
    f.panes.push({ paneId: PANE_A, status: 'idle', cwd: REPO });
    const id = await f.service.create({
      requestId: randomUUID(),
      text: 'Tìm chỗ gọi API',
      assignee: { kind: 'auto' },
      repo: REPO,
      agent: 'scout',
    });
    expect(itemOf(f, id)).toMatchObject({
      status: 'running',
      assignee: { kind: 'session', sessionId: 'chat-1' },
    });
    expect(f.prompts).toEqual([]);
    expect(f.openedWith).toEqual([{ cwd: REPO, role: 'chat' }]);
    expect(f.worktreesMade).toEqual([]);
    expect(f.submits).toHaveLength(1);
    expect(f.submits[0].text).toContain('tool task, agent: scout');
  });

  it('tells settle listeners when an item reaches review, fails, or is marked done', async () => {
    const f = await openFixture();
    f.panes.push({ paneId: PANE_A, status: 'idle' }, { paneId: PANE_B, status: 'idle' });
    const settled: string[] = [];
    const stop = f.service.onItemSettled((item) => settled.push(`${item.status}:${item.id}`));

    const reviewed = await f.service.create({
      requestId: randomUUID(),
      text: 'Xem lại',
      assignee: herdr(PANE_A),
    });
    await f.elapse(WORK_ITEM_GRACE_MS);
    expect(settled).toEqual([`review:${reviewed}`]);

    const failed = await f.service.create({
      requestId: randomUUID(),
      text: 'Hỏng',
      assignee: herdr(PANE_B),
    });
    f.panes.splice(
      f.panes.findIndex((pane) => pane.paneId === PANE_B),
      1,
    );
    await f.service.reconcileNow();
    expect(settled).toEqual([`review:${reviewed}`, `failed:${failed}`]);

    await f.service.mark({ requestId: randomUUID(), id: reviewed, verdict: 'done' });
    expect(settled).toEqual([`review:${reviewed}`, `failed:${failed}`, `done:${reviewed}`]);
    stop();
  });

  it('saves squad settings once per request id and refuses values out of range', async () => {
    const f = await openFixture();
    const requestId = randomUUID();
    const first = {
      ...SQUAD_SETTINGS_DEFAULT,
      maxParallel: 2,
      maxSquadSessions: 1,
      minFreeRamGb: 4,
      autoJudge: false,
      autoApproveNext: true,
    };
    await f.service.setSettings({ requestId, settings: first });
    await f.service.setSettings({ requestId, settings: { ...first, maxParallel: 8 } });
    expect(f.service.snapshot().settings).toEqual(first);

    await expect(
      f.service.setSettings({ requestId: randomUUID(), settings: { ...first, maxParallel: 9 } }),
    ).rejects.toMatchObject({ code: 'settings_invalid' });
    expect(f.service.snapshot().settings).toEqual(first);
  });

  it('publishes the folder repos, omp agents and settings with the state', async () => {
    const f = await repoFixture();
    const snapshot = f.service.snapshot();
    expect(snapshot.repos).toEqual([REPO]);
    expect(snapshot.agents.map((agent) => agent.name)).toContain('scout');
    expect(snapshot.settings).toEqual(SETTINGS);
  });
});

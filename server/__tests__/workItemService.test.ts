import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type {
  CompanyWorkItemsMessage,
  HerdrAgent,
  WorkItem,
  WorkItemAssignee,
} from '../../core/src/messages.js';
import { CompanyError } from '../src/company/companyError.js';
import {
  parseWorkItemsFile,
  WORK_ITEM_GRACE_MS,
  WORK_ITEM_REASON,
  WORK_ITEM_TEXT_MAX_BYTES,
  type WorkItemsFile,
} from '../src/company/workItems/workItemModel.js';
import {
  type WorkItemPaneView,
  WorkItemService,
  type WorkItemSessionView,
} from '../src/company/workItems/workItemService.js';

const T0 = Date.parse('2026-05-01T08:00:00.000Z');
const PANE_A = 'wA:p1';
const PANE_B = 'wA:p2';

type PaneStatus = HerdrAgent['status'];

interface PaneState {
  paneId: string;
  status: PaneStatus;
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
  readonly sessions: WorkItemSessionView[] = [];
  readonly submits: { sessionId: string; text: string; mode: 'chat' | 'company' }[] = [];
  chatsOpened = 0;
  readonly saves: WorkItemsFile[] = [];
  saveError: Error | null = null;
  readonly published: CompanyWorkItemsMessage[] = [];
  now = T0;
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
      },
      sessions: {
        list: () => this.sessions.map((session) => ({ ...session })),
        submit: async (sessionId, text, mode) => {
          this.submits.push({ sessionId, text, mode });
        },
        openChat: async () => {
          this.chatsOpened += 1;
          const id = `chat-${this.chatsOpened}`;
          this.sessions.push({ id, status: 'idle', role: 'chat' });
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

    expect(f.prompts).toEqual([{ paneId: PANE_A, text: 'Sửa lỗi đăng nhập' }]);
    expect(itemOf(f, id).status).toBe('running');

    f.setPane(PANE_A, 'working');
    await f.service.reconcileNow();
    expect(itemOf(f, id).status).toBe('running');

    f.setPane(PANE_A, 'idle');
    f.screen = '\nBước 1\n\nXong\n';
    await f.service.reconcileNow();
    expect(itemOf(f, id)).toMatchObject({ status: 'review', result: 'Bước 1\nXong' });
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
    expect(f.prompts.map((prompt) => prompt.text)).toEqual(['A', 'B']);
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
    const stopReviews = f.service.onReview((item) => reviewed.push(item.id));
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
    expect(f.prompts.at(-1)).toEqual({ paneId: PANE_A, text: 'Thêm chi tiết' });
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
    expect(f.submits).toEqual([{ sessionId: 'chat-1', text: 'Việc mới', mode: 'chat' }]);
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
    expect(f.submits).toEqual([{ sessionId: 's-worker', text: 'Cho worker', mode: 'company' }]);
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
    expect(f.prompts.map((prompt) => prompt.text)).toEqual(['Đầu']);
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
    expect(f.prompts).toEqual([{ paneId: PANE_A, text: 'Chờ' }]);
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
      { paneId: PANE_A, text: 'Sửa lỗi đăng nhập\n\nXong khi: Đăng nhập được bằng mật khẩu mới' },
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
    expect(f.prompts.map((prompt) => prompt.text)).toEqual(['Gấp']);
    await f.service.mark({ requestId: randomUUID(), id: urgent, verdict: 'done' });
    expect(f.prompts.map((prompt) => prompt.text)).toEqual(['Gấp', 'Thường một']);
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
    expect(f.prompts.map((prompt) => prompt.text)).toEqual(['Nền', 'Đang làm']);
    expect(itemOf(f, blocked)).toMatchObject({
      status: 'queued',
      blocker: { kind: 'dependency', sequence: itemOf(f, wait).sequence },
    });

    // The current item finishes: the blocked item still waits, so the ready one goes first.
    await f.service.mark({ requestId: randomUUID(), id: current, verdict: 'done' });
    expect(f.prompts.map((prompt) => prompt.text)).toEqual(['Nền', 'Đang làm', 'Thường']);
    expect(itemOf(f, blocked).status).toBe('queued');

    // The agent must be seen working before its finished item counts as done.
    f.setPane(PANE_A, 'working');
    await f.service.reconcileNow();
    f.setPane(PANE_A, 'idle');

    // The wait finishes; the next pass reads the freed agent's finished item, then sends the blocked one.
    await f.service.mark({ requestId: randomUUID(), id: wait, verdict: 'done' });
    await f.service.reconcileNow();
    expect(f.prompts.map((prompt) => prompt.text)).toEqual([
      'Nền',
      'Đang làm',
      'Thường',
      'Gấp chờ nền',
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
    expect(f.prompts.map((prompt) => prompt.text)).toEqual(['Trước']);
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
    expect(f.prompts.map((prompt) => prompt.text)).toEqual(['Trước']);

    await f.service.mark({ requestId: randomUUID(), id: first, verdict: 'done' });
    expect(f.prompts.map((prompt) => prompt.text)).toEqual(['Trước', 'Sau']);
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
    expect(f.prompts.map((prompt) => prompt.text)).toEqual(['Trước']);
  });

  it('keeps the #n of a cancelled dependency on the item that waited for it', async () => {
    const f = await openFixture();
    f.panes.push({ paneId: PANE_A, status: 'working' }, { paneId: PANE_B, status: 'idle' });
    const first = await f.service.create({ requestId: randomUUID(), text: 'Huỷ', assignee: herdr(PANE_A) });
    const second = await f.service.create({
      requestId: randomUUID(),
      text: 'Chờ',
      assignee: herdr(PANE_B),
      dependsOn: [first],
    });
    const sequence = itemOf(f, first).sequence;

    await f.service.cancel({ requestId: randomUUID(), id: first });
    expect(itemOf(f, second)).toMatchObject({
      status: 'queued',
      blocker: { kind: 'failed', sequence },
    });
    await f.service.reconcileNow();
    expect(f.prompts).toEqual([]);
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
    expect(f.prompts.map((prompt) => prompt.text)).toEqual(['Trước', 'Sau']);
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
    expect(f.prompts.map((prompt) => prompt.text)).toEqual(['Nền']);
    expect(itemOf(f, id)).toMatchObject({
      dependsOn: [wait],
      blocker: { kind: 'dependency', sequence },
    });

    await f.service.setDependencies({ requestId: randomUUID(), id, dependsOn: [] });
    expect(f.prompts.map((prompt) => prompt.text)).toEqual(['Nền', 'Sau']);
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

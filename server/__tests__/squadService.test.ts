import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type {
  AgentRole,
  CompanySquadMessage,
  CompanyWorkItemsMessage,
  SquadRun,
  WorkItem,
  WorkItemStatus,
} from '../../core/src/messages.js';
import { CompanyError } from '../src/company/companyError.js';
import {
  emptySquadFile,
  type ParsedSquadFile,
  SQUAD_MAX_TURNS,
  type SquadFile,
  type SquadMember,
  type StoredSquadRun,
} from '../src/company/squad/squadModel.js';
import type { LeaderRunner } from '../src/company/squad/squadRunner.js';
import {
  type SquadPersistence,
  SquadService,
  type SquadWorkItems,
} from '../src/company/squad/squadService.js';
import type { WorkItemDraft } from '../src/company/workItems/workItemModel.js';

const WORKSPACE = '/work/folder';
const AT = '2026-05-01T08:00:00.000Z';
const CLOCK_START = Date.parse(AT);

const MEMBER: SquadMember = {
  ref: 'herdr:wA:p1',
  kind: 'herdr',
  assignee: { kind: 'herdr', paneId: 'wA:p1' },
  label: 'Pane 1',
  status: 'idle',
  role: 'Frontend',
  queued: 0,
};

function proposal(text: string, assignee = 'herdr:wA:p1'): string {
  return JSON.stringify({
    assignments: [{ assignee, text, reason: 'Lý do' }],
    note: 'Ghi chú',
    done: false,
  });
}

const DONE_REPLY = JSON.stringify({ assignments: [], note: 'Đội đã xong.', done: true });

/** In-memory work items. A review or a status change notifies the listeners the way Phase 1 does. */
class FakeWorkItems implements SquadWorkItems {
  readonly items: WorkItem[] = [];
  readonly creates: { drafts: WorkItemDraft[]; squadRunId: string }[] = [];
  private readonly changeListeners = new Set<() => void>();
  private readonly reviewListeners = new Set<(item: WorkItem) => void>();
  private sequence = 0;

  snapshot(): CompanyWorkItemsMessage {
    const roles: AgentRole[] = [];
    return {
      type: 'companyWorkItems',
      workspacePath: WORKSPACE,
      revision: this.sequence,
      items: structuredClone(this.items),
      roles,
    };
  }

  async createWorkItems(
    drafts: readonly WorkItemDraft[],
    options: { squadRunId: string },
  ): Promise<string[]> {
    this.creates.push({ drafts: [...drafts], squadRunId: options.squadRunId });
    const ids = drafts.map((draft) => {
      this.sequence += 1;
      const id = randomUUID();
      this.items.push({
        id,
        text: draft.text,
        assignee: draft.assignee,
        status: 'queued',
        sequence: this.sequence,
        squadRunId: options.squadRunId,
        createdAt: AT,
        updatedAt: AT,
        history: [],
      });
      return id;
    });
    this.notifyChange();
    return ids;
  }

  onChange(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => {
      this.changeListeners.delete(listener);
    };
  }

  onReview(listener: (item: WorkItem) => void): () => void {
    this.reviewListeners.add(listener);
    return () => {
      this.reviewListeners.delete(listener);
    };
  }

  /** Moves an item to review with a result, the way the work item service does. */
  review(id: string, at: string, result: string): void {
    const item = this.find(id);
    item.status = 'review';
    item.result = result;
    item.updatedAt = at;
    for (const listener of this.reviewListeners) listener(structuredClone(item));
    this.notifyChange();
  }

  setStatus(id: string, status: WorkItemStatus): void {
    this.find(id).status = status;
    this.notifyChange();
  }

  private find(id: string): WorkItem {
    const item = this.items.find((entry) => entry.id === id);
    if (item === undefined) throw new Error(`no item ${id}`);
    return item;
  }

  private notifyChange(): void {
    for (const listener of this.changeListeners) listener();
  }
}

class FakePersistence implements SquadPersistence {
  loaded: ParsedSquadFile = { file: emptySquadFile(), dropped: 0, corrupt: false };
  readonly saves: SquadFile[] = [];
  saveError: Error | null = null;

  async load(): Promise<ParsedSquadFile> {
    return this.loaded;
  }

  async save(file: SquadFile): Promise<void> {
    if (this.saveError !== null) throw this.saveError;
    this.saves.push(structuredClone(file));
  }
}

/** Replies are queued; each turn takes the next one. An Error reply makes the turn fail. */
class FakeLeader implements LeaderRunner {
  readonly prompts: string[] = [];
  private readonly replies: (string | Error)[] = [];

  reply(value: string | Error): void {
    this.replies.push(value);
  }

  async run(prompt: string): Promise<string> {
    this.prompts.push(prompt);
    const next = this.replies.shift();
    if (next === undefined) throw new Error('no reply queued');
    if (next instanceof Error) throw next;
    return next;
  }
}

class Harness {
  readonly workItems = new FakeWorkItems();
  readonly leader = new FakeLeader();
  readonly persistence = new FakePersistence();
  readonly published: CompanySquadMessage[] = [];
  members: SquadMember[] = [MEMBER];
  readonly service: SquadService;
  private clock = CLOCK_START;

  constructor() {
    this.service = this.createService();
  }

  /** A fresh service over the same ports, as after a restart. */
  createService(): SquadService {
    return new SquadService(
      { workspacePath: WORKSPACE, folderName: 'folder' },
      {
        workItems: this.workItems,
        members: () => this.members,
        leader: this.leader,
        persistence: this.persistence,
        publish: (message) => {
          this.published.push(message);
        },
        now: () => {
          this.clock += 1000;
          return this.clock;
        },
        newId: () => randomUUID(),
      },
    );
  }

  /** A timestamp later than any before it, so each review is a distinct review. */
  stamp(): string {
    this.clock += 1000;
    return new Date(this.clock).toISOString();
  }

  runOf(id: string): SquadRun | undefined {
    return this.service.snapshot().runs.find((run) => run.id === id);
  }

  /** Items the approved proposal created. */
  itemsOf(proposalId: string): WorkItem[] {
    return this.workItems.items.filter((item) => item.squadRunId === proposalId);
  }
}

/** Lets pending turns run: a turn is only microtasks, so each pass hands the queue one step. */
async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 2000; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error('the squad did not reach the expected state');
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the command to be refused');
}

function storedRun(overrides: Partial<StoredSquadRun>): StoredSquadRun {
  return {
    id: randomUUID(),
    request: 'Làm trang đăng nhập',
    status: 'planning',
    turns: 0,
    proposals: [],
    pendingReviews: [],
    history: [],
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  };
}

/** Starts a run with one proposal, approves it, and returns the run and the approved proposal. */
async function approvedRun(
  h: Harness,
  text: string,
): Promise<{ runId: string; proposalId: string }> {
  h.leader.reply(proposal(text));
  const runId = await h.service.request({ requestId: randomUUID(), text: 'Làm trang đăng nhập' });
  await waitFor(() => h.runOf(runId)?.status === 'proposed');
  const current = h.runOf(runId)?.proposal;
  if (current === undefined) throw new Error('no proposal');
  await h.service.approve({
    requestId: randomUUID(),
    runId,
    proposalId: current.id,
    rows: current.rows,
  });
  return { runId, proposalId: current.id };
}

describe('SquadService requests', () => {
  it('starts a run, asks the leader with the team, and offers the proposal once saved', async () => {
    const h = new Harness();
    h.leader.reply(proposal('Viết form đăng nhập'));
    const runId = await h.service.request({ requestId: randomUUID(), text: 'Làm trang đăng nhập' });
    await waitFor(() => h.runOf(runId)?.status === 'proposed');

    const run = h.runOf(runId);
    expect(run?.proposal?.rows).toEqual([
      {
        text: 'Viết form đăng nhập',
        assignee: { kind: 'herdr', paneId: 'wA:p1' },
        reason: 'Lý do',
      },
    ]);
    expect(run?.proposal?.status).toBe('pending');
    expect(h.leader.prompts[0]).toContain('- herdr:wA:p1');
    expect(h.leader.prompts[0]).toContain('role: "Frontend"');
    await waitFor(() => h.persistence.saves.at(-1)?.runs[0]?.status === 'proposed');
  });

  it('answers a resent request with the same run and runs one leader turn', async () => {
    const h = new Harness();
    h.leader.reply(proposal('Việc'));
    const requestId = randomUUID();
    const first = await h.service.request({ requestId, text: 'Làm' });
    const second = await h.service.request({ requestId, text: 'Làm' });
    expect(second).toBe(first);
    await waitFor(() => h.runOf(first)?.status === 'proposed');
    expect(h.leader.prompts).toHaveLength(1);
  });

  it('refuses an empty request and a request with no team', async () => {
    const h = new Harness();
    const empty = await rejectionOf(h.service.request({ requestId: randomUUID(), text: '   ' }));
    expect(empty).toBeInstanceOf(CompanyError);
    expect((empty as CompanyError).code).toBe('empty_text');

    h.members = [];
    const noTeam = await rejectionOf(h.service.request({ requestId: randomUUID(), text: 'Làm' }));
    expect((noTeam as CompanyError).code).toBe('squad_no_members');
    expect(h.service.snapshot().runs).toHaveLength(0);
  });

  it('removes the run and refuses the command when its save fails', async () => {
    const h = new Harness();
    h.persistence.saveError = new Error('disk full');
    const refused = await rejectionOf(h.service.request({ requestId: randomUUID(), text: 'Làm' }));
    expect((refused as CompanyError).code).toBe('company_command_failed');
    expect(h.service.snapshot().runs).toHaveLength(0);

    h.persistence.saveError = null;
    h.leader.reply(proposal('Việc'));
    const runId = await h.service.request({ requestId: randomUUID(), text: 'Làm' });
    await waitFor(() => h.runOf(runId)?.status === 'proposed');
  });
});

describe('SquadService approval and dismissal', () => {
  it('creates the approved rows once, even when the approval is sent again', async () => {
    const h = new Harness();
    const { runId, proposalId } = await approvedRun(h, 'Viết form đăng nhập');
    expect(h.workItems.creates).toHaveLength(1);
    expect(h.workItems.creates[0]?.squadRunId).toBe(proposalId);
    expect(h.runOf(runId)?.status).toBe('working');

    const again = h.runOf(runId)?.proposal?.rows ?? [];
    await h.service.approve({ requestId: randomUUID(), runId, proposalId, rows: again });
    expect(h.workItems.creates).toHaveLength(1);
  });

  it('refuses rows that do not pass the check and creates nothing', async () => {
    const h = new Harness();
    h.leader.reply(proposal('Việc'));
    const runId = await h.service.request({ requestId: randomUUID(), text: 'Làm' });
    await waitFor(() => h.runOf(runId)?.status === 'proposed');
    const proposalId = h.runOf(runId)?.proposal?.id ?? '';
    const refused = await rejectionOf(
      h.service.approve({ requestId: randomUUID(), runId, proposalId, rows: [] }),
    );
    expect((refused as CompanyError).code).toBe('squad_rows_invalid');
    expect(h.workItems.creates).toHaveLength(0);
  });

  it('refuses an approval for a proposal the run does not have', async () => {
    const h = new Harness();
    h.leader.reply(proposal('Việc'));
    const runId = await h.service.request({ requestId: randomUUID(), text: 'Làm' });
    await waitFor(() => h.runOf(runId)?.status === 'proposed');
    const refused = await rejectionOf(
      h.service.approve({ requestId: randomUUID(), runId, proposalId: randomUUID(), rows: [] }),
    );
    expect((refused as CompanyError).code).toBe('squad_proposal_not_found');
  });

  it('ends a run that has no approved work when its proposal is dismissed, and asks nothing more', async () => {
    const h = new Harness();
    h.leader.reply(proposal('Việc'));
    const runId = await h.service.request({ requestId: randomUUID(), text: 'Làm' });
    await waitFor(() => h.runOf(runId)?.status === 'proposed');
    const proposalId = h.runOf(runId)?.proposal?.id ?? '';
    await h.service.dismiss({ requestId: randomUUID(), runId, proposalId });
    expect(h.runOf(runId)?.status).toBe('dismissed');
    expect(h.leader.prompts).toHaveLength(1);
    expect(h.workItems.creates).toHaveLength(0);
  });
});

describe('SquadService turns', () => {
  it('sends a finished item result to the leader and proposes the next step', async () => {
    const h = new Harness();
    const { runId, proposalId } = await approvedRun(h, 'Viết form đăng nhập');
    h.leader.reply(proposal('Viết test cho form'));
    const [item] = h.itemsOf(proposalId);
    if (item === undefined) throw new Error('no item');
    h.workItems.review(item.id, h.stamp(), 'Form đã xong');

    await waitFor(() => h.runOf(runId)?.status === 'proposed');
    expect(h.leader.prompts[1]).toContain('result: Form đã xong');
    expect(h.runOf(runId)?.turns).toBe(2);
    await waitFor(() => h.persistence.saves.at(-1)?.runs[0]?.pendingReviews.length === 0);
  });

  it('marks the run done when the leader says the request is finished', async () => {
    const h = new Harness();
    const { runId, proposalId } = await approvedRun(h, 'Viết form');
    h.leader.reply(DONE_REPLY);
    const [item] = h.itemsOf(proposalId);
    if (item === undefined) throw new Error('no item');
    h.workItems.review(item.id, h.stamp(), 'Xong');
    await waitFor(() => h.runOf(runId)?.status === 'done');
    expect(h.runOf(runId)?.note).toBe('Đội đã xong.');
  });

  it('stops the run with a notice after the turn limit, without another leader turn', async () => {
    const h = new Harness();
    for (let turn = 1; turn <= SQUAD_MAX_TURNS; turn += 1) h.leader.reply(proposal(`Việc ${turn}`));
    h.leader.reply(DONE_REPLY);
    h.leader.reply(DONE_REPLY);
    const runId = await h.service.request({ requestId: randomUUID(), text: 'Làm' });
    for (let turn = 1; turn <= SQUAD_MAX_TURNS; turn += 1) {
      await waitFor(() => h.runOf(runId)?.status === 'proposed' && h.runOf(runId)?.turns === turn);
      const current = h.runOf(runId)?.proposal;
      if (current === undefined) throw new Error('no proposal');
      await h.service.approve({
        requestId: randomUUID(),
        runId,
        proposalId: current.id,
        rows: current.rows,
      });
      const [item] = h.itemsOf(current.id);
      if (item === undefined) throw new Error('no item');
      h.workItems.review(item.id, h.stamp(), `Kết quả ${turn}`);
    }
    await waitFor(() => h.runOf(runId)?.status === 'stopped');
    expect(h.runOf(runId)?.note).toContain(`${SQUAD_MAX_TURNS} lượt`);
    expect(h.leader.prompts).toHaveLength(SQUAD_MAX_TURNS);
  });

  it('shows a failed turn, then asks the leader again when retried', async () => {
    const h = new Harness();
    h.leader.reply('không phải JSON');
    h.leader.reply(proposal('Việc sau khi thử lại'));
    const runId = await h.service.request({ requestId: randomUUID(), text: 'Làm' });
    await waitFor(() => h.runOf(runId)?.status === 'failed');
    expect(h.runOf(runId)?.error).toContain('JSON');

    await h.service.retry({ requestId: randomUUID(), runId });
    await waitFor(() => h.runOf(runId)?.status === 'proposed');
    expect(h.leader.prompts).toHaveLength(2);
  });

  it('fails the turn and assigns nothing when the reply names an unknown assignee', async () => {
    const h = new Harness();
    h.leader.reply(proposal('Việc', 'herdr:wZ:p9'));
    const runId = await h.service.request({ requestId: randomUUID(), text: 'Làm' });
    await waitFor(() => h.runOf(runId)?.status === 'failed');
    expect(h.runOf(runId)?.error).toContain('không có trong danh sách');
    expect(h.workItems.creates).toHaveLength(0);
  });

  it('keeps the progress of an approved proposal in step with its items', async () => {
    const h = new Harness();
    const { runId, proposalId } = await approvedRun(h, 'Viết form');
    const [item] = h.itemsOf(proposalId);
    if (item === undefined) throw new Error('no item');
    h.workItems.setStatus(item.id, 'done');
    expect(h.runOf(runId)?.progress).toEqual({ done: 1, total: 1 });
  });

  it('stops listening to reviews once disposed', async () => {
    const h = new Harness();
    const { proposalId } = await approvedRun(h, 'Viết form');
    h.service.dispose();
    const [item] = h.itemsOf(proposalId);
    if (item === undefined) throw new Error('no item');
    h.workItems.review(item.id, h.stamp(), 'Xong');
    for (let attempt = 0; attempt < 50; attempt += 1) await Promise.resolve();
    expect(h.leader.prompts).toHaveLength(1);
  });
});

describe('SquadService restart', () => {
  it('marks a turn that was in flight as failed, and retry asks again', async () => {
    const h = new Harness();
    const run = storedRun({ status: 'planning' });
    h.persistence.loaded = {
      file: { version: 1, revision: 3, runs: [run] },
      dropped: 0,
      corrupt: false,
    };
    const restarted = h.createService();
    await restarted.load();
    const restored = restarted.snapshot().runs.find((entry) => entry.id === run.id);
    expect(restored?.status).toBe('failed');
    expect(restored?.error).toContain('gián đoạn');
    expect(restarted.snapshot().revision).toBe(4);

    h.leader.reply(proposal('Việc'));
    await restarted.retry({ requestId: randomUUID(), runId: run.id });
    await waitFor(
      () => restarted.snapshot().runs.find((entry) => entry.id === run.id)?.status === 'proposed',
    );
  });

  it('keeps a working run without pending reviews as it was', async () => {
    const h = new Harness();
    const run = storedRun({ status: 'working' });
    h.persistence.loaded = {
      file: { version: 1, revision: 1, runs: [run] },
      dropped: 0,
      corrupt: false,
    };
    const restarted = h.createService();
    await restarted.load();
    expect(restarted.snapshot().runs[0]?.status).toBe('working');
  });
});

import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type {
  AgentRole,
  CompanySquadMessage,
  CompanyWorkItemsMessage,
  OmpAgentInfo,
  SquadRun,
  WorkItem,
  WorkItemStatus,
} from '../../core/src/messages.js';
import { WORK_ITEM_PRIORITY_DEFAULT } from '../../core/src/workItemGraph.js';
import { CompanyError } from '../src/company/companyError.js';
import {
  emptySquadFile,
  isOpenItemStatus,
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

const REPO_APP = '/work/folder/app';

/** The omp agents the folder offers. The read-only ones change no files. */
const AGENTS: OmpAgentInfo[] = [
  { name: 'task', description: 'Làm việc', readOnly: false, source: 'bundled' },
  { name: 'sonic', description: 'Việc cơ học', readOnly: false, source: 'bundled' },
  { name: 'scout', description: 'Tìm thông tin', readOnly: true, source: 'bundled' },
  { name: 'reviewer', description: 'Review code', readOnly: true, source: 'bundled' },
  { name: 'security-reviewer', description: 'Review bảo mật', readOnly: true, source: 'bundled' },
];

/** A plan that passes the completeness check: a task with acceptance, then a review that waits for it. */
const CLEAN_REPLY = JSON.stringify({
  assignments: [
    { assignee: 'auto', text: 'Viết trang giới thiệu', reason: 'Lý do', acceptance: 'Có test' },
    {
      assignee: 'auto',
      agent: 'reviewer',
      text: 'Review trang giới thiệu',
      reason: 'Lý do',
      acceptance: 'Không lỗi',
      dependsOn: [0],
    },
  ],
  note: 'Ghi chú',
  done: false,
});

/** In-memory work items. A settle notifies the settle listeners the way the work item service does. */
class FakeWorkItems implements SquadWorkItems {
  readonly items: WorkItem[] = [];
  readonly creates: { drafts: WorkItemDraft[]; squadRunId: string }[] = [];
  /** The folder's settings. Automatic judging is off unless a test turns it on. */
  readonly settings: CompanyWorkItemsMessage['settings'] = {
    maxParallel: 4,
    maxSquadSessions: 3,
    minFreeRamGb: 2,
    autoJudge: false,
    autoApproveNext: false,
    brain: 'omp',
    claudeModelLeader: 'opus',
    claudeModelJudge: 'sonnet',
    preferClaude: false,
    maxClaudeRuns: 2,
    claudeMaxTurns: 40,
    claudeMaxBudgetUsd: 3,
    claudePermission: 'auto',
    claudeAllowedTools: [],
  };
  /** The folder's repos: the paths a row may name. */
  readonly repos: string[] = [REPO_APP];
  readonly agents: OmpAgentInfo[] = AGENTS;
  /** Set to make creates fail, as a failed save does. */
  createError: Error | null = null;
  private readonly changeListeners = new Set<() => void>();
  private readonly settleListeners = new Set<(item: WorkItem) => void>();
  private sequence = 0;

  snapshot(): CompanyWorkItemsMessage {
    const roles: AgentRole[] = [];
    return {
      type: 'companyWorkItems',
      workspacePath: WORKSPACE,
      revision: this.sequence,
      items: structuredClone(this.items),
      roles,
      settings: { ...this.settings },
      repos: [...this.repos],
      agents: structuredClone(this.agents),
    };
  }

  get(id: string): WorkItem | undefined {
    const item = this.items.find((entry) => entry.id === id);
    return item === undefined ? undefined : structuredClone(item);
  }

  findOpen(sequence: number): WorkItem | undefined {
    const item = this.items.find(
      (entry) => entry.sequence === sequence && isOpenItemStatus(entry.status),
    );
    return item === undefined ? undefined : structuredClone(item);
  }

  /** Creates a batch as the work item service does: every id is minted before any wait is mapped. */
  async createWorkItems(
    drafts: readonly WorkItemDraft[],
    options: { squadRunId: string },
  ): Promise<string[]> {
    if (this.createError !== null) throw this.createError;
    this.creates.push({ drafts: [...drafts], squadRunId: options.squadRunId });
    const ids = drafts.map(() => randomUUID());
    const idOf = (position: number): string => {
      const id = ids[position];
      if (id === undefined) throw new Error(`no draft ${position}`);
      return id;
    };
    drafts.forEach((draft, index) => {
      this.sequence += 1;
      this.items.push({
        id: idOf(index),
        text: draft.text,
        assignee: draft.assignee,
        status: 'queued',
        sequence: this.sequence,
        priority: draft.priority ?? WORK_ITEM_PRIORITY_DEFAULT,
        ...(draft.acceptance === undefined ? {} : { acceptance: draft.acceptance }),
        dependsOn: [...(draft.dependsOn ?? []), ...(draft.dependsOnDrafts ?? []).map(idOf)],
        squadRunId: options.squadRunId,
        createdAt: AT,
        updatedAt: AT,
        history: [],
      });
    });
    this.notifyChange();
    return ids;
  }

  /** A manual item, as the board makes one: queued, with no squad run. */
  addManual(text: string, acceptance?: string): string {
    this.sequence += 1;
    const id = randomUUID();
    this.items.push({
      id,
      text,
      assignee: { kind: 'new-session' },
      status: 'queued',
      sequence: this.sequence,
      priority: WORK_ITEM_PRIORITY_DEFAULT,
      ...(acceptance === undefined ? {} : { acceptance }),
      dependsOn: [],
      createdAt: AT,
      updatedAt: AT,
      history: [],
    });
    this.notifyChange();
    return id;
  }

  onChange(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => {
      this.changeListeners.delete(listener);
    };
  }

  onItemSettled(listener: (item: WorkItem) => void): () => void {
    this.settleListeners.add(listener);
    return () => {
      this.settleListeners.delete(listener);
    };
  }

  /** Moves an item to review with a result, the way the work item service does. */
  review(id: string, at: string, result: string): void {
    this.settle(id, 'review', at, result);
  }

  /**
   * Moves an item to a settled status and tells the settle listeners. A failed item keeps its text
   * as the reason; the others keep it as the result, as the work item service does.
   */
  settle(id: string, status: 'review' | 'done' | 'failed', at: string, text: string): void {
    const item = this.find(id);
    item.status = status;
    item.updatedAt = at;
    if (status === 'failed') item.reason = text;
    else item.result = text;
    for (const listener of this.settleListeners) listener(structuredClone(item));
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

/** Lets any turn that should start do so. Used where no turn may start, so the wait is a fixed count. */
async function letTurnsPass(): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) await Promise.resolve();
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
        priority: WORK_ITEM_PRIORITY_DEFAULT,
        dependsOn: [],
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

describe('SquadService requests from a finished item', () => {
  it('refuses a request that has both text and an item, or neither', async () => {
    const h = new Harness();
    const id = h.workItems.addManual('Việc');
    h.workItems.review(id, h.stamp(), 'Xong');
    const both = await rejectionOf(
      h.service.request({ requestId: randomUUID(), text: 'Làm', fromWorkItemId: id }),
    );
    expect((both as CompanyError).code).toBe('invalid_request');
    const neither = await rejectionOf(h.service.request({ requestId: randomUUID() }));
    expect((neither as CompanyError).code).toBe('invalid_request');
    expect(h.service.snapshot().runs).toHaveLength(0);
  });

  it('refuses an item the board does not have', async () => {
    const h = new Harness();
    const refused = await rejectionOf(
      h.service.request({ requestId: randomUUID(), fromWorkItemId: randomUUID() }),
    );
    expect((refused as CompanyError).code).toBe('work_item_not_found');
  });

  it('refuses an item that is not in review, or that a squad already made', async () => {
    const h = new Harness();
    const queued = h.workItems.addManual('Việc chưa xong');
    const notReview = await rejectionOf(
      h.service.request({ requestId: randomUUID(), fromWorkItemId: queued }),
    );
    expect((notReview as CompanyError).code).toBe('work_item_status');

    const { runId, proposalId } = await approvedRun(h, 'Viết form');
    h.leader.reply(DONE_REPLY);
    const [squadItem] = h.itemsOf(proposalId);
    if (squadItem === undefined) throw new Error('no item');
    h.workItems.review(squadItem.id, h.stamp(), 'Xong');
    await waitFor(() => h.runOf(runId)?.status === 'done');
    const fromSquad = await rejectionOf(
      h.service.request({ requestId: randomUUID(), fromWorkItemId: squadItem.id }),
    );
    expect((fromSquad as CompanyError).code).toBe('work_item_status');
  });

  it('starts a run from a finished item: its text, done-when line, and result', async () => {
    const h = new Harness();
    const id = h.workItems.addManual('Viết form đăng nhập', 'Có test form');
    h.workItems.review(id, h.stamp(), 'Đã viết');
    h.leader.reply(proposal('Viết test cho form'));
    const runId = await h.service.request({ requestId: randomUUID(), fromWorkItemId: id });
    await waitFor(() => h.runOf(runId)?.status === 'proposed');
    expect(h.runOf(runId)?.request).toBe(
      'Viết form đăng nhập\n\nXong khi: Có test form\n\nKết quả:\nĐã viết',
    );
    expect(h.leader.prompts[0]).toContain('Xong khi: Có test form');
  });

  it('answers a second request for the same item with its open run, and starts nothing new', async () => {
    const h = new Harness();
    const id = h.workItems.addManual('Viết form đăng nhập', 'Có test form');
    h.workItems.review(id, h.stamp(), 'Đã viết');
    h.leader.reply(proposal('Viết test cho form'));
    const runId = await h.service.request({ requestId: randomUUID(), fromWorkItemId: id });
    const again = await h.service.request({ requestId: randomUUID(), fromWorkItemId: id });
    expect(again).toBe(runId);
    await waitFor(() => h.runOf(runId)?.status === 'proposed');
    expect(await h.service.request({ requestId: randomUUID(), fromWorkItemId: id })).toBe(runId);
    expect(h.service.snapshot().runs).toHaveLength(1);
    expect(h.leader.prompts).toHaveLength(1);
  });

  it('starts a new run from the same item once its run is done or dismissed', async () => {
    const h = new Harness();
    const id = h.workItems.addManual('Viết form đăng nhập');
    h.workItems.review(id, h.stamp(), 'Đã viết');
    h.leader.reply(DONE_REPLY);
    const done = await h.service.request({ requestId: randomUUID(), fromWorkItemId: id });
    await waitFor(() => h.runOf(done)?.status === 'done');

    h.leader.reply(proposal('Viết lại form'));
    const second = await h.service.request({ requestId: randomUUID(), fromWorkItemId: id });
    expect(second).not.toBe(done);
    await waitFor(() => h.runOf(second)?.status === 'proposed');
    const proposalId = h.runOf(second)?.proposal?.id;
    if (proposalId === undefined) throw new Error('no proposal');
    await h.service.dismiss({ requestId: randomUUID(), runId: second, proposalId });
    expect(h.runOf(second)?.status).toBe('dismissed');

    h.leader.reply(proposal('Việc khác'));
    const third = await h.service.request({ requestId: randomUUID(), fromWorkItemId: id });
    expect(third).not.toBe(second);
    expect(third).not.toBe(done);
  });

  it('keeps the item each run started from across a restart, so a second press still answers with that run', async () => {
    const h = new Harness();
    const id = h.workItems.addManual('Viết form đăng nhập');
    h.workItems.review(id, h.stamp(), 'Đã viết');
    h.leader.reply(proposal('Viết test cho form'));
    const runId = await h.service.request({ requestId: randomUUID(), fromWorkItemId: id });
    await waitFor(() => h.runOf(runId)?.status === 'proposed');
    await waitFor(() => h.persistence.saves.at(-1)?.runs[0]?.status === 'proposed');
    const saved = h.persistence.saves.at(-1);
    if (saved === undefined) throw new Error('nothing saved');
    expect(saved.runs[0]?.fromWorkItemId).toBe(id);

    h.persistence.loaded = { file: saved, dropped: 0, corrupt: false };
    const restarted = h.createService();
    await restarted.load();
    expect(await restarted.request({ requestId: randomUUID(), fromWorkItemId: id })).toBe(runId);
    expect(restarted.snapshot().runs).toHaveLength(1);
  });
});

describe('SquadService waits and priorities', () => {
  it('creates a row that waits for an open item by its id and a later row by its position', async () => {
    const h = new Harness();
    const openId = h.workItems.addManual('Việc đang mở');
    h.leader.reply(proposal('Việc mới'));
    const runId = await h.service.request({ requestId: randomUUID(), text: 'Làm' });
    await waitFor(() => h.runOf(runId)?.status === 'proposed');
    const current = h.runOf(runId)?.proposal;
    if (current === undefined) throw new Error('no proposal');
    await h.service.approve({
      requestId: randomUUID(),
      runId,
      proposalId: current.id,
      rows: [
        {
          text: 'Việc một',
          assignee: { kind: 'new-session' },
          priority: 0,
          acceptance: 'Có test',
          dependsOn: [{ kind: 'item', sequence: 1 }],
        },
        {
          text: 'Việc hai',
          assignee: { kind: 'new-session' },
          dependsOn: [{ kind: 'row', row: 0 }],
        },
      ],
    });
    const [first, second] = h.itemsOf(current.id);
    expect(first?.priority).toBe(0);
    expect(first?.acceptance).toBe('Có test');
    expect(first?.dependsOn).toEqual([openId]);
    expect(second?.priority).toBe(WORK_ITEM_PRIORITY_DEFAULT);
    expect(second?.dependsOn).toEqual([first?.id]);
    expect(h.runOf(runId)?.proposal?.rows).toEqual([
      {
        text: 'Việc một',
        assignee: { kind: 'new-session' },
        priority: 0,
        acceptance: 'Có test',
        dependsOn: [{ kind: 'item', sequence: 1 }],
      },
      {
        text: 'Việc hai',
        assignee: { kind: 'new-session' },
        priority: WORK_ITEM_PRIORITY_DEFAULT,
        dependsOn: [{ kind: 'row', row: 0 }],
      },
    ]);
  });

  it('refuses an approval that waits for an item that is not open, or for a loop', async () => {
    const h = new Harness();
    h.leader.reply(proposal('Việc'));
    const runId = await h.service.request({ requestId: randomUUID(), text: 'Làm' });
    await waitFor(() => h.runOf(runId)?.status === 'proposed');
    const proposalId = h.runOf(runId)?.proposal?.id ?? '';
    const unknown = await rejectionOf(
      h.service.approve({
        requestId: randomUUID(),
        runId,
        proposalId,
        rows: [
          {
            text: 'Việc',
            assignee: { kind: 'new-session' },
            dependsOn: [{ kind: 'item', sequence: 9 }],
          },
        ],
      }),
    );
    expect((unknown as CompanyError).code).toBe('squad_rows_invalid');
    expect((unknown as CompanyError).message).toContain('#9');
    const loop = await rejectionOf(
      h.service.approve({
        requestId: randomUUID(),
        runId,
        proposalId,
        rows: [
          { text: 'A', assignee: { kind: 'new-session' }, dependsOn: [{ kind: 'row', row: 1 }] },
          { text: 'B', assignee: { kind: 'new-session' }, dependsOn: [{ kind: 'row', row: 0 }] },
        ],
      }),
    );
    expect((loop as CompanyError).code).toBe('squad_rows_invalid');
    expect(h.workItems.creates).toHaveLength(0);
  });

  it('answers a resent approval whose wait is no longer open, without creating again', async () => {
    const h = new Harness();
    const openId = h.workItems.addManual('Việc đang mở');
    h.leader.reply(proposal('Việc'));
    const runId = await h.service.request({ requestId: randomUUID(), text: 'Làm' });
    await waitFor(() => h.runOf(runId)?.status === 'proposed');
    const current = h.runOf(runId)?.proposal;
    if (current === undefined) throw new Error('no proposal');
    const rows = [
      {
        text: 'Việc',
        assignee: { kind: 'new-session' },
        dependsOn: [{ kind: 'item', sequence: 1 }],
      },
    ];
    await h.service.approve({ requestId: randomUUID(), runId, proposalId: current.id, rows });
    h.workItems.setStatus(openId, 'done');
    await h.service.approve({ requestId: randomUUID(), runId, proposalId: current.id, rows });
    expect(h.workItems.creates).toHaveLength(1);
  });

  it('fails the turn when the leader waits for an item that is not open, or sets a bad priority', async () => {
    const h = new Harness();
    h.leader.reply(
      JSON.stringify({
        assignments: [{ assignee: 'herdr:wA:p1', text: 'Làm', dependsOn: ['#9'] }],
        note: '',
        done: false,
      }),
    );
    const first = await h.service.request({ requestId: randomUUID(), text: 'Làm' });
    await waitFor(() => h.runOf(first)?.status === 'failed');
    expect(h.runOf(first)?.error).toContain('#9');

    h.leader.reply(
      JSON.stringify({
        assignments: [{ assignee: 'herdr:wA:p1', text: 'Làm', priority: 4 }],
        note: '',
        done: false,
      }),
    );
    const second = await h.service.request({ requestId: randomUUID(), text: 'Làm khác' });
    await waitFor(() => h.runOf(second)?.status === 'failed');
    expect(h.runOf(second)?.error).toContain('độ ưu tiên');
  });

  it('lets the leader wait for an open item of this run in a later turn', async () => {
    const h = new Harness();
    const { runId, proposalId } = await approvedRun(h, 'Viết form đăng nhập');
    const [item] = h.itemsOf(proposalId);
    if (item === undefined) throw new Error('no item');
    expect(item.sequence).toBe(1);
    h.leader.reply(
      JSON.stringify({
        assignments: [{ assignee: 'herdr:wA:p1', text: 'Viết test', dependsOn: ['#1'] }],
        note: '',
        done: false,
      }),
    );
    h.workItems.review(item.id, h.stamp(), 'Form đã xong');
    await waitFor(() => h.runOf(runId)?.status === 'proposed');
    expect(h.runOf(runId)?.proposal?.rows[0]?.dependsOn).toEqual([{ kind: 'item', sequence: 1 }]);
  });

  it('shows the done-when text of a finished item to the leader with its result', async () => {
    const h = new Harness();
    h.leader.reply(proposal('Viết form'));
    const runId = await h.service.request({ requestId: randomUUID(), text: 'Làm' });
    await waitFor(() => h.runOf(runId)?.status === 'proposed');
    const current = h.runOf(runId)?.proposal;
    if (current === undefined) throw new Error('no proposal');
    await h.service.approve({
      requestId: randomUUID(),
      runId,
      proposalId: current.id,
      rows: [
        {
          text: 'Viết form',
          assignee: { kind: 'herdr', paneId: 'wA:p1' },
          acceptance: 'Có test form',
          dependsOn: [],
        },
      ],
    });
    const [item] = h.itemsOf(current.id);
    if (item === undefined) throw new Error('no item');
    h.leader.reply(DONE_REPLY);
    h.workItems.review(item.id, h.stamp(), 'Form đã xong');
    await waitFor(() => h.runOf(runId)?.status === 'done');
    expect(h.leader.prompts[1]).toContain('done when: Có test form');
    expect(h.leader.prompts[1]).toContain('result: Form đã xong');
  });
});

describe('SquadService completeness, settles and automatic approval', () => {
  it('keeps the completeness warnings with the proposal and hints at a herdr subagent', async () => {
    const h = new Harness();
    h.leader.reply(
      JSON.stringify({
        assignments: [
          { assignee: 'herdr:wA:p1', text: 'Tìm nguồn', reason: 'Lý do', agent: 'scout' },
        ],
        note: '',
        done: false,
      }),
    );
    const runId = await h.service.request({ requestId: randomUUID(), text: 'Làm' });
    await waitFor(() => h.runOf(runId)?.status === 'proposed');
    expect(h.runOf(runId)?.proposal?.warnings).toContain('Agent herdr: subagent chỉ là gợi ý (#1)');
  });

  it('refuses a row for a repo the folder does not have, and creates nothing', async () => {
    const h = new Harness();
    h.leader.reply(proposal('Việc'));
    const runId = await h.service.request({ requestId: randomUUID(), text: 'Làm' });
    await waitFor(() => h.runOf(runId)?.status === 'proposed');
    const proposalId = h.runOf(runId)?.proposal?.id ?? '';
    const refused = await rejectionOf(
      h.service.approve({
        requestId: randomUUID(),
        runId,
        proposalId,
        rows: [
          {
            text: 'Việc',
            assignee: { kind: 'new-session' },
            repo: '/elsewhere/api',
            dependsOn: [],
          },
        ],
      }),
    );
    expect((refused as CompanyError).code).toBe('squad_rows_invalid');
    expect(h.workItems.creates).toHaveLength(0);
  });

  it('creates drafts with the repo, role, agent and areas the board kept', async () => {
    const h = new Harness();
    h.leader.reply(proposal('Việc'));
    const runId = await h.service.request({ requestId: randomUUID(), text: 'Làm' });
    await waitFor(() => h.runOf(runId)?.status === 'proposed');
    const proposalId = h.runOf(runId)?.proposal?.id ?? '';
    await h.service.approve({
      requestId: randomUUID(),
      runId,
      proposalId,
      rows: [
        {
          text: 'Viết form',
          assignee: { kind: 'new-session' },
          repo: REPO_APP,
          role: 'worker',
          agent: 'sonic',
          areas: ['web:src/app'],
          acceptance: 'Có test',
          dependsOn: [],
        },
      ],
    });
    expect(h.workItems.creates[0]?.drafts[0]).toMatchObject({
      repo: REPO_APP,
      role: 'worker',
      agent: 'sonic',
      areas: ['web:src/app'],
    });
  });

  it('a settle seen twice starts one leader turn', async () => {
    const h = new Harness();
    const { runId, proposalId } = await approvedRun(h, 'Viết trang');
    h.leader.reply(proposal('Việc tiếp'));
    const [item] = h.itemsOf(proposalId);
    if (item === undefined) throw new Error('no item');
    h.workItems.review(item.id, h.stamp(), 'Xong');
    await waitFor(() => h.runOf(runId)?.status === 'proposed' && h.runOf(runId)?.turns === 2);
    const settled = h.workItems.get(item.id);
    if (settled === undefined) throw new Error('no item');
    h.service.onItemSettled(settled);
    await letTurnsPass();
    expect(h.leader.prompts).toHaveLength(2);
    expect(h.runOf(runId)?.status).toBe('proposed');
  });

  it('a failed item starts the next leader turn even when judging is automatic', async () => {
    const h = new Harness();
    h.workItems.settings.autoJudge = true;
    const { runId, proposalId } = await approvedRun(h, 'Viết form');
    h.leader.reply(proposal('Sửa lỗi build'));
    const [item] = h.itemsOf(proposalId);
    if (item === undefined) throw new Error('no item');
    h.workItems.settle(item.id, 'failed', h.stamp(), 'Lỗi build');
    await waitFor(() => h.runOf(runId)?.turns === 2);
    expect(h.leader.prompts[1]).toContain('[failed]');
    expect(h.leader.prompts[1]).toContain('result: Lỗi build');
  });

  it('with automatic judging a review waits for the judge, and a done item starts the next turn', async () => {
    const h = new Harness();
    h.workItems.settings.autoJudge = true;
    const { runId, proposalId } = await approvedRun(h, 'Viết trang');
    const [item] = h.itemsOf(proposalId);
    if (item === undefined) throw new Error('no item');
    h.workItems.review(item.id, h.stamp(), 'Đã viết');
    await letTurnsPass();
    expect(h.leader.prompts).toHaveLength(1);

    h.leader.reply(proposal('Việc sau khi duyệt'));
    h.workItems.settle(item.id, 'done', h.stamp(), 'Đạt');
    await waitFor(() => h.runOf(runId)?.turns === 2);
    expect(h.leader.prompts[1]).toContain('[done]');
  });

  it('with manual judging an unfinished plan starts no turn until its last item is done', async () => {
    const h = new Harness();
    h.leader.reply(proposal('Việc'));
    const runId = await h.service.request({ requestId: randomUUID(), text: 'Làm' });
    await waitFor(() => h.runOf(runId)?.status === 'proposed');
    const proposalId = h.runOf(runId)?.proposal?.id ?? '';
    await h.service.approve({
      requestId: randomUUID(),
      runId,
      proposalId,
      rows: [
        {
          text: 'Việc một',
          assignee: { kind: 'new-session' },
          acceptance: 'Có test',
          dependsOn: [],
        },
        {
          text: 'Việc hai',
          assignee: { kind: 'new-session' },
          acceptance: 'Có test',
          dependsOn: [],
        },
      ],
    });
    h.leader.reply(proposal('Việc sau hai việc'));
    const [first, second] = h.itemsOf(proposalId);
    if (first === undefined || second === undefined) throw new Error('no items');
    h.workItems.settle(first.id, 'done', h.stamp(), 'Xong');
    await letTurnsPass();
    expect(h.leader.prompts).toHaveLength(1);

    h.workItems.settle(second.id, 'done', h.stamp(), 'Xong');
    await waitFor(() => h.runOf(runId)?.turns === 2);
    expect(h.leader.prompts[1]).toContain('[done]');
  });

  it('autoApproveNext approves a clean next step and records it', async () => {
    const h = new Harness();
    h.workItems.settings.autoApproveNext = true;
    const { runId, proposalId } = await approvedRun(h, 'Viết form');
    h.leader.reply(CLEAN_REPLY);
    const [item] = h.itemsOf(proposalId);
    if (item === undefined) throw new Error('no item');
    h.workItems.review(item.id, h.stamp(), 'Đã viết');
    await waitFor(() => h.workItems.creates.length === 2);
    await waitFor(() => h.runOf(runId)?.status === 'working');
    expect(h.workItems.creates[1]?.drafts).toHaveLength(2);
    expect(h.runOf(runId)?.history.some((event) => event.message?.startsWith('Tự duyệt'))).toBe(
      true,
    );
  });

  it('autoApproveNext leaves a proposal with a warning for the user to approve', async () => {
    const h = new Harness();
    h.workItems.settings.autoApproveNext = true;
    const { runId, proposalId } = await approvedRun(h, 'Viết form');
    h.leader.reply(proposal('Viết trang giới thiệu'));
    const [item] = h.itemsOf(proposalId);
    if (item === undefined) throw new Error('no item');
    h.workItems.review(item.id, h.stamp(), 'Đã viết');
    await waitFor(() => h.runOf(runId)?.turns === 2);
    await letTurnsPass();
    expect(h.runOf(runId)?.proposal?.status).toBe('pending');
    expect(h.runOf(runId)?.proposal?.warnings.length).toBeGreaterThan(0);
    expect(h.workItems.creates).toHaveLength(1);
  });

  it('a failed automatic approval keeps the proposal pending and says so in the history', async () => {
    const h = new Harness();
    h.workItems.settings.autoApproveNext = true;
    const { runId, proposalId } = await approvedRun(h, 'Viết form');
    h.workItems.createError = new Error('ghi lỗi');
    h.leader.reply(CLEAN_REPLY);
    const [item] = h.itemsOf(proposalId);
    if (item === undefined) throw new Error('no item');
    h.workItems.review(item.id, h.stamp(), 'Đã viết');
    await waitFor(() => h.runOf(runId)?.history.at(-1)?.kind === 'failed');
    expect(h.runOf(runId)?.history.at(-1)?.message).toContain('Không tự duyệt được đề xuất');
    expect(h.runOf(runId)?.proposal?.status).toBe('pending');
  });

  it('with automatic judging a review that overlaps another item still starts a leader turn', async () => {
    const h = new Harness();
    h.workItems.settings.autoJudge = true;
    const { runId, proposalId } = await approvedRun(h, 'Viết trang');
    const [item] = h.itemsOf(proposalId);
    if (item === undefined) throw new Error('no item');
    item.conflicts = { sequences: [3], main: false };
    h.leader.reply(proposal('Gộp việc chồng lấn'));
    h.workItems.review(item.id, h.stamp(), 'Đã viết');
    await waitFor(() => h.runOf(runId)?.turns === 2);
    expect(h.leader.prompts[1]).toContain('conflicts: #3');
  });

  it('a conflict review settled twice with the same overlap is read once', async () => {
    const h = new Harness();
    h.workItems.settings.autoJudge = true;
    const { runId, proposalId } = await approvedRun(h, 'Viết trang');
    const [item] = h.itemsOf(proposalId);
    if (item === undefined) throw new Error('no item');
    item.conflicts = { sequences: [3], main: false };
    h.leader.reply(proposal('Gộp việc chồng lấn'));
    const at = h.stamp();
    h.workItems.review(item.id, at, 'Đã viết');
    h.workItems.review(item.id, at, 'Đã viết');
    await waitFor(() => h.runOf(runId)?.turns === 2);
    await letTurnsPass();
    expect(h.leader.prompts).toHaveLength(2);
    expect(h.leader.prompts[1]?.match(/conflicts: #3/g)?.length).toBe(1);
  });

  it('a review settled after its overlap clears starts no leader turn', async () => {
    const h = new Harness();
    h.workItems.settings.autoJudge = true;
    const { runId, proposalId } = await approvedRun(h, 'Viết trang');
    const [item] = h.itemsOf(proposalId);
    if (item === undefined) throw new Error('no item');
    item.conflicts = { sequences: [3], main: false };
    h.leader.reply(proposal('Gộp việc chồng lấn'));
    h.workItems.review(item.id, h.stamp(), 'Đã viết');
    await waitFor(() => h.runOf(runId)?.status === 'proposed' && h.runOf(runId)?.turns === 2);
    expect(h.leader.prompts[1]).toContain('conflicts: #3');

    const current = h.runOf(runId)?.proposal;
    if (current === undefined) throw new Error('no proposal');
    await h.service.approve({
      requestId: randomUUID(),
      runId,
      proposalId: current.id,
      rows: current.rows,
    });

    delete item.conflicts;
    h.workItems.review(item.id, h.stamp(), 'Đã viết');
    await letTurnsPass();
    expect(h.leader.prompts).toHaveLength(2);
    expect(h.runOf(runId)?.turns).toBe(2);
  });
});

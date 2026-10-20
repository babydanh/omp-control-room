import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { LedgerOverlapScan, WorkItem } from '../../core/src/messages.js';
import { BUNDLED_AGENTS } from '../src/company/workItems/agentCatalog.js';
import {
  EVIDENCE_REQUEST,
  JUDGE_NOT_MET_PREFIX,
  notMetReason,
} from '../src/company/workItems/judgeModel.js';
import { GIB, SQUAD_SETTINGS_DEFAULT } from '../src/company/workItems/squadSettings.js';
import { parseWorkItemsFile } from '../src/company/workItems/workItemModel.js';
import { WorkItemService } from '../src/company/workItems/workItemService.js';
import { FakeClaudeAuth, FakeClaudeMcp, FakeClaudeRuns } from './fakeClaude.js';

const T0 = Date.parse('2026-05-01T08:00:00.000Z');
const WORKSPACE = '/work/folder';
const WORKER = 's-worker';
/** How long the service waits between conflict re-checks while a board watches the ledger. */
const RECHECK_MS = 2 * 60_000;

interface SessionState {
  id: string;
  status: string;
  role: string;
}

/** One judge turn the service started. The test answers it by hand. */
interface JudgeTurn {
  readonly prompt: string;
  readonly signal: AbortSignal;
  resolve(text: string): void;
  reject(error: Error): void;
}

interface Timer {
  readonly dueAt: number;
  readonly run: () => void;
  cancelled: boolean;
}

/** In-memory ports. Judge turns wait until a test answers them; time moves only through `advance`. */
class JudgeFixture {
  readonly sessions: SessionState[] = [{ id: WORKER, status: 'idle', role: 'worker' }];
  readonly submits: { sessionId: string; text: string; mode: 'chat' | 'company' }[] = [];
  readonly judgeTurns: JudgeTurn[] = [];
  scans: readonly LedgerOverlapScan[] = [];
  watching = false;
  now = T0;
  private timers: Timer[] = [];
  readonly service: WorkItemService;

  constructor() {
    this.service = new WorkItemService(WORKSPACE, {
      roster: {
        panes: () => ({ available: true, panes: [] }),
        prompt: async () => undefined,
        screenText: async () => '',
      },
      sessions: {
        list: () => this.sessions.map((session) => ({ ...session })),
        submit: async (sessionId, text, mode) => {
          this.submits.push({ sessionId, text, mode });
        },
        openChat: async () => {
          throw new Error('bài kiểm thử này không mở phiên mới');
        },
        wake: async () => undefined,
        park: async () => true,
      },
      persistence: {
        load: async () => parseWorkItemsFile(null),
        save: async () => undefined,
      },
      worktrees: {
        create: async (repo, shortId) => ({
          path: `${repo}/.worktrees/squad-${shortId}`,
          branch: `squad-${shortId}`,
        }),
        remove: async () => 'removed',
      },
      publish: () => undefined,
      now: () => this.now,
      newId: () => randomUUID(),
      schedule: (run, ms) => {
        const timer: Timer = { dueAt: this.now + ms, run, cancelled: false };
        this.timers.push(timer);
        return () => {
          timer.cancelled = true;
        };
      },
      catalog: async () => ({ repos: [], agents: BUNDLED_AGENTS, claudeAgents: [] }),
      freeMemoryBytes: () => 8 * GIB,
      judge: (prompt, signal) =>
        new Promise<string>((resolve, reject) => {
          this.judgeTurns.push({ prompt, signal, resolve, reject });
        }),
      overlaps: async () => this.scans,
      boardWatching: () => this.watching,
      claude: new FakeClaudeRuns(),
      claudeAuth: new FakeClaudeAuth(),
      claudeMcp: new FakeClaudeMcp(),
    });
  }

  /** Moves the clock, runs the checks that have come due, then lets their promise callbacks run. */
  async advance(ms: number): Promise<void> {
    this.now += ms;
    const due = this.timers.filter((timer) => !timer.cancelled && timer.dueAt <= this.now);
    this.timers = this.timers.filter((timer) => !timer.cancelled && timer.dueAt > this.now);
    for (const timer of due) timer.run();
    await settle();
    await this.service.reconcileNow();
  }

  setSession(id: string, status: string): void {
    const session = this.sessions.find((entry) => entry.id === id);
    if (session === undefined) throw new Error(`no session ${id}`);
    session.status = status;
  }
}

/** Lets the promise callbacks queued so far run. Microtasks only; no timer is involved. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 50; turn += 1) await Promise.resolve();
}

async function openFixture(autoJudge = true): Promise<JudgeFixture> {
  const f = new JudgeFixture();
  await f.service.load();
  await f.service.setSettings({
    requestId: randomUUID(),
    settings: { ...SQUAD_SETTINGS_DEFAULT, autoJudge },
  });
  return f;
}

function itemOf(f: JudgeFixture, id: string): WorkItem {
  const item = f.service.snapshot().items.find((entry) => entry.id === id);
  if (item === undefined) throw new Error(`no work item ${id}`);
  return item;
}

/** An item assigned to the worker session. It has no repo, so its checkout is the workspace. */
async function createSessionItem(f: JudgeFixture, text: string): Promise<string> {
  return f.service.create({
    requestId: randomUUID(),
    text,
    assignee: { kind: 'session', sessionId: WORKER },
  });
}

/** One worker turn: the session goes busy, then idle again. The item reaches review and is judged. */
async function finishWorkerTurn(f: JudgeFixture): Promise<void> {
  f.setSession(WORKER, 'busy');
  await f.service.reconcileNow();
  f.setSession(WORKER, 'idle');
  await f.service.reconcileNow();
  await settle();
}

function judgeTurn(f: JudgeFixture, index: number): JudgeTurn {
  const turn = f.judgeTurns[index];
  if (turn === undefined) throw new Error(`no judge turn ${index}`);
  return turn;
}

/** Answers the newest judge turn with `text`, then lets the service apply the reply. */
async function replyToJudge(f: JudgeFixture, text: string): Promise<void> {
  judgeTurn(f, f.judgeTurns.length - 1).resolve(text);
  await settle();
  await f.service.reconcileNow();
}

/** Makes the newest judge turn fail, as an unreachable judge would. */
async function failJudge(f: JudgeFixture, message: string): Promise<void> {
  judgeTurn(f, f.judgeTurns.length - 1).reject(new Error(message));
  await settle();
}

/** A judge reply in the strict JSON shape the judge is asked for. */
function verdictJson(verdict: string, reason: string, followUp = ''): string {
  return JSON.stringify({ verdict, reason, followUp });
}

/** A ledger scan that puts the workspace checkout, where a repo-less item works, in conflict with main. */
function mainConflictScan(): LedgerOverlapScan {
  return {
    repo: WORKSPACE,
    state: 'done',
    startedAt: null,
    finishedAt: null,
    base: null,
    lanes: 1,
    pairs: [],
    main: [
      {
        lane: WORKSPACE,
        label: 'checkout chính',
        conflicts: [{ file: 'src/app.ts', hunks: [] }],
      },
    ],
    pending: [],
    complete: true,
    error: null,
  };
}

describe('WorkItemService judge flow', () => {
  it('passes a reviewed item on a pass verdict: done, history line, and settle listeners', async () => {
    const f = await openFixture();
    const settled: WorkItem[] = [];
    const stop = f.service.onItemSettled((item) => settled.push(item));
    const id = await createSessionItem(f, 'Sửa lỗi đăng nhập');

    await finishWorkerTurn(f);
    expect(itemOf(f, id).status).toBe('review');
    expect(f.judgeTurns).toHaveLength(1);
    expect(f.judgeTurns[0]?.prompt).toContain('Sửa lỗi đăng nhập');

    await replyToJudge(f, verdictJson('pass', 'Đã có bằng chứng', ''));
    expect(itemOf(f, id)).toMatchObject({
      status: 'done',
      judge: { status: 'verdict', verdict: 'pass', reason: 'Đã có bằng chứng' },
    });
    expect(itemOf(f, id).history.map((event) => event.message)).toContain(
      'Giám khảo: đạt — Đã có bằng chứng',
    );
    expect(settled.at(-1)).toMatchObject({ id, status: 'done' });
    expect(f.submits).toHaveLength(1);
    stop();
  });

  it('sends a fail follow-up through the session, then needs the user after two follow-ups', async () => {
    const f = await openFixture();
    const id = await createSessionItem(f, 'Thêm kiểm thử');

    await finishWorkerTurn(f);
    await replyToJudge(
      f,
      verdictJson('fail', 'Thiếu kiểm thử', 'Viết thêm kiểm thử cho nhánh lỗi'),
    );
    expect(itemOf(f, id)).toMatchObject({ status: 'running', judge: { followUps: 1 } });
    expect(f.submits).toHaveLength(2);
    expect(f.submits[1]?.text).toContain('Viết thêm kiểm thử cho nhánh lỗi');

    await finishWorkerTurn(f);
    await replyToJudge(f, verdictJson('fail', 'Vẫn thiếu kiểm thử', 'Chạy lại kiểm thử'));
    expect(itemOf(f, id)).toMatchObject({ status: 'running', judge: { followUps: 2 } });
    expect(f.submits).toHaveLength(3);
    expect(f.submits[2]?.text).toContain('Chạy lại kiểm thử');

    await finishWorkerTurn(f);
    expect(f.judgeTurns).toHaveLength(3);
    await replyToJudge(f, verdictJson('fail', 'Vẫn chưa đạt', 'Sửa tiếp'));
    expect(itemOf(f, id)).toMatchObject({
      status: 'needs_input',
      reason: notMetReason('Vẫn chưa đạt'),
      judge: { verdict: 'fail', followUps: 2 },
    });
    expect(itemOf(f, id).reason?.startsWith(JUDGE_NOT_MET_PREFIX)).toBe(true);
    expect(f.submits).toHaveLength(3);
  });

  it('asks for evidence once on need_evidence, and counts a second need_evidence as a fail', async () => {
    const f = await openFixture();
    const id = await createSessionItem(f, 'Đổi cấu hình');

    await finishWorkerTurn(f);
    await replyToJudge(f, verdictJson('need_evidence', 'Chưa có lệnh đã chạy', 'Nêu file đã đổi'));
    expect(f.submits).toHaveLength(2);
    expect(f.submits[1]?.text).toContain(EVIDENCE_REQUEST);
    expect(itemOf(f, id)).toMatchObject({ status: 'running', judge: { followUps: 1 } });

    await finishWorkerTurn(f);
    expect(f.judgeTurns[1]?.prompt).toContain('already asked for that evidence once');
    await replyToJudge(
      f,
      verdictJson('need_evidence', 'Vẫn chưa có bằng chứng', 'Liệt kê lệnh đã chạy'),
    );
    expect(f.submits).toHaveLength(3);
    expect(f.submits[2]?.text).toContain('Liệt kê lệnh đã chạy');
    expect(f.submits[2]?.text).not.toContain(EVIDENCE_REQUEST);
    expect(itemOf(f, id).judge).toMatchObject({ followUps: 2 });
  });

  it('keeps the item in review when the judge port rejects, and judgeAgain starts a new turn', async () => {
    const f = await openFixture();
    const id = await createSessionItem(f, 'Dọn mã');

    await finishWorkerTurn(f);
    await failJudge(f, 'omp không phản hồi');
    expect(itemOf(f, id)).toMatchObject({
      status: 'review',
      judge: { status: 'error', error: 'omp không phản hồi' },
    });
    expect(itemOf(f, id).history.map((event) => event.message)).toContain(
      'Giám khảo lỗi: omp không phản hồi',
    );
    expect(f.submits).toHaveLength(1);

    await f.service.judgeAgain({ requestId: randomUUID(), id });
    expect(f.judgeTurns).toHaveLength(2);
    expect(itemOf(f, id).judge?.status).toBe('running');

    await replyToJudge(f, verdictJson('pass', 'Đã dọn xong', ''));
    expect(itemOf(f, id).status).toBe('done');
  });

  it('treats a reply that is not JSON as a judge error and sends nothing', async () => {
    const f = await openFixture();
    const id = await createSessionItem(f, 'Viết tài liệu');

    await finishWorkerTurn(f);
    await replyToJudge(f, 'Việc này có vẻ đạt rồi.');
    expect(itemOf(f, id)).toMatchObject({ status: 'review', judge: { status: 'error' } });
    expect(
      itemOf(f, id)
        .history.map((event) => event.message)
        .some((message) => message?.startsWith('Giám khảo lỗi: ') === true),
    ).toBe(true);
    expect(f.submits).toHaveLength(1);
  });

  it('discards the judge reply that arrives after the user marked the item done', async () => {
    const f = await openFixture();
    const id = await createSessionItem(f, 'Đã làm xong');

    await finishWorkerTurn(f);
    const turn = judgeTurn(f, 0);
    await f.service.mark({ requestId: randomUUID(), id, verdict: 'done' });
    expect(turn.signal.aborted).toBe(true);
    expect(itemOf(f, id)).toMatchObject({ status: 'done' });
    expect(itemOf(f, id).judge).toBeUndefined();

    turn.resolve(verdictJson('fail', 'Thiếu kiểm thử', 'Làm tiếp'));
    await settle();
    await f.service.reconcileNow();
    expect(itemOf(f, id).status).toBe('done');
    expect(f.submits).toHaveLength(1);
  });

  it('does not pass an item that gained a conflict while its judge ran, and judges again once it clears', async () => {
    const f = await openFixture();
    const id = await createSessionItem(f, 'Đổi tên hàm');

    await finishWorkerTurn(f);
    expect(f.judgeTurns).toHaveLength(1);

    f.scans = [mainConflictScan()];
    f.watching = true;
    await f.advance(RECHECK_MS);
    expect(itemOf(f, id).conflicts).toEqual({ sequences: [], main: true });
    expect(itemOf(f, id).history.map((event) => event.message)).toContain(
      'Xung đột với checkout chính.',
    );
    expect(f.judgeTurns).toHaveLength(1);

    await replyToJudge(f, verdictJson('pass', 'Đạt', ''));
    expect(itemOf(f, id)).toMatchObject({ status: 'review', judge: { status: 'waiting' } });
    expect(itemOf(f, id).history.map((event) => event.message)).not.toContain(
      'Giám khảo: đạt — Đạt',
    );

    f.scans = [];
    await f.advance(RECHECK_MS);
    expect(itemOf(f, id).conflicts).toBeUndefined();
    expect(f.judgeTurns).toHaveLength(2);

    await replyToJudge(f, verdictJson('pass', 'Đạt sau khi hết xung đột', ''));
    expect(itemOf(f, id).status).toBe('done');
  });

  it('does not call the judge when autoJudge is off', async () => {
    const f = await openFixture(false);
    const id = await createSessionItem(f, 'Không chấm tự động');

    await finishWorkerTurn(f);
    expect(itemOf(f, id).status).toBe('review');
    expect(itemOf(f, id).judge).toBeUndefined();
    expect(f.judgeTurns).toEqual([]);
  });
});

import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import type { WorkItem, WorkItemCloudIssue } from '../../core/src/messages.js';
import { type AgentFolder, registerAgentRoutes, sessionRows } from '../src/agentApi/agentApi.js';
import { formatStatus, formatTask, parseBoardArgs, readStatusAnswer, readTaskAnswer } from '../src/boardCli.js';

const TOKEN = 'secret';
const AUTH = { authorization: `Bearer ${TOKEN}` };

function item(overrides: Partial<WorkItem> & Pick<WorkItem, 'id' | 'sequence'>): WorkItem {
  return {
    text: 'Sửa API',
    assignee: { kind: 'auto' },
    status: 'running',
    priority: 2,
    dependsOn: [],
    history: [],
    createdAt: '2026-10-21T08:00:00.000Z',
    updatedAt: '2026-10-21T08:00:00.000Z',
    ...overrides,
  };
}

function folder(
  path: string,
  items: WorkItem[],
  notes: { id: string; text: string }[],
  cloudIssues: WorkItemCloudIssue[] = [],
): AgentFolder {
  return {
    path,
    service: {
      snapshot: () => ({ type: 'companyWorkItems', items, cloudIssues, settings: {} }) as never,
      note: async ({ id, text }) => {
        notes.push({ id, text });
      },
    },
  };
}

async function app(
  folders: AgentFolder[],
  guardRiskCounts?: { readonly red: number; readonly yellow: number },
) {
  const server = Fastify();
  registerAgentRoutes(server, {
    token: TOKEN,
    sessions: async () => [{ folder: 'D:/p', agent: 'omp', state: 'working', title: 'Sửa API', cwd: 'D:/p/api.worktrees/x', paneId: 'wA:p2' }],
    folders: () => folders,
    ...(guardRiskCounts === undefined ? {} : { guardRiskCounts: async () => guardRiskCounts }),
  });
  await server.ready();
  return server;
}

describe('agent API', () => {
  const mine = item({ id: 'i1', sequence: 3, assignee: { kind: 'herdr', paneId: 'wA:p2' } });
  const inWorktree = item({ id: 'i2', sequence: 4, worktree: { path: 'D:\\p\\api.worktrees\\squad-1', branch: 'squad-1' } });
  const other = item({ id: 'i3', sequence: 5, status: 'done' });

  it('refuses a caller without the token', async () => {
    const server = await app([]);
    expect((await server.inject({ method: 'GET', url: '/api/agent/status' })).statusCode).toBe(401);
  });

  it('gives the caller its own items: its herdr pane, or the worktree it stands in', async () => {
    const server = await app([folder('D:/p', [mine, inWorktree, other], [])]);
    const byPane = await server.inject({ method: 'GET', url: '/api/agent/task?pane=wA:p2&cwd=D:/elsewhere', headers: AUTH });
    expect(byPane.json().items.map((entry: WorkItem) => entry.sequence)).toEqual([3]);
    const byCwd = await server.inject({ method: 'GET', url: '/api/agent/task?cwd=D:/p/api.worktrees/squad-1/src', headers: AUTH });
    expect(byCwd.json().items.map((entry: WorkItem) => entry.sequence)).toEqual([4]);
  });

  it('lists open items only in status, and names the calling session', async () => {
    const server = await app([folder('D:/p', [mine, other], [])]);
    const answer = (await server.inject({ method: 'GET', url: '/api/agent/status?pane=wA:p2', headers: AUTH })).json();
    expect(answer.you.title).toBe('Sửa API');
    expect(answer.workItems.map((entry: WorkItem) => entry.sequence)).toEqual([3]);
  });

  it('includes open handoff Issues outside the board in status', async () => {
    const handoff = {
      issue: 42,
      title: '[Handoff] Sửa API',
      url: 'https://github.com/babydanh/agent-orchestrator/issues/42',
      createdAt: '2026-10-21T08:00:00Z',
      state: 'finished',
      repo: 'D:/p/api',
    } satisfies WorkItemCloudIssue;
    const server = await app([folder('D:/p', [], [], [handoff])]);
    const answer = (await server.inject({ method: 'GET', url: '/api/agent/status', headers: AUTH })).json();
    expect(answer.cloudIssues).toEqual([{ ...handoff, folder: 'D:/p' }]);
  });

  it('includes global Git guard counts in status when available', async () => {
    const server = await app([], { red: 2, yellow: 4 });
    const answer = (
      await server.inject({ method: 'GET', url: '/api/agent/status', headers: AUTH })
    ).json();
    expect(answer.guardRiskCounts).toEqual({ red: 2, yellow: 4 });
  });

  it('writes a report onto #n, preferring the caller own item when two folders share the number', async () => {
    const notesA: { id: string; text: string }[] = [];
    const notesB: { id: string; text: string }[] = [];
    const server = await app([
      folder('D:/a', [item({ id: 'a3', sequence: 3 })], notesA),
      folder('D:/b', [mine], notesB),
    ]);
    const ok = await server.inject({ method: 'POST', url: '/api/agent/report', headers: AUTH, payload: { item: '#3', text: 'xong API', pane: 'wA:p2' } });
    expect(ok.json()).toEqual({ ok: true, item: 3, folder: 'D:/b' });
    expect(notesB).toEqual([{ id: 'i1', text: 'xong API' }]);

    const ambiguous = await server.inject({ method: 'POST', url: '/api/agent/report', headers: AUTH, payload: { item: '3', text: 'x' } });
    expect(ambiguous.statusCode).toBe(404);
    expect(ambiguous.json().error).toContain('nhiều thư mục');
    const missing = await server.inject({ method: 'POST', url: '/api/agent/report', headers: AUTH, payload: { item: '#9', text: 'x' } });
    expect(missing.json().error).toBe('Không có việc #9 trên bảng.');
    expect(notesA).toEqual([]);
  });

  it('reads each session row with the folder above it', () => {
    expect(sessionRows([
      { id: 'f', kind: 'folder', name: 'P', path: 'D:/p' },
      { id: 'r', parentId: 'f', kind: 'repository', name: 'api', path: 'D:/p/api' },
      { id: 's', parentId: 'r', kind: 'session', name: 'x', title: 'Việc', agentKind: 'omp', state: 'working', path: 'D:/p/api', herdrPaneId: 'wA:p1', request: 'sửa API', lastRequest: 'làm tiếp', interrupted: 'Connection error.' },
    ])).toEqual([{ folder: 'D:/p', agent: 'omp', state: 'working', title: 'Việc', cwd: 'D:/p/api', paneId: 'wA:p1', request: 'sửa API', lastRequest: 'làm tiếp', interrupted: 'Connection error.' }]);
  });
});

describe('board CLI', () => {
  it('parses commands and refuses a report without text', () => {
    expect(parseBoardArgs([])).toEqual({ kind: 'help' });
    expect(parseBoardArgs(['task', '--json'])).toEqual({ kind: 'task', json: true });
    expect(parseBoardArgs(['report', '#3', 'xong', 'API'])).toEqual({ kind: 'report', json: false, item: '#3', text: 'xong API' });
    expect(parseBoardArgs(['report', '#3'])).toMatchObject({ kind: 'error' });
    expect(parseBoardArgs(['xoa'])).toMatchObject({ kind: 'error' });
  });

  it('reads the done-when line, the worktree and how to report from the API answer', () => {
    const answer = readTaskAnswer({
      caller: { paneId: 'wA:p2' },
      items: [{
        ...item({
          id: 'i1',
          sequence: 3,
          acceptance: 'test pass',
          worktree: { path: 'D:/w', branch: 'b' },
          assignee: { kind: 'herdr', paneId: 'wA:p2' },
          cloud: {
            issue: 42,
            url: 'https://github.com/babydanh/agent-orchestrator/issues/42',
            branch: 'b',
            repo: 'D:/p',
            state: 'waiting_clean',
            startedAt: '2026-10-21T08:00:00.000Z',
            reason: 'commit first',
          },
        }),
        folder: 'D:/p',
      }],
    });
    const text = formatTask(answer);
    expect(text).toContain('#3 · Đang làm · D:/p');
    expect(text).toContain('Xong khi: test pass');
    expect(text).toContain('Worktree: D:/w (nhánh b)');
    expect(text).toContain('board report #3');
    expect(text).toContain('Cloud: Issue #42 [chờ worktree sạch]');
    expect(text).toContain('Cloud chặn: commit first');
    expect(formatTask({ caller: { paneId: 'wA:p2' }, items: [] })).toContain('Không có việc nào');
  });

  it('prints cloud Issues outside the board in status', () => {
    const answer = readStatusAnswer({
      caller: {},
      sessions: [],
      workItems: [],
      cloudIssues: [
        {
          issue: 42,
          title: '[Handoff] Sửa API',
          url: 'https://github.com/babydanh/agent-orchestrator/issues/42',
          createdAt: '2026-10-21T08:00:00Z',
          state: 'finished',
          repo: 'D:/p/api',
          folder: 'D:/p',
        },
      ],
      guardRiskCounts: { red: 1, yellow: 2 },
      branchCollisions: { pairs: 3, conflicts: 1, pending: false },
    });
    expect(formatStatus(answer)).toContain('Rủi ro mất code: 1 đỏ · 2 vàng.');
    expect(formatStatus(answer)).toContain('Nhánh đụng nhau: 3 cặp chạm tệp · 1 xung đột thật.');
    expect(formatStatus(answer)).toContain('Issue [Handoff] ngoài board (1)');
    expect(formatStatus(answer)).toContain('https://github.com/babydanh/agent-orchestrator/issues/42');
  });

  it('prints under each session what it was asked and its newest message, so a sleeping one is found again', () => {
    const text = formatStatus(readStatusAnswer({
      caller: {},
      sessions: [
        { agent: 'herdr', state: 'sleeping', title: '3d6cdbd2', cwd: 'D:/w', request: 'làm animation nhân vật', lastRequest: 'làm tiếp', progress: { done: 1, total: 3, current: 'Thêm animation' } },
        { agent: 'herdr', state: 'sleeping', title: 'Chưa rõ', cwd: 'D:/x' },
      ],
      workItems: [],
    }));
    expect(text).toContain('herdr · sleeping · 3d6cdbd2 · D:/w · 1/3 (33%) · đang: Thêm animation\n      Yêu cầu: làm animation nhân vật · Gần nhất: làm tiếp');
    expect(text).toContain('herdr · sleeping · Chưa rõ · D:/x\n');
  });

  it('marks a session cut off mid-turn, by a usage limit or a lost connection, and counts them in the heading', () => {
    const session = (title: string, interrupted?: string) => ({ agent: 'herdr', state: 'sleeping', title, cwd: 'D:/w', request: 'popup minh hoạ', ...(interrupted === undefined ? {} : { interrupted }) });
    const text = formatStatus(readStatusAnswer({
      caller: {},
      sessions: [session('Thuỵ Sĩ', "You've hit your session limit · resets 8:50pm"), session('Xong rồi')],
      workItems: [],
    }));
    expect(text).toContain('Phiên đang chạy (2, 1 bị ngắt giữa chừng):');
    expect(text).toContain("herdr · sleeping · Thuỵ Sĩ · D:/w · BỊ NGẮT: You've hit your session limit · resets 8:50pm\n      Yêu cầu: popup minh hoạ");
    expect(text).toContain('herdr · sleeping · Xong rồi · D:/w\n      Yêu cầu: popup minh hoạ');
  });

  it('refuses an answer that is not the agent API shape, such as an old board serving its web page', () => {
    expect(() => readStatusAnswer(undefined)).toThrow('khởi động lại board');
    expect(() => readTaskAnswer({ items: [{ sequence: '3' }] })).toThrow('khởi động lại board');
    expect(() => readStatusAnswer({ sessions: [{ agent: 'omp' }], workItems: [] })).toThrow('khởi động lại board');
  });
});

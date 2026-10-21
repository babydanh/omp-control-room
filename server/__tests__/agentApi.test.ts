import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import type { WorkItem } from '../../core/src/messages.js';
import { type AgentFolder, registerAgentRoutes, sessionRows } from '../src/agentApi/agentApi.js';
import { formatTask, parseBoardArgs, readStatusAnswer, readTaskAnswer } from '../src/boardCli.js';

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

function folder(path: string, items: WorkItem[], notes: { id: string; text: string }[]): AgentFolder {
  return {
    path,
    service: {
      snapshot: () => ({ type: 'companyWorkItems', items, settings: {} }) as never,
      note: async ({ id, text }) => {
        notes.push({ id, text });
      },
    },
  };
}

async function app(folders: AgentFolder[]) {
  const server = Fastify();
  registerAgentRoutes(server, {
    token: TOKEN,
    sessions: async () => [{ folder: 'D:/p', agent: 'omp', state: 'working', title: 'Sửa API', cwd: 'D:/p/api.worktrees/x', paneId: 'wA:p2' }],
    folders: () => folders,
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
      { id: 's', parentId: 'r', kind: 'session', name: 'x', title: 'Việc', agentKind: 'omp', state: 'working', path: 'D:/p/api', herdrPaneId: 'wA:p1' },
    ])).toEqual([{ folder: 'D:/p', agent: 'omp', state: 'working', title: 'Việc', cwd: 'D:/p/api', paneId: 'wA:p1' }]);
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
      items: [{ ...item({ id: 'i1', sequence: 3, acceptance: 'test pass', worktree: { path: 'D:/w', branch: 'b' }, assignee: { kind: 'herdr', paneId: 'wA:p2' } }), folder: 'D:/p' }],
    });
    const text = formatTask(answer);
    expect(text).toContain('#3 · Đang làm · D:/p');
    expect(text).toContain('Xong khi: test pass');
    expect(text).toContain('Worktree: D:/w (nhánh b)');
    expect(text).toContain('board report #3');
    expect(formatTask({ caller: { paneId: 'wA:p2' }, items: [] })).toContain('Không có việc nào');
  });

  it('refuses an answer that is not the agent API shape, such as an old board serving its web page', () => {
    expect(() => readStatusAnswer(undefined)).toThrow('khởi động lại board');
    expect(() => readTaskAnswer({ items: [{ sequence: '3' }] })).toThrow('khởi động lại board');
    expect(() => readStatusAnswer({ sessions: [{ agent: 'omp' }], workItems: [] })).toThrow('khởi động lại board');
  });
});

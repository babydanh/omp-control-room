import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createTranscriptProgress, progressOfTodo, requestFromTranscriptLine, todoFromTranscriptLine } from '../src/projects/sessionProgress.js';

function ompTodoLine(tasks: { content: string; status: string; blocker?: string }[]): string {
  return JSON.stringify({
    type: 'message',
    message: { role: 'toolResult', toolName: 'todo', content: [{ type: 'text', text: '…' }], details: { op: 'done', phases: [{ name: 'Pha', tasks }] } },
  });
}

function claudeTodoLine(todos: { content: string; status: string }[]): string {
  return JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'TodoWrite', input: { todos: todos.map((todo) => ({ ...todo, activeForm: todo.content })) } }] },
  });
}

describe('todoFromTranscriptLine / progressOfTodo', () => {
  it('reads an omp todo result: done of total without abandoned tasks, the task in hand, the blocked one with its reason', () => {
    const todo = todoFromTranscriptLine(ompTodoLine([
      { content: 'Sửa API', status: 'completed' },
      { content: 'Sửa Web', status: 'in_progress' },
      { content: 'Gộp main', status: 'blocked', blocker: 'chờ người dùng cho phép' },
      { content: 'Bỏ', status: 'abandoned' },
    ]));
    expect(todo && progressOfTodo(todo)).toEqual({ done: 1, total: 3, current: 'Sửa Web', blocked: 'Gộp main: chờ người dùng cho phép' });
  });

  it('reads a Claude Code TodoWrite call, and names the next pending task when none is in progress', () => {
    const todo = todoFromTranscriptLine(claudeTodoLine([
      { content: 'Viết test', status: 'completed' },
      { content: 'Chạy test', status: 'pending' },
    ]));
    expect(todo && progressOfTodo(todo)).toEqual({ done: 1, total: 2, current: 'Chạy test' });
  });

  it('ignores other lines and an empty list', () => {
    expect(todoFromTranscriptLine('{"type":"message","message":{"role":"user","content":"todo"}}')).toBeUndefined();
    expect(progressOfTodo({ phases: [{ name: 'Pha', tasks: [] }] })).toBeUndefined();
  });
});

describe('requestFromTranscriptLine', () => {
  it('reads what the user typed in omp and Claude Code, and nothing an agent, a tool or a wrapper wrote', () => {
    const omp = (attribution: string, text: string) => JSON.stringify({ type: 'message', message: { role: 'user', content: [{ type: 'text', text }], attribution } });
    const claude = (content: unknown, extra: Record<string, unknown> = {}) => JSON.stringify({ type: 'user', ...extra, message: { role: 'user', content } });
    expect(requestFromTranscriptLine(omp('user', '  sửa  nút\n đăng nhập '))).toBe('sửa nút đăng nhập');
    expect(requestFromTranscriptLine(omp('agent', 'thông báo hệ thống'))).toBeUndefined();
    expect(requestFromTranscriptLine(claude('thêm popup'))).toBe('thêm popup');
    expect(requestFromTranscriptLine(claude([{ type: 'tool_result', content: 'ok' }]))).toBeUndefined();
    expect(requestFromTranscriptLine(claude('<command-name>/clear</command-name>'))).toBeUndefined();
    expect(requestFromTranscriptLine(claude('việc của subagent', { isSidechain: true }))).toBeUndefined();
    expect(requestFromTranscriptLine(claude('x'.repeat(400)))?.length).toBe(300);
  });
});

describe('createTranscriptProgress', () => {
  let dir = '';
  afterEach(() => {
    if (dir !== '') rmSync(dir, { recursive: true, force: true });
  });

  it('keeps the newest list, reads only what was appended, and waits for a half-written line', async () => {
    dir = mkdtempSync(join(tmpdir(), 'progress-'));
    const file = join(dir, 'session.jsonl');
    writeFileSync(file, `${ompTodoLine([{ content: 'A', status: 'in_progress' }, { content: 'B', status: 'pending' }])}\n{"type":"x"}\n`);
    const read = createTranscriptProgress();
    expect(await read(file)).toEqual({ progress: { done: 0, total: 2, current: 'A' } });

    const next = ompTodoLine([{ content: 'A', status: 'completed' }, { content: 'B', status: 'in_progress' }]);
    appendFileSync(file, next.slice(0, 40));
    expect(await read(file)).toEqual({ progress: { done: 0, total: 2, current: 'A' } });
    appendFileSync(file, `${next.slice(40)}\n`);
    expect(await read(file)).toEqual({ progress: { done: 1, total: 2, current: 'B' } });
    // The first thing the user typed is the session's task; a later message travels as the newest.
    const typed = (text: string) => `${JSON.stringify({ type: 'message', message: { role: 'user', content: [{ type: 'text', text }], attribution: 'user' } })}\n`;
    appendFileSync(file, typed('sửa popup'));
    expect(await read(file)).toEqual({ progress: { done: 1, total: 2, current: 'B' }, request: 'sửa popup' });
    appendFileSync(file, typed('làm tiếp'));
    expect(await read(file)).toEqual({ progress: { done: 1, total: 2, current: 'B' }, request: 'sửa popup', lastRequest: 'làm tiếp' });

    expect(await read(join(dir, 'missing.jsonl'))).toEqual({});
  });

  it('reads a long transcript from its tail, and skips a line too long to be a todo list', async () => {
    dir = mkdtempSync(join(tmpdir(), 'progress-'));
    const file = join(dir, 'session.jsonl');
    const old = ompTodoLine([{ content: 'Cũ', status: 'in_progress' }]);
    const recent = ompTodoLine([{ content: 'Mới', status: 'in_progress' }]);
    writeFileSync(file, `${old}\n${'x'.repeat(5000)}\n${recent}\n`);
    const read = createTranscriptProgress({ tailBytes: recent.length + 200, maxLineBytes: 1000 });
    expect(await read(file)).toEqual({ progress: { done: 0, total: 1, current: 'Mới' } });

    appendFileSync(file, `${'y'.repeat(3000)}\n${ompTodoLine([{ content: 'Mới', status: 'completed' }])}\n`);
    expect(await read(file)).toEqual({ progress: { done: 1, total: 1 } });
  });

  it('finds the first request at the head of a transcript read only from its tail', async () => {
    dir = mkdtempSync(join(tmpdir(), 'progress-'));
    const file = join(dir, 'session.jsonl');
    const typed = (text: string) => JSON.stringify({ type: 'user', message: { role: 'user', content: text } });
    writeFileSync(file, `${typed('việc ban đầu')}\n${'x'.repeat(5000)}\n${typed('câu gần đây')}\n`);
    const read = createTranscriptProgress({ tailBytes: 200, maxLineBytes: 1000 });
    expect(await read(file)).toEqual({ request: 'việc ban đầu', lastRequest: 'câu gần đây' });
  });
});

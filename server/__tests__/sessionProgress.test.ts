import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createTranscriptProgress, progressOfTodo, todoFromTranscriptLine } from '../src/projects/sessionProgress.js';

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
    expect(await read(file)).toEqual({ done: 0, total: 2, current: 'A' });

    const next = ompTodoLine([{ content: 'A', status: 'completed' }, { content: 'B', status: 'in_progress' }]);
    appendFileSync(file, next.slice(0, 40));
    expect(await read(file)).toEqual({ done: 0, total: 2, current: 'A' });
    appendFileSync(file, `${next.slice(40)}\n`);
    expect(await read(file)).toEqual({ done: 1, total: 2, current: 'B' });

    expect(await read(join(dir, 'missing.jsonl'))).toBeUndefined();
  });
});

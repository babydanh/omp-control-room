/**
 * sessionProgress: how far an agent says it is, read from its own transcript.
 *
 * omp records every `todo` call's result with the whole list in `details.phases`; Claude Code
 * records each TodoWrite call with the whole list in `input.todos`. The newest one is the agent's
 * current list. A transcript only grows, so each file is read once and then from where the last
 * read stopped.
 */

import { open, stat } from 'node:fs/promises';

import type { CompanySessionTodo, ProjectTreeNode } from '../../../core/src/messages.js';
import { readTodo } from '../company/sessionInsight.js';
import { isRecord } from '../company/typeGuards.js';

export type SessionProgress = NonNullable<ProjectTreeNode['progress']>;

const CHUNK_BYTES = 1024 * 1024;
const MAX_FILES = 200;
const MAX_CURRENT = 400;
const MAX_BLOCKED = 800;

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** The todo list one transcript line writes, or undefined when it writes none. */
export function todoFromTranscriptLine(line: string): CompanySessionTodo | undefined {
  const omp = line.includes('"toolName":"todo"') && line.includes('"role":"toolResult"');
  const claude = line.includes('"name":"TodoWrite"');
  if (!omp && !claude) return undefined;
  let entry: unknown;
  try {
    entry = JSON.parse(line);
  } catch {
    return undefined;
  }
  const message = isRecord(entry) ? entry['message'] : undefined;
  if (!isRecord(message)) return undefined;
  if (omp) {
    const details = message['details'];
    return isRecord(details) ? readTodo(details) : undefined;
  }
  const content = message['content'];
  if (!Array.isArray(content)) return undefined;
  const call = [...content]
    .reverse()
    .find((part): part is Record<string, unknown> => isRecord(part) && part['type'] === 'tool_use' && part['name'] === 'TodoWrite');
  const input = call?.['input'];
  if (!isRecord(input)) return undefined;
  return readTodo({ phases: [{ name: 'Todo', tasks: input['todos'] }] });
}

/** Done of total (abandoned tasks left out), the task in hand, and the first blocked task. */
export function progressOfTodo(todo: CompanySessionTodo): SessionProgress | undefined {
  const tasks = todo.phases.flatMap((phase) => phase.tasks).filter((task) => task.status !== 'abandoned');
  if (tasks.length === 0) return undefined;
  const current = tasks.find((task) => task.status === 'in_progress') ?? tasks.find((task) => task.status === 'pending');
  const blocked = tasks.find((task) => task.status === 'blocked');
  return {
    done: tasks.filter((task) => task.status === 'completed').length,
    total: tasks.length,
    ...(current === undefined ? {} : { current: clip(current.content, MAX_CURRENT) }),
    ...(blocked === undefined
      ? {}
      : { blocked: clip(blocked.blocker ? `${blocked.content}: ${blocked.blocker}` : blocked.content, MAX_BLOCKED) }),
  };
}

interface FileState {
  offset: number;
  /** Bytes after the last newline read: a line still being written. */
  carry: Buffer;
  todo: CompanySessionTodo | undefined;
}

/** A reader that remembers how far it read each transcript. */
export function createTranscriptProgress(): (file: string) => Promise<SessionProgress | undefined> {
  const files = new Map<string, FileState>();

  async function readNew(file: string, state: FileState, size: number): Promise<void> {
    const handle = await open(file, 'r');
    try {
      while (state.offset < size) {
        const length = Math.min(CHUNK_BYTES, size - state.offset);
        const chunk = Buffer.alloc(length);
        const { bytesRead } = await handle.read(chunk, 0, length, state.offset);
        if (bytesRead === 0) break;
        state.offset += bytesRead;
        const bytes = Buffer.concat([state.carry, chunk.subarray(0, bytesRead)]);
        const end = bytes.lastIndexOf(10);
        if (end < 0) {
          state.carry = bytes;
          continue;
        }
        state.carry = bytes.subarray(end + 1);
        for (const line of bytes.subarray(0, end).toString('utf8').split('\n')) {
          const todo = todoFromTranscriptLine(line);
          if (todo !== undefined) state.todo = todo;
        }
      }
    } finally {
      await handle.close();
    }
  }

  return async (file) => {
    let size: number;
    try {
      size = (await stat(file)).size;
    } catch {
      files.delete(file);
      return undefined;
    }
    let state = files.get(file);
    // A shorter file was rewritten: read it again from the start.
    if (state === undefined || size < state.offset) {
      state = { offset: 0, carry: Buffer.alloc(0), todo: undefined };
      if (files.size >= MAX_FILES) files.delete(files.keys().next().value ?? '');
      files.set(file, state);
    }
    if (size > state.offset) await readNew(file, state, size);
    return state.todo === undefined ? undefined : progressOfTodo(state.todo);
  };
}

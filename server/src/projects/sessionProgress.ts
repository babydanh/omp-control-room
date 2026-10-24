/**
 * sessionProgress: how far an agent says it is, and what it was last asked, read from its own
 * transcript.
 *
 * omp records every `todo` call's result with the whole list in `details.phases`; Claude Code
 * records each TodoWrite call with the whole list in `input.todos`. The newest one is the agent's
 * current list. The newest message the user typed is the request it works on. A transcript only
 * grows, so each file is read once and then from where the last read stopped.
 */

import { open, stat } from 'node:fs/promises';

import type { CompanySessionTodo, ProjectTreeNode } from '../../../core/src/messages.js';
import { readTodo } from '../company/sessionInsight.js';
import { isRecord } from '../company/typeGuards.js';

export type SessionProgress = NonNullable<ProjectTreeNode['progress']>;

const CHUNK_BYTES = 1024 * 1024;
/** A transcript first met is read from this far before its end: older todo lists are stale anyway. */
const TAIL_BYTES = 32 * 1024 * 1024;
/** A line longer than this is skipped unread (a huge tool output); a todo line is a few KB. */
const MAX_LINE_BYTES = 8 * 1024 * 1024;
const MAX_FILES = 200;
const EMPTY = Buffer.alloc(0);
const MAX_CURRENT = 400;
const MAX_BLOCKED = 800;
const MAX_REQUEST = 300;
/** Claude Code's own blocks written as user turns: slash commands, their output, hooks, reminders. */
const CLAUDE_WRAPPER = /^<(command-|local-command-|system-reminder|user-prompt-submit-hook|bash-)/;
/** The first request is looked for this far into a transcript read from its tail. */
const HEAD_BYTES = 256 * 1024;

/**
 * What a transcript says about its session: the todo progress, the first thing the user asked
 * (the session's task), and the newest thing the user typed when it differs.
 */
export interface TranscriptFacts {
  readonly progress?: SessionProgress;
  readonly request?: string;
  readonly lastRequest?: string;
}

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

/**
 * The text the user typed on this line, or undefined for anything else: agent turns, tool results,
 * subagent (sidechain) turns, and Claude Code's `<command-…>` / `<system-reminder>` wrappers.
 */
export function requestFromTranscriptLine(line: string): string | undefined {
  if (!line.includes('"role":"user"')) return undefined;
  let entry: unknown;
  try {
    entry = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isRecord(entry) || entry['isSidechain'] === true) return undefined;
  const message = entry['message'];
  if (!isRecord(message) || message['role'] !== 'user') return undefined;
  // omp tags what the user typed; its injected notices carry another attribution.
  if (entry['type'] === 'message' && message['attribution'] !== 'user') return undefined;
  if (entry['type'] !== 'message' && entry['type'] !== 'user') return undefined;
  const content = message['content'];
  const parts = typeof content === 'string' ? [content] : Array.isArray(content)
    ? content.flatMap((part) => (isRecord(part) && part['type'] === 'text' && typeof part['text'] === 'string' ? [part['text']] : []))
    : [];
  const text = parts.join(' ').replace(/\s+/g, ' ').trim();
  if (text === '' || CLAUDE_WRAPPER.test(text)) return undefined;
  return clip(text, MAX_REQUEST);
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
  /** Dropping bytes up to the next newline: the read began mid-line, or the line is too long. */
  skipping: boolean;
  todo: CompanySessionTodo | undefined;
  /** The first user message: found while reading from the start, or read once from the head. */
  request: string | undefined;
  lastRequest: string | undefined;
}

export interface TranscriptLimits {
  readonly tailBytes: number;
  readonly maxLineBytes: number;
}

/** A reader that remembers how far it read each transcript. */
export function createTranscriptProgress(
  limits: TranscriptLimits = { tailBytes: TAIL_BYTES, maxLineBytes: MAX_LINE_BYTES },
): (file: string) => Promise<TranscriptFacts> {
  const files = new Map<string, FileState>();

  function readLines(state: FileState, chunk: Buffer): void {
    let bytes = state.carry.length === 0 ? chunk : Buffer.concat([state.carry, chunk]);
    state.carry = EMPTY;
    if (state.skipping) {
      const first = bytes.indexOf(10);
      if (first < 0) return;
      bytes = bytes.subarray(first + 1);
      state.skipping = false;
    }
    const end = bytes.lastIndexOf(10);
    if (end < 0) {
      if (bytes.length > limits.maxLineBytes) state.skipping = true;
      else state.carry = bytes;
      return;
    }
    const rest = bytes.subarray(end + 1);
    if (rest.length > limits.maxLineBytes) state.skipping = true;
    else state.carry = rest;
    for (const line of bytes.subarray(0, end).toString('utf8').split('\n')) {
      const todo = todoFromTranscriptLine(line);
      if (todo !== undefined) state.todo = todo;
      const request = requestFromTranscriptLine(line);
      if (request === undefined) continue;
      state.lastRequest = request;
      state.request ??= request;
    }
  }

  async function readNew(file: string, state: FileState, size: number): Promise<void> {
    const handle = await open(file, 'r');
    try {
      while (state.offset < size) {
        const length = Math.min(CHUNK_BYTES, size - state.offset);
        const chunk = Buffer.alloc(length);
        const { bytesRead } = await handle.read(chunk, 0, length, state.offset);
        if (bytesRead === 0) break;
        state.offset += bytesRead;
        readLines(state, chunk.subarray(0, bytesRead));
      }
    } finally {
      await handle.close();
    }
  }

  /** The first user message within the head of a transcript whose tail was read. */
  async function readFirstRequest(file: string, size: number): Promise<string | undefined> {
    const handle = await open(file, 'r');
    try {
      const chunk = Buffer.alloc(Math.min(HEAD_BYTES, size));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, 0);
      const text = chunk.subarray(0, bytesRead).toString('utf8');
      // The last line of the chunk may be cut: only whole lines count.
      for (const line of text.slice(0, text.lastIndexOf('\n') + 1).split('\n')) {
        const request = requestFromTranscriptLine(line);
        if (request !== undefined) return request;
      }
      return undefined;
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
      return {};
    }
    let state = files.get(file);
    // A new file is read from its tail; a shorter file was rewritten and is read again.
    if (state === undefined || size < state.offset) {
      const offset = Math.max(0, size - limits.tailBytes);
      state = { offset, carry: EMPTY, skipping: offset > 0, todo: undefined, request: undefined, lastRequest: undefined };
      if (files.size >= MAX_FILES) files.delete(files.keys().next().value ?? '');
      files.set(file, state);
      if (offset > 0) state.request = await readFirstRequest(file, size).catch(() => undefined);
    }
    if (size > state.offset) await readNew(file, state, size);
    const progress = state.todo === undefined ? undefined : progressOfTodo(state.todo);
    return {
      ...(progress === undefined ? {} : { progress }),
      ...(state.request === undefined ? {} : { request: state.request }),
      ...(state.lastRequest === undefined || state.lastRequest === state.request ? {} : { lastRequest: state.lastRequest }),
    };
  };
}

/**
 * Durable, per-session activity log for the company board.
 *
 * Each company session appends to its own `<sessionId>.jsonl` under the
 * workspace namespace, so the log survives a board reload and a server restart.
 * Every entry is pushed to subscribers once it is on disk, and replayed from
 * disk on request. Assistant text is coalesced into paragraph-sized entries;
 * every other event is one entry. Held text is always flushed before a
 * non-text entry is written, so the log keeps the order things happened in.
 *
 * Writes for one file are serialized through a module-level chain, so a reader
 * in this process always sees the appends queued before it asked.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { CompanySessionLogEntry } from '../../../core/src/company.js';
import { CompanyError } from './companyError.js';

/** Directory under the workspace namespace that holds one log per session. */
export const COMPANY_SESSION_LOG_DIR = 'logs';
export const SESSION_LOG_DEFAULT_LIMIT = 200;
export const SESSION_LOG_MAX_LIMIT = 500;

/** Longest text piece a single text entry carries. */
const TEXT_PIECE_CHARS = 1500;
/** Wire ceiling for `CompanySessionLogEntry.text`. */
const ENTRY_TEXT_CHARS = 4000;
/** A log that grows past this is trimmed back to the newest whole lines below. */
const TRIM_TRIGGER_BYTES = 2 * 1024 * 1024;
const TRIM_KEEP_BYTES = 1024 * 1024;
const SESSION_LOG_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const NEWLINE = '\n';
const PARAGRAPH_BREAK = '\n\n';

/** One entry before the log stamps its `seq` and `at`. */
export type SessionLogInput = Omit<CompanySessionLogEntry, 'seq' | 'at'>;

/** The run a piece of assistant text belongs to. */
export interface SessionLogContext {
  readonly runEpoch: number;
  readonly taskId?: string;
}

export interface SessionLogOptions {
  /** Directory holding one `<sessionId>.jsonl` per session. */
  readonly directory: string;
  readonly now: () => string;
  /** Receives each entry after it has been appended to disk, in `seq` order. */
  readonly onEntry: (sessionId: string, entry: CompanySessionLogEntry) => void;
}

interface HeldText {
  readonly context: SessionLogContext;
  text: string;
}

interface FileState {
  nextSeq: number;
  bytes: number;
  /** True after a failed or torn append, so the next line starts clean. */
  needsNewline: boolean;
}

/** Last queued write per file. Chains never reject: a failed write is logged. */
const writeChains = new Map<string, Promise<void>>();

export function sessionLogDirectory(namespaceDir: string): string {
  return path.join(namespaceDir, COMPANY_SESSION_LOG_DIR);
}

export function isSessionLogId(sessionId: string): boolean {
  return SESSION_LOG_ID_PATTERN.test(sessionId);
}

function sessionLogPath(directory: string, sessionId: string): string {
  if (!isSessionLogId(sessionId)) {
    throw new CompanyError('session_log_invalid', `Not a session id: ${sessionId}`);
  }
  return path.join(directory, `${sessionId}.jsonl`);
}

/**
 * Read the newest `limit` entries of one session's log, oldest first. Queued
 * writes for that file land first, so the reader sees everything recorded
 * before it asked. An unknown session has an empty log.
 */
export async function readSessionLog(
  directory: string,
  sessionId: string,
  limit: number,
): Promise<CompanySessionLogEntry[]> {
  const filePath = sessionLogPath(directory, sessionId);
  const pending = writeChains.get(filePath);
  if (pending !== undefined) await pending;
  const entries = parseEntries(await readLogFile(filePath));
  return entries.slice(Math.max(0, entries.length - limit));
}

export class SessionLog {
  private readonly directory: string;
  private readonly now: () => string;
  private readonly onEntry: (sessionId: string, entry: CompanySessionLogEntry) => void;
  private readonly held = new Map<string, HeldText>();
  private readonly files = new Map<string, FileState>();

  constructor(options: SessionLogOptions) {
    this.directory = options.directory;
    this.now = options.now;
    this.onEntry = options.onEntry;
  }

  /**
   * Accumulate assistant text. Text is emitted through the last paragraph break
   * and, when a run has no breaks, in pieces of at most `TEXT_PIECE_CHARS`.
   */
  text(sessionId: string, context: SessionLogContext, chunk: string): void {
    if (chunk.length === 0) return;
    let run = this.held.get(sessionId);
    if (
      run !== undefined &&
      (run.context.runEpoch !== context.runEpoch || run.context.taskId !== context.taskId)
    ) {
      this.flush(sessionId);
      run = undefined;
    }
    if (run === undefined) {
      run = { context: { ...context }, text: '' };
      this.held.set(sessionId, run);
    }
    run.text += chunk;

    const paragraphEnd = run.text.lastIndexOf(PARAGRAPH_BREAK);
    if (paragraphEnd >= 0) {
      const ready = run.text.slice(0, paragraphEnd);
      run.text = run.text.slice(paragraphEnd + PARAGRAPH_BREAK.length);
      this.emitText(sessionId, run.context, ready);
    }
    while (run.text.length > TEXT_PIECE_CHARS) {
      const end = pieceEnd(run.text, TEXT_PIECE_CHARS);
      const piece = run.text.slice(0, end);
      run.text = run.text.slice(end);
      this.emitText(sessionId, run.context, piece);
    }
  }

  /** Emit whatever text is held for one session. */
  flush(sessionId: string): void {
    const run = this.held.get(sessionId);
    if (run === undefined) return;
    this.held.delete(sessionId);
    this.emitText(sessionId, run.context, run.text);
  }

  /** Emit every held text, for quiescence, shutdown and crashes. */
  flushAll(): void {
    for (const sessionId of [...this.held.keys()]) this.flush(sessionId);
  }

  /** Record one non-text entry. Held text goes first so the order is kept. */
  record(sessionId: string, input: SessionLogInput): void {
    this.flush(sessionId);
    this.enqueue(sessionId, input);
  }

  /** Emit held text, then wait until every queued write has reached disk. */
  async drain(): Promise<void> {
    this.flushAll();
    await Promise.all([...writeChains.values()]);
  }

  private emitText(sessionId: string, context: SessionLogContext, raw: string): void {
    let rest = raw;
    while (rest.length > 0) {
      const end = pieceEnd(rest, TEXT_PIECE_CHARS);
      const piece = rest.slice(0, end).trim();
      rest = rest.slice(end);
      if (piece.length === 0) continue;
      this.enqueue(sessionId, {
        kind: 'text',
        runEpoch: context.runEpoch,
        ...(context.taskId === undefined ? {} : { taskId: context.taskId }),
        text: piece,
      });
    }
  }

  private enqueue(sessionId: string, input: SessionLogInput): void {
    const filePath = sessionLogPath(this.directory, sessionId);
    const at = this.now();
    const body: SessionLogInput = {
      ...input,
      text: input.text.slice(0, pieceEnd(input.text, ENTRY_TEXT_CHARS)),
    };
    enqueueWrite(filePath, async () => {
      const file = await this.openFile(filePath);
      const entry: CompanySessionLogEntry = { seq: file.nextSeq, at, ...body };
      const line = `${file.needsNewline ? NEWLINE : ''}${JSON.stringify(entry)}${NEWLINE}`;
      try {
        await writeSynced(filePath, line, 'a');
      } catch (error) {
        // The line may be partly on disk. The next append starts a fresh line
        // and readers skip the fragment; the seq is not consumed.
        file.needsNewline = true;
        throw error;
      }
      file.nextSeq += 1;
      file.bytes += Buffer.byteLength(line);
      file.needsNewline = false;
      this.onEntry(sessionId, entry);
      if (file.bytes > TRIM_TRIGGER_BYTES) await this.trim(filePath, file);
    });
  }

  /** Load the append state of one file the first time this process touches it. */
  private async openFile(filePath: string): Promise<FileState> {
    const known = this.files.get(filePath);
    if (known !== undefined) return known;
    await fs.promises.mkdir(this.directory, { recursive: true });
    const content = await readLogFile(filePath);
    const state: FileState = {
      nextSeq: nextSequence(content),
      bytes: Buffer.byteLength(content),
      needsNewline: content.length > 0 && !content.endsWith(NEWLINE),
    };
    this.files.set(filePath, state);
    return state;
  }

  /** Keep the newest whole lines up to `TRIM_KEEP_BYTES`; the rewrite is atomic. */
  private async trim(filePath: string, file: FileState): Promise<void> {
    const lines = (await readLogFile(filePath)).split(NEWLINE);
    const kept: string[] = [];
    let size = 0;
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index] ?? '';
      if (parseLine(line) === undefined) continue;
      const cost = Buffer.byteLength(line) + 1;
      if (size + cost > TRIM_KEEP_BYTES) break;
      kept.push(line);
      size += cost;
    }
    kept.reverse();
    const data = kept.length === 0 ? '' : `${kept.join(NEWLINE)}${NEWLINE}`;
    const tmpPath = `${filePath}.tmp`;
    await writeSynced(tmpPath, data, 'w');
    await fs.promises.rename(tmpPath, filePath);
    file.bytes = Buffer.byteLength(data);
    file.needsNewline = false;
  }
}

function enqueueWrite(filePath: string, task: () => Promise<void>): void {
  const previous = writeChains.get(filePath) ?? Promise.resolve();
  const next: Promise<void> = previous
    .then(task)
    .catch((error: unknown) => {
      console.error('[Pixel Agents] Company session log write failed:', error);
    })
    .finally(() => {
      if (writeChains.get(filePath) === next) writeChains.delete(filePath);
    });
  writeChains.set(filePath, next);
}

async function writeSynced(filePath: string, data: string, flags: 'a' | 'w'): Promise<void> {
  const handle = await fs.promises.open(filePath, flags);
  try {
    await handle.writeFile(data, 'utf-8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readLogFile(filePath: string): Promise<string> {
  try {
    return await fs.promises.readFile(filePath, 'utf-8');
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return '';
    }
    throw error;
  }
}

function parseEntries(content: string): CompanySessionLogEntry[] {
  const entries: CompanySessionLogEntry[] = [];
  for (const line of content.split(NEWLINE)) {
    const entry = parseLine(line);
    if (entry !== undefined) entries.push(entry);
  }
  return entries;
}

function nextSequence(content: string): number {
  let next = 0;
  for (const entry of parseEntries(content)) next = Math.max(next, entry.seq + 1);
  return next;
}

function parseLine(line: string): CompanySessionLogEntry | undefined {
  if (line.length === 0) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  return isLogEntry(value) ? value : undefined;
}

function isLogEntry(value: unknown): value is CompanySessionLogEntry {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row['seq'] === 'number' &&
    typeof row['at'] === 'string' &&
    typeof row['kind'] === 'string' &&
    typeof row['runEpoch'] === 'number' &&
    typeof row['text'] === 'string'
  );
}

/** End index of at most `max` code units that does not split a surrogate pair. */
function pieceEnd(text: string, max: number): number {
  if (text.length <= max) return text.length;
  const code = text.charCodeAt(max - 1);
  return code >= 0xd800 && code <= 0xdbff ? max - 1 : max;
}

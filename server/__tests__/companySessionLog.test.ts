import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CompanySessionLogEntry } from '../../core/src/company.js';
import {
  isSessionLogId,
  readSessionLog,
  SessionLog,
  sessionLogDirectory,
  tallySessionTools,
} from '../src/company/sessionLog.js';

const NOW = '2026-01-01T00:00:00.000Z';
const CONTEXT = { runEpoch: 1 };

let directory: string;
let received: CompanySessionLogEntry[];

function logFile(sessionId: string): string {
  return path.join(directory, `${sessionId}.jsonl`);
}

function newLog(): SessionLog {
  return new SessionLog({
    directory,
    now: () => NOW,
    onEntry: (_sessionId, entry) => {
      received.push(entry);
    },
  });
}

describe('session log', () => {
  beforeEach(async () => {
    directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pxl-session-log-'));
    received = [];
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.promises.rm(directory, { recursive: true, force: true });
  });

  it('appends one timestamped JSON line per entry with a contiguous seq', async () => {
    const log = newLog();
    log.record('s1', { kind: 'state', runEpoch: 1, text: 'Phiên đã khởi động.' });
    log.record('s1', { kind: 'tool', runEpoch: 1, toolName: 'read', text: 'read' });
    log.record('s1', {
      kind: 'verdict',
      runEpoch: 1,
      taskId: 'T1',
      text: 'QA chấp thuận.',
      ok: true,
    });
    await log.drain();

    const lines = (await fs.promises.readFile(logFile('s1'), 'utf-8')).trim().split('\n');
    expect(lines).toHaveLength(3);

    const entries = await readSessionLog(directory, 's1', 10);
    expect(entries.map((entry) => entry.seq)).toEqual([0, 1, 2]);
    expect(entries.map((entry) => entry.kind)).toEqual(['state', 'tool', 'verdict']);
    expect(entries.every((entry) => entry.at === NOW && entry.runEpoch === 1)).toBe(true);
    expect(entries[2]).toMatchObject({ taskId: 'T1', ok: true, text: 'QA chấp thuận.' });
    expect(received.map((entry) => entry.seq)).toEqual([0, 1, 2]);
  });

  it('continues the seq and keeps history when a new instance reopens the log', async () => {
    const first = newLog();
    first.record('s1', { kind: 'state', runEpoch: 1, text: 'a' });
    first.record('s1', { kind: 'state', runEpoch: 1, text: 'b' });
    await first.drain();

    const second = newLog();
    second.record('s1', { kind: 'state', runEpoch: 2, text: 'c' });
    await second.drain();

    const entries = await readSessionLog(directory, 's1', 10);
    expect(entries.map((entry) => [entry.seq, entry.text])).toEqual([
      [0, 'a'],
      [1, 'b'],
      [2, 'c'],
    ]);
  });

  it('replays only the newest limit entries, oldest first', async () => {
    const log = newLog();
    for (let index = 0; index < 5; index += 1) {
      log.record('s1', { kind: 'state', runEpoch: 1, text: `e${index}` });
    }
    await log.drain();

    const newest = await readSessionLog(directory, 's1', 2);
    expect(newest.map((entry) => entry.text)).toEqual(['e3', 'e4']);
    expect(await readSessionLog(directory, 's1', 500)).toHaveLength(5);
  });

  it('replays an unknown session as an empty log', async () => {
    expect(await readSessionLog(directory, 'never-ran', 200)).toEqual([]);
  });

  it('accepts only session ids that are safe as file names', async () => {
    expect(isSessionLogId('abc-DEF_123')).toBe(true);
    expect(isSessionLogId('a'.repeat(128))).toBe(true);
    expect(isSessionLogId('a'.repeat(129))).toBe(false);
    expect(isSessionLogId('../escape')).toBe(false);
    expect(isSessionLogId('')).toBe(false);
    expect(sessionLogDirectory('/ns')).toBe(path.join('/ns', 'logs'));
    await expect(readSessionLog(directory, '../escape', 10)).rejects.toMatchObject({
      code: 'session_log_invalid',
    });
  });

  it('coalesces text at paragraph breaks and holds the rest until flushed', async () => {
    const log = newLog();
    log.text('s1', CONTEXT, 'Xin chào.\n\nĐây là ');
    log.text('s1', CONTEXT, 'đoạn hai.');

    // The first paragraph is complete; the second stays held.
    expect((await readSessionLog(directory, 's1', 10)).map((entry) => entry.text)).toEqual([
      'Xin chào.',
    ]);

    log.flush('s1');
    await log.drain();
    const entries = await readSessionLog(directory, 's1', 10);
    expect(entries.map((entry) => [entry.kind, entry.text])).toEqual([
      ['text', 'Xin chào.'],
      ['text', 'Đây là đoạn hai.'],
    ]);
  });

  it('keeps the epochs of text apart and flushes the first run before the second', async () => {
    const log = newLog();
    log.text('s1', { runEpoch: 1 }, 'alpha');
    log.text('s1', { runEpoch: 2 }, 'beta');
    await log.drain();

    const entries = await readSessionLog(directory, 's1', 10);
    expect(entries.map((entry) => [entry.runEpoch, entry.text])).toEqual([
      [1, 'alpha'],
      [2, 'beta'],
    ]);
  });

  it('keeps held text ahead of a later non-text entry', async () => {
    const log = newLog();
    log.text('s1', CONTEXT, 'thinking aloud');
    log.record('s1', { kind: 'state', runEpoch: 1, text: 'Phiên đã đậu.' });
    await log.drain();

    const entries = await readSessionLog(directory, 's1', 10);
    expect(entries.map((entry) => entry.kind)).toEqual(['text', 'state']);
    expect(entries.map((entry) => entry.seq)).toEqual([0, 1]);
  });

  it('splits an unbroken run into pieces of at most 1500 code units without splitting a surrogate pair', async () => {
    const log = newLog();
    log.text('s1', CONTEXT, `${'a'.repeat(1499)}😀${'b'.repeat(100)}`);
    log.flush('s1');
    await log.drain();

    const texts = (await readSessionLog(directory, 's1', 10)).map((entry) => entry.text);
    expect(texts).toEqual(['a'.repeat(1499), `😀${'b'.repeat(100)}`]);
    expect(texts.every((text) => text.length <= 1500)).toBe(true);
  });

  it('clips a stored entry to 4000 characters', async () => {
    const log = newLog();
    log.record('s1', { kind: 'error', runEpoch: 1, text: 'x'.repeat(5000) });
    await log.drain();

    const [entry] = await readSessionLog(directory, 's1', 10);
    expect(entry?.text.length).toBe(4000);
  });

  it('pushes each entry only after it is on disk, in seq order', async () => {
    const onDisk: boolean[] = [];
    const log = new SessionLog({
      directory,
      now: () => NOW,
      onEntry: (sessionId, entry) => {
        const content = fs.readFileSync(logFile(sessionId), 'utf-8');
        onDisk.push(content.includes(`"seq":${entry.seq},`));
        received.push(entry);
      },
    });
    log.record('s1', { kind: 'state', runEpoch: 1, text: 'first' });
    log.record('s1', { kind: 'state', runEpoch: 1, text: 'second' });
    await log.drain();

    expect(onDisk).toEqual([true, true]);
    expect(received.map((entry) => entry.seq)).toEqual([0, 1]);
  });

  it('does not consume a sequence number when an append fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(fs.promises, 'open').mockRejectedValueOnce(new Error('disk full'));

    const log = newLog();
    log.record('s1', { kind: 'state', runEpoch: 1, text: 'lost' });
    log.record('s1', { kind: 'state', runEpoch: 1, text: 'kept' });
    await log.drain();

    const entries = await readSessionLog(directory, 's1', 10);
    expect(entries.map((entry) => [entry.seq, entry.text])).toEqual([[0, 'kept']]);
    expect(received.map((entry) => entry.text)).toEqual(['kept']);
  });

  it('starts a fresh line after a torn tail and skips the fragment on replay', async () => {
    const valid = [0, 1]
      .map((seq) => JSON.stringify({ seq, at: NOW, kind: 'state', runEpoch: 1, text: `e${seq}` }))
      .join('\n');
    await fs.promises.writeFile(logFile('s1'), `${valid}\n{"seq":2,"at":"${NOW}"`);

    const log = newLog();
    log.record('s1', { kind: 'state', runEpoch: 1, text: 'after tear' });
    await log.drain();

    const entries = await readSessionLog(directory, 's1', 10);
    expect(entries.map((entry) => [entry.seq, entry.text])).toEqual([
      [0, 'e0'],
      [1, 'e1'],
      [2, 'after tear'],
    ]);
  });

  it('trims to the newest whole lines once the log passes 2 MiB', async () => {
    const text = 'x'.repeat(1100);
    const lines = Array.from({ length: 2000 }, (_, seq) =>
      JSON.stringify({ seq, at: NOW, kind: 'text', runEpoch: 1, text }),
    );
    await fs.promises.writeFile(logFile('big'), `${lines.join('\n')}\n`);

    const log = newLog();
    log.record('big', { kind: 'state', runEpoch: 1, text: 'latest' });
    await log.drain();

    const size = (await fs.promises.stat(logFile('big'))).size;
    expect(size).toBeLessThanOrEqual(1024 * 1024);
    expect(size).toBeGreaterThan(900 * 1024);

    const entries = await readSessionLog(directory, 'big', 500);
    expect(entries.at(-1)).toMatchObject({ seq: 2000, text: 'latest' });
    const seqs = entries.map((entry) => entry.seq);
    const first = seqs[0] ?? 0;
    expect(first).toBeGreaterThan(0);
    expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, index) => first + index));
  });

  // The runtime logs a skill read as `skill://<name>`, the name the extension reported.
  it('tallies each tool call once from its start entry, and each skill read by its name', async () => {
    const log = newLog();
    log.record('s1', {
      kind: 'tool',
      runEpoch: 1,
      toolName: 'read',
      text: 'skill://brand',
    });
    log.record('s1', {
      kind: 'tool',
      runEpoch: 1,
      toolName: 'read',
      text: 'skill://brand',
    });
    log.record('s1', { kind: 'tool', runEpoch: 1, toolName: 'read', text: 'src/app.ts' });
    log.record('s1', { kind: 'tool', runEpoch: 1, toolName: 'read', text: 'skill://' });
    log.record('s1', { kind: 'tool', runEpoch: 1, toolName: 'bash', text: 'ls' });
    // The end of a failed call repeats the call; it must not count twice.
    log.record('s1', { kind: 'tool', runEpoch: 1, toolName: 'bash', text: 'ls', ok: false });
    await log.drain();

    const tally = await tallySessionTools(directory, 's1');

    expect(tally.tools).toEqual(
      new Map([
        ['read', 4],
        ['bash', 1],
      ]),
    );
    expect(tally.skills).toEqual(new Map([['brand', 2]]));
  });

  it('tallies an unknown session as no calls', async () => {
    const tally = await tallySessionTools(directory, 'never-ran');

    expect(tally.tools.size).toBe(0);
    expect(tally.skills.size).toBe(0);
  });
});

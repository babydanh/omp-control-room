/**
 * claudeTranscriptLog: a Claude Code run's own transcript, read as the board's activity log.
 *
 * A work item that runs on `claude -p` has no omp session and so no board log. Claude Code keeps
 * every run as `<config>/projects/<cwd>/<session id>.jsonl`; this reads the run's text and tool
 * calls from it, so the drawer shows what Claude did, live while it runs and after it ends.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { CompanySessionLogEntry } from '../../../../core/src/messages.js';
import { isRecord } from '../typeGuards.js';
import { clipText } from './claudeCli.js';

/** Wire ceiling for one entry's text, as the board log keeps it. */
const ENTRY_TEXT_CHARS = 4000;

/** Where Claude Code keeps its transcripts: `CLAUDE_CONFIG_DIR`, or `~/.claude`. */
export function claudeProjectsRoot(): string {
  return path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude'), 'projects');
}

/**
 * The newest `limit` text and tool entries of one Claude run, oldest first. A run whose transcript
 * cannot be found or read has an empty log. `sessionId` must already be a safe log id.
 */
export async function readClaudeTranscriptLog(
  sessionId: string,
  limit: number,
  root = claudeProjectsRoot(),
): Promise<CompanySessionLogEntry[]> {
  const file = await findTranscript(root, sessionId);
  if (file === undefined) return [];
  let content: string;
  try {
    content = await fs.promises.readFile(file, 'utf8');
  } catch {
    return [];
  }
  const entries: CompanySessionLogEntry[] = [];
  for (const line of content.split('\n')) {
    for (const entry of entriesOf(line)) entries.push({ ...entry, seq: entries.length + 1 });
  }
  return entries.slice(-limit);
}

async function findTranscript(root: string, sessionId: string): Promise<string | undefined> {
  let dirs: fs.Dirent[];
  try {
    dirs = await fs.promises.readdir(root, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    const file = path.join(root, dir.name, `${sessionId}.jsonl`);
    if (fs.existsSync(file)) return file;
  }
  return undefined;
}

/** The text and tool-use blocks of one assistant line; every other line reads as nothing. */
function entriesOf(line: string): Omit<CompanySessionLogEntry, 'seq'>[] {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return [];
  }
  if (!isRecord(value) || value['type'] !== 'assistant') return [];
  const message = value['message'];
  if (!isRecord(message) || !Array.isArray(message['content'])) return [];
  const at = typeof value['timestamp'] === 'string' ? value['timestamp'] : new Date(0).toISOString();
  const out: Omit<CompanySessionLogEntry, 'seq'>[] = [];
  for (const block of message['content'] as unknown[]) {
    if (!isRecord(block)) continue;
    if (block['type'] === 'text' && typeof block['text'] === 'string' && block['text'].trim() !== '') {
      out.push({ at, kind: 'text', runEpoch: 1, text: clipText(block['text'].trim(), ENTRY_TEXT_CHARS) });
    } else if (block['type'] === 'tool_use' && typeof block['name'] === 'string') {
      out.push({
        at,
        kind: 'tool',
        runEpoch: 1,
        toolName: block['name'],
        text: clipText(toolSubject(block['input']), ENTRY_TEXT_CHARS),
      });
    }
  }
  return out;
}

/** What a tool call was about: its file, command, pattern or skill, or nothing. */
function toolSubject(input: unknown): string {
  if (!isRecord(input)) return '';
  for (const key of ['file_path', 'command', 'pattern', 'skill', 'url', 'description', 'path']) {
    const field = input[key];
    if (typeof field === 'string' && field.trim() !== '') return field.trim();
  }
  return '';
}

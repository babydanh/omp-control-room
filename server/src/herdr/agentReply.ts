/**
 * agentReply: the last thing an agent in a herdr pane said, read from its own transcript.
 *
 * A finished work item needs the agent's report. The pane's screen holds only its last lines, often
 * just the input box and a status bar, while the report sits in the transcript as the agent's last
 * assistant message. herdr names the transcript: omp reports its session file, Claude Code its
 * session id (the file is `~/.claude/projects/<dir>/<id>.jsonl`). Other agents have none here.
 */

import * as fs from 'node:fs/promises';
import { homedir } from 'node:os';
import * as path from 'node:path';

import { isRecord } from '../company/typeGuards.js';

/** The part of a transcript read from its end: a final report lies within it. */
const TAIL_BYTES = 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ReplyAgent {
  readonly kind: string;
  readonly sessionFile?: string;
  readonly sessionId?: string;
}

/** The text of an assistant message, from either transcript format; empty when it has none. */
export function assistantText(line: string): string {
  if (!line.includes('"assistant"')) return '';
  let entry: unknown;
  try {
    entry = JSON.parse(line);
  } catch {
    return '';
  }
  const message = isRecord(entry) ? entry['message'] : undefined;
  if (!isRecord(message) || message['role'] !== 'assistant' || !Array.isArray(message['content'])) return '';
  return message['content']
    .flatMap((part: unknown) => (isRecord(part) && part['type'] === 'text' && typeof part['text'] === 'string' ? [part['text']] : []))
    .join('\n')
    .trim();
}

/** The last assistant text in a transcript's tail, or undefined. */
export async function lastAssistantText(file: string, tailBytes = TAIL_BYTES): Promise<string | undefined> {
  const handle = await fs.open(file, 'r');
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - tailBytes);
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    const lines = buffer.toString('utf8').split('\n');
    // A tail that starts mid-file starts mid-line: that first piece is not a whole entry.
    if (start > 0) lines.shift();
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const text = assistantText(lines[index] ?? '');
      if (text !== '') return text;
    }
    return undefined;
  } finally {
    await handle.close();
  }
}

/** Claude Code keeps a session under the project folder named after its cwd: look in each. */
async function claudeTranscript(sessionId: string, projectsDir: string): Promise<string | undefined> {
  if (!UUID.test(sessionId)) return undefined;
  const dirs = await fs.readdir(projectsDir, { withFileTypes: true }).catch(() => []);
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    const file = path.join(projectsDir, dir.name, `${sessionId}.jsonl`);
    if (await fs.stat(file).then(() => true, () => false)) return file;
  }
  return undefined;
}

/** The agent's last reply, or undefined when its transcript is unknown or holds none. Never rejects. */
export async function lastAgentReply(
  agent: ReplyAgent,
  claudeProjectsDir = path.join(homedir(), '.claude', 'projects'),
): Promise<string | undefined> {
  try {
    const file =
      agent.sessionFile ??
      (agent.kind === 'claude' && agent.sessionId !== undefined ? await claudeTranscript(agent.sessionId, claudeProjectsDir) : undefined);
    return file === undefined ? undefined : await lastAssistantText(file);
  } catch {
    return undefined;
  }
}

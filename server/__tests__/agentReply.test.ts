import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { lastAgentReply, lastAssistantText } from '../src/herdr/agentReply.js';

const SESSION = '1f2e3d4c-5b6a-4789-8abc-def012345678';

const claudeText = (text: string) => JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
const claudeTool = () => JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'Bash', input: {} }] } });
const ompText = (text: string) => JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'x' }, { type: 'text', text }] } });
const user = () => JSON.stringify({ type: 'user', message: { role: 'user', content: 'hỏi' } });

describe('lastAgentReply', () => {
  let dir = '';
  afterEach(() => {
    if (dir !== '') rmSync(dir, { recursive: true, force: true });
  });

  it('finds a Claude session by id in any project folder and returns its last text reply, skipping tool calls', async () => {
    dir = mkdtempSync(join(tmpdir(), 'agent-reply-'));
    mkdirSync(join(dir, 'V--repo'));
    writeFileSync(join(dir, 'V--repo', `${SESSION}.jsonl`), [user(), claudeText('Bản cũ'), user(), claudeText('## Báo cáo\n- route A'), claudeTool(), ''].join('\n'));
    expect(await lastAgentReply({ kind: 'claude', sessionId: SESSION }, dir)).toBe('## Báo cáo\n- route A');
  });

  it('reads an omp session file, and answers undefined for an unknown session or another agent kind', async () => {
    dir = mkdtempSync(join(tmpdir(), 'agent-reply-'));
    const file = join(dir, 'omp.jsonl');
    writeFileSync(file, [ompText('Xong: 3 file'), ''].join('\n'));
    expect(await lastAgentReply({ kind: 'omp', sessionFile: file }, dir)).toBe('Xong: 3 file');
    expect(await lastAgentReply({ kind: 'claude', sessionId: SESSION }, dir)).toBeUndefined();
    expect(await lastAgentReply({ kind: 'agy', sessionId: SESSION }, dir)).toBeUndefined();
  });

  it('reads only the tail, dropping the partial first line', async () => {
    dir = mkdtempSync(join(tmpdir(), 'agent-reply-'));
    const file = join(dir, 'long.jsonl');
    const last = claudeText('cuối');
    writeFileSync(file, [claudeText('x'.repeat(5000)), last, ''].join('\n'));
    expect(await lastAssistantText(file, last.length + 100)).toBe('cuối');
  });
});

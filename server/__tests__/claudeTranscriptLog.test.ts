import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { readClaudeTranscriptLog } from '../src/company/claudeCode/claudeTranscriptLog.js';

const roots: string[] = [];

function transcript(lines: unknown[]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-projects-'));
  roots.push(root);
  const dir = path.join(root, 'V--repo-worktrees-squad-1');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'run-1.jsonl'), lines.map((line) => JSON.stringify(line)).join('\n'));
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('readClaudeTranscriptLog', () => {
  it('reads the run text and each tool call with what it touched, in order', async () => {
    const root = transcript([
      { type: 'user', message: { content: 'Làm việc này' } },
      {
        type: 'assistant',
        timestamp: '2026-10-24T11:30:40.000Z',
        message: {
          content: [
            { type: 'text', text: 'Đọc trang quản lý trước.' },
            { type: 'tool_use', name: 'Read', input: { file_path: 'src/page.tsx' } },
          ],
        },
      },
      { type: 'user', message: { content: [{ type: 'tool_result', content: 'nội dung file' }] } },
      'không phải json',
      {
        type: 'assistant',
        timestamp: '2026-10-24T11:31:00.000Z',
        message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npx tsc --noEmit' } }] },
      },
    ]);

    expect(await readClaudeTranscriptLog('run-1', 50, root)).toEqual([
      { seq: 1, at: '2026-10-24T11:30:40.000Z', kind: 'text', runEpoch: 1, text: 'Đọc trang quản lý trước.' },
      { seq: 2, at: '2026-10-24T11:30:40.000Z', kind: 'tool', runEpoch: 1, toolName: 'Read', text: 'src/page.tsx' },
      { seq: 3, at: '2026-10-24T11:31:00.000Z', kind: 'tool', runEpoch: 1, toolName: 'Bash', text: 'npx tsc --noEmit' },
    ]);
  });

  it('keeps only the newest entries past the limit, and an unknown run has none', async () => {
    const root = transcript(
      ['a', 'b', 'c'].map((text) => ({ type: 'assistant', timestamp: 't', message: { content: [{ type: 'text', text }] } })),
    );

    expect((await readClaudeTranscriptLog('run-1', 2, root)).map((entry) => entry.text)).toEqual(['b', 'c']);
    expect(await readClaudeTranscriptLog('run-2', 50, root)).toEqual([]);
  });
});

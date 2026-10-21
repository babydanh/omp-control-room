import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { parseBoardArgs, runBoard } from '../src/boardCli.js';
import { HANDOFF_MAX_BYTES, readHandoffFiles } from '../src/ledger/handoffFiles.js';

let root: string | undefined;
async function worktree(files: Record<string, string>): Promise<string> {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'pxl-handoff-'));
  // A linked worktree has a `.git` file, not a folder.
  await fs.writeFile(path.join(root, '.git'), 'gitdir: elsewhere\n');
  for (const [relative, text] of Object.entries(files)) {
    const file = path.join(root, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, text);
  }
  return root;
}
afterEach(async () => {
  if (root !== undefined) await fs.rm(root, { recursive: true, force: true });
  root = undefined;
});

describe('readHandoffFiles', () => {
  it('reads the root note first and every open change, never an archived one', async () => {
    const dir = await worktree({
      'openspec/changes/doi-api/handoff.md': '## Mục tiêu\nđổi API\n',
      'openspec/changes/archive/cu/handoff.md': 'đã xong',
      'openspec/changes/chua-co/proposal.md': 'không có handoff',
      'HANDOFF.md': '## Trạng thái\nđang dở\n',
    });
    const files = await readHandoffFiles(dir);
    expect(files.map((file) => file.path)).toEqual([
      'HANDOFF.md',
      'openspec/changes/doi-api/handoff.md',
    ]);
    expect(files[1].text).toContain('đổi API');
    expect(files.every((file) => !file.truncated)).toBe(true);
  });

  it('cuts a note longer than the read limit and says so', async () => {
    const dir = await worktree({ 'HANDOFF.md': 'x'.repeat(HANDOFF_MAX_BYTES + 10) });
    const [file] = await readHandoffFiles(dir);
    expect(file.text).toHaveLength(HANDOFF_MAX_BYTES);
    expect(file.truncated).toBe(true);
  });
});

describe('board handoff', () => {
  it('parses an optional work item', () => {
    expect(parseBoardArgs(['handoff'])).toEqual({ kind: 'handoff' });
    expect(parseBoardArgs(['handoff', '#4'])).toEqual({ kind: 'handoff', item: '#4' });
  });

  it('finds the worktree root from a subfolder and prints the note, without a running board', async () => {
    const dir = await worktree({
      'HANDOFF.md': '## Mục tiêu\nsửa lỗi đăng nhập\n',
      'src/a/b.ts': '',
    });
    const output = await runBoard(['handoff'], {}, path.join(dir, 'src', 'a'));
    expect(output).toContain(path.join(dir, 'HANDOFF.md'));
    expect(output).toContain('sửa lỗi đăng nhập');
  });

  it('points to the template when the worktree has no note', async () => {
    const dir = await worktree({});
    const output = await runBoard(['handoff'], {}, dir);
    expect(output).toContain('Không có file bàn giao');
    expect(output).toContain('handoff-template.md');
  });
});

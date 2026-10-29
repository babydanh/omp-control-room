import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  listOpenSpecChanges,
  parseOpenSpecTasks,
  readOpenSpecFile,
} from '../src/ledger/openSpecChanges.js';

const source = (worktree: string) => ({
  repo: 'board',
  repoName: 'Pixel Agents',
  worktree,
  worktreeName: 'cloud-fleet-board',
  branch: 'feat/openspec',
});

describe('OpenSpec changes', () => {
  it('counts checked tasks and ignores checkbox examples in fenced code', () => {
    expect(parseOpenSpecTasks(`- [x] Finished\n- [ ] Pending\n  - [X] Nested\n\n\`\`\`md\n- [ ] Example\n\`\`\``)).toEqual({
      completed: 2,
      total: 3,
      percent: 67,
    });
    expect(parseOpenSpecTasks('````md\n````ts\n- [ ] Example\n````')).toEqual({
      completed: 0,
      total: 0,
      percent: null,
    });
    expect(parseOpenSpecTasks('No task list yet')).toEqual({ completed: 0, total: 0, percent: null });
  });

  it('lists worktree changes and opens only the three supported markdown files', async () => {
    const root = mkdtempSync(join(tmpdir(), 'openspec-changes-'));
    const checkout = join(root, 'checkout');
    const change = join(checkout, 'openspec', 'changes', 'feature-one');
    try {
      mkdirSync(change, { recursive: true });
      writeFileSync(join(change, 'proposal.md'), '# Feature One\n\n## Why\nShow the tracked proposal summary.\n');
      writeFileSync(join(change, 'tasks.md'), '- [x] List changes\n- [ ] Open files\n');
      writeFileSync(join(change, 'handoff.md'), 'handoff note');

      const changes = await listOpenSpecChanges([source(checkout)]);

      expect(changes).toEqual([
        expect.objectContaining({
          repo: 'board',
          repoName: 'Pixel Agents',
          worktree: checkout,
          worktreeName: 'cloud-fleet-board',
          branch: 'feat/openspec',
          id: 'feature-one',
          summary: 'Show the tracked proposal summary.',
          completedTasks: 1,
          totalTasks: 2,
          progressPercent: 50,
          hasProposal: true,
          hasTasks: true,
          hasHandoff: true,
        }),
      ]);
      expect(await readOpenSpecFile(checkout, 'feature-one', 'proposal.md')).toContain('Feature One');
      expect(await readOpenSpecFile(checkout, 'feature-one', 'handoff.md')).toBe('handoff note');
      expect(await readOpenSpecFile(checkout, '../outside', 'proposal.md')).toBeNull();
      expect(await readOpenSpecFile(checkout, 'feature-one', 'README.md')).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

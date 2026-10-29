import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  fitReport,
  parseLavish,
  parseTmux,
  readTaskBook,
  shouldBackupGuard,
  shouldPruneGuard,
  summarizeGuard,
} from './agent.mjs';

test('a huge diff is cut to fit the hub limit, keeping the file list', () => {
  const changes = Array.from({ length: 200 }, (_, i) => ({ path: `src/very/long/path/to/file-${i}.ts`, ranges: Array.from({ length: 20 }, (_, j) => [j * 10 + 1, j * 10 + 5]) }));
  const repos = Array.from({ length: 5 }, (_, r) => ({ path: `/data/home/r${r}`, branch: 'b', dirty_files: ['a.ts', 'b.ts'], changes: structuredClone(changes) }));
  const report = fitReport({ agent_id: 'danh', sessions: [], repos });
  assert.ok(Buffer.byteLength(JSON.stringify(report)) <= 60_000);
  assert.ok(report.repos.some((r) => r.changes_truncated));
  assert.deepEqual(report.repos[0].dirty_files, ['a.ts', 'b.ts']);
});

test('a small report is left untouched', () => {
  const report = { agent_id: 'danh', sessions: [], repos: [{ path: '/x', branch: 'b', dirty_files: ['a.ts'], changes: [{ path: 'a.ts', ranges: [[1, 2]] }] }] };
  assert.deepEqual(fitReport(structuredClone(report)), report);
});

test('a compact guard summary keeps risks and bounded worktree metadata', () => {
  const guard = {
    machine: 'm1',
    scannedAt: '2026-10-29T00:00:00.000Z',
    repos: [
      {
        repo: '/repo',
        stashes: 2,
        worktrees: [
          {
            path: '/repo/wt',
            branch: 'feat/a',
            head: 'abc',
            unpushed: 1,
            unpushedSubjects: ['work'],
            backedUp: false,
            dirty: 0,
            dirtyKnown: true,
            dirtyOldestMinutes: null,
            op: null,
            mergedToMain: false,
            idleDays: 3,
            prunable: false,
            idleMinutes: 4321,
            ignored: 2,
          },
        ],
      },
    ],
    risks: [
      { level: 'red', kind: 'unpushed', repo: '/repo', path: '/repo/wt', detail: 'not backed up' },
    ],
  };
  const summary = summarizeGuard(guard);
  assert.equal(summary.machine, 'm1');
  assert.equal(summary.repos[0].worktrees[0].head, 'abc');
  assert.equal(summary.repos[0].worktrees[0].unpushedSubjects[0], 'work');
  assert.equal(summary.repos[0].worktrees[0].idleMinutes, 4321);
  assert.equal(summary.repos[0].worktrees[0].ignored, 2);
  assert.equal(summary.repos[0].worktrees[0].dirtyKnown, true);
  assert.equal(summary.risks[0].kind, 'unpushed');
  assert.equal('stashes' in summary.repos[0], false);
});

test('guard reports are size-bounded and backup interval is thirty minutes', () => {
  const worktree = {
    path: '/repo/wt', branch: 'feat/a', head: 'a'.repeat(40), unpushed: 1,
    unpushedSubjects: ['work'], backedUp: false, dirty: 0, dirtyOldestMinutes: null,
    op: null, mergedToMain: false, idleDays: 3, prunable: false,
  };
  const large = {
    machine: 'm1', scannedAt: '2026-10-29T00:00:00.000Z',
    repos: Array.from({ length: 30 }, (_, i) => ({ repo: `/repo/${i}`, worktrees: Array.from({ length: 100 }, () => worktree) })),
    risks: Array.from({ length: 100 }, () => ({ level: 'red', kind: 'unpushed', repo: '/repo', path: '/repo/wt', detail: 'x'.repeat(300) })),
  };
  assert.ok(Buffer.byteLength(JSON.stringify(summarizeGuard(large))) <= 14_000);
  assert.equal(shouldBackupGuard(1_000, 1_000 + 30 * 60 * 1000 - 1), false);
  assert.equal(shouldBackupGuard(1_000, 1_000 + 30 * 60 * 1000), true);
  assert.equal(shouldBackupGuard(Number.NaN, 1_000), true);
});

test('many repos with long dirty paths still end under the limit', () => {
  const long = 'x'.repeat(200);
  const repos = Array.from({ length: 20 }, (_, r) => ({ path: `/data/home/${long}-${r}`, branch: long, dirty_files: Array.from({ length: 200 }, (_, i) => `${long}/${i}.ts`), changes: [] }));
  const report = fitReport({ agent_id: 'danh', sessions: [], repos });
  assert.ok(Buffer.byteLength(JSON.stringify(report)) <= 60_000);
});

test('tmux lines include detected engine, attached state, idle time and branch', () => {
  const text = 'xep-san\t1\t900\t/data/home/wt/backend-xep-san\tclaude\nnhap\t0\t1000\t\tbash\ncodex\t0\t950\t/data/home/wt/codex\tcodex\n';
  assert.deepEqual(
    parseTmux(text, 1000, (cwd) => (cwd.includes('xep-san') ? 'cloud/danh-xep-san' : '')),
    [
      {
        name: 'xep-san',
        cwd: '/data/home/wt/backend-xep-san',
        attached: true,
        idle_seconds: 100,
        engine: 'claude',
        command: 'claude',
        branch: 'cloud/danh-xep-san',
      },
      { name: 'nhap', cwd: '', attached: false, idle_seconds: 0, command: 'bash', branch: '' },
      {
        name: 'codex',
        cwd: '/data/home/wt/codex',
        attached: false,
        idle_seconds: 50,
        engine: 'codex',
        command: 'codex',
        branch: '',
      },
    ],
  );
  assert.deepEqual(parseTmux('', 1000), []);
});

test('lavish state keeps open sessions with hex keys, drops ended ones and junk', () => {
  const state = JSON.stringify({ sessions: {
    a: { key: 'b702b4f8df032645', file: '/data/home/wt/x/.lavish/plan.html', status: 'open', prompts: [] },
    b: { key: 'c0ffee00c0ffee00', file: '/tmp/old.html', status: 'ended' },
    c: { key: '../x', file: '/tmp/y.html', status: 'open' },
  } });
  assert.deepEqual(parseLavish(state), [{ key: 'b702b4f8df032645', file: '/data/home/wt/x/.lavish/plan.html' }]);
  assert.deepEqual(parseLavish('not json'), []);
});

test('task book: valid entries only, missing folder means no tasks', () => {
  const dir = mkdtempSync(join(tmpdir(), 'viec-'));
  writeFileSync(join(dir, 'xep-san.json'), JSON.stringify({ slug: 'xep-san', status: 'dang-lam', branch: 'cloud/danh-xep-san', kind: 'all', session: 'secret-ish' }));
  writeFileSync(join(dir, 'bad.json'), '{not json');
  writeFileSync(join(dir, 'evil.json'), JSON.stringify({ slug: '../x', status: 'dang-lam' }));
  assert.deepEqual(readTaskBook(dir), [{ slug: 'xep-san', status: 'dang-lam', branch: 'cloud/danh-xep-san', kind: 'all' }]);
  assert.deepEqual(readTaskBook(join(dir, 'khong-co')), []);
});

test('cloud guard pruning is enabled by default every six hours', () => {
  assert.equal(shouldPruneGuard(1_000, 1_000 + 6 * 60 * 60 * 1000 - 1), false);
  assert.equal(shouldPruneGuard(1_000, 1_000 + 6 * 60 * 60 * 1000), true);
  assert.equal(shouldPruneGuard(Number.NaN, 1_000), true);
  assert.equal(shouldPruneGuard(Number.NaN, 1_000, false), false);
});


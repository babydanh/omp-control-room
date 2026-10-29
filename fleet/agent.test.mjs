import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fitReport, parseLavish, parseTmux, readTaskBook } from './agent.mjs';

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

test('many repos with long dirty paths still end under the limit', () => {
  const long = 'x'.repeat(200);
  const repos = Array.from({ length: 20 }, (_, r) => ({ path: `/data/home/${long}-${r}`, branch: long, dirty_files: Array.from({ length: 200 }, (_, i) => `${long}/${i}.ts`), changes: [] }));
  const report = fitReport({ agent_id: 'danh', sessions: [], repos });
  assert.ok(Buffer.byteLength(JSON.stringify(report)) <= 60_000);
});

test('tmux lines become name, attached, idle time and branch; empty output means no sessions', () => {
  const text = 'xep-san\t1\t900\t/data/home/wt/backend-xep-san\tclaude\nnhap\t0\t1000\t\tbash\n';
  assert.deepEqual(parseTmux(text, 1000, (cwd) => (cwd.includes('xep-san') ? 'cloud/danh-xep-san' : '')), [
    { name: 'xep-san', attached: true, idle_seconds: 100, command: 'claude', branch: 'cloud/danh-xep-san' },
    { name: 'nhap', attached: false, idle_seconds: 0, command: 'bash', branch: '' },
  ]);
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

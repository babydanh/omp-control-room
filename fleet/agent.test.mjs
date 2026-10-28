import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fitReport } from './agent.mjs';

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

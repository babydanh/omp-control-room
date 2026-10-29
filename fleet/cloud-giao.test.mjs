import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = join(dirname(fileURLToPath(import.meta.url)), 'cloud-giao');
const run = (...args) => spawnSync('bash', [script, ...args], { encoding: 'utf8', input: '' });

test('the script is valid bash', () => {
  assert.equal(spawnSync('bash', ['-n', script], { encoding: 'utf8' }).status, 0);
});

test('an unknown engine is refused before anything is touched', () => {
  const result = run('--engine', 'codex', 'web', 'viec-mot', 'danh');
  assert.equal(result.status, 2);
  assert.match(result.stdout, /Engine/);
});

test('the old argument order (no flag) still reaches the repo check, and a bad repo is still refused', () => {
  assert.equal(run('nope', 'viec-mot', 'danh').status, 2);
  assert.equal(run('--engine', 'omp', 'nope', 'viec-mot', 'danh').status, 2);
});

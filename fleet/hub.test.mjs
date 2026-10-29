import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createHub } from './hub.mjs';
import { signJwt } from './jwt.mjs';

const pair = () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { pub: publicKey.export({ type: 'spki', format: 'pem' }), priv: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
};
const m1 = pair(), m2 = pair(), board = pair(), stranger = pair();
const dir = mkdtempSync(join(tmpdir(), 'fleet-'));
const keysPath = join(dir, 'keys.json');
writeFileSync(keysPath, JSON.stringify({ m1: { pub: m1.pub, role: 'report' }, m2: { pub: m2.pub, role: 'report' }, board: { pub: board.pub, role: 'read' } }));

const server = createHub({ keysPath, statePath: join(dir, 'state.json') });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());

const tok = (iss, role, priv, extra = {}) => signJwt({ iss, aud: 'fleet-hub', role, ...extra }, priv);
const report = (token, body) => fetch(`${base}/v1/report`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const read = (token) => fetch(`${base}/v1/fleet`, { headers: { Authorization: `Bearer ${token}` } });
const body = (id) => ({ agent_id: id, sessions: [{ engine: 'claude', cwd: '/data/home/x' }], repos: [{ path: '/data/home/x', branch: 'feat', dirty_files: ['a.ts'] }] });

test('a machine reports and the board reads it', async () => {
  assert.equal((await report(tok('m1', 'report', m1.priv), body('m1'))).status, 200);
  const res = await read(tok('board', 'read', board.priv));
  assert.equal(res.status, 200);
  const { machines } = await res.json();
  assert.deepEqual(machines.find((m) => m.agent_id === 'm1').repos[0].dirty_files, ['a.ts']);
});

test('stores a validated git guard report for the board', async () => {
  const guard = {
    machine: 'm1',
    scannedAt: '2026-10-29T12:00:00.000Z',
    repos: [
      {
        repo: '/repo',
        worktrees: [
          {
            path: '/repo/wt',
            branch: 'feat/a',
            head: 'a'.repeat(40),
            unpushed: 1,
            unpushedSubjects: ['work'],
            backedUp: false,
            dirty: 0,
            dirtyKnown: true,
            dirtyOldestMinutes: null,
            ignored: 2,
            op: null,
            mergedToMain: false,
            idleDays: 3,
            prunable: false,
            idleMinutes: 4321,
          },
        ],
      },
    ],
    risks: [
      { level: 'red', kind: 'unpushed', repo: '/repo', path: '/repo/wt', detail: 'not backed up' },
    ],
  };
  assert.equal((await report(tok('m1', 'report', m1.priv), { ...body('m1'), guard })).status, 200);
  const { machines } = await (await read(tok('board', 'read', board.priv))).json();
  assert.deepEqual(machines.find((machine) => machine.agent_id === 'm1').guard, guard);
});

test('drops a git guard with invalid field types', async () => {
  assert.equal((await report(tok('m1', 'report', m1.priv), { ...body('m1'), guard: {
    machine: 4, scannedAt: 'not a date', repos: [], risks: [],
  } })).status, 200);
  const { machines } = await (await read(tok('board', 'read', board.priv))).json();
  assert.equal(machines.find((machine) => machine.agent_id === 'm1').guard, null);
});

test('caps git guard payloads before storing them', async () => {
  const guard = {
    machine: 'm1', scannedAt: '2026-10-29T12:00:00.000Z',
    repos: [{ repo: 'r'.repeat(100), worktrees: Array.from({ length: 70 }, () => ({
      path: 'p'.repeat(100), branch: 'b'.repeat(100), head: 'a'.repeat(40), unpushed: 1,
      unpushedSubjects: [], backedUp: false, dirty: 0, dirtyOldestMinutes: null,
      op: null, mergedToMain: false, idleDays: 3, prunable: false,
    })) }],
    risks: Array.from({ length: 70 }, () => ({
      level: 'yellow', kind: 'dirty', repo: 'r'.repeat(100), path: 'p'.repeat(100), detail: 'd'.repeat(100),
    })),
  };
  assert.equal((await report(tok('m1', 'report', m1.priv), { ...body('m1'), guard })).status, 200);
  const { machines } = await (await read(tok('board', 'read', board.priv))).json();
  const saved = machines.find((machine) => machine.agent_id === 'm1').guard;
  assert.ok(Buffer.byteLength(JSON.stringify(saved)) <= 16 * 1024);
});

test('rejects a token signed by a key not registered for the issuer', async () => {
  assert.equal((await report(tok('m1', 'report', stranger.priv), body('m1'))).status, 401);
});

test('rejects alg other than EdDSA', async () => {
  const forged = tok('m1', 'report', m1.priv).split('.');
  forged[0] = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  assert.equal((await report(forged.join('.'), body('m1'))).status, 401);
});

test('rejects an expired token', async () => {
  const old = signJwt({ iss: 'm1', aud: 'fleet-hub', role: 'report' }, m1.priv, 300, Date.now() - 3600_000);
  assert.equal((await report(old, body('m1'))).status, 401);
});

test('rejects a replayed token', async () => {
  const t = tok('m2', 'report', m2.priv);
  assert.equal((await report(t, body('m2'))).status, 200);
  assert.equal((await report(t, body('m2'))).status, 401);
});

test('a machine cannot write another machine report', async () => {
  assert.equal((await report(tok('m1', 'report', m1.priv), body('m2'))).status, 403);
});

test('report key cannot read, read key cannot report', async () => {
  assert.equal((await read(tok('m1', 'report', m1.priv))).status, 401);
  assert.equal((await read(tok('m1', 'read', m1.priv))).status, 401);
  assert.equal((await report(tok('board', 'report', board.priv), body('board'))).status, 401);
});

test('rejects a missing token', async () => {
  assert.equal((await fetch(`${base}/v1/fleet`)).status, 401);
});

test('rejects a valid signature whose lifetime exceeds 5 minutes', async () => {
  assert.equal((await report(signJwt({ iss: 'm1', aud: 'fleet-hub', role: 'report' }, m1.priv, 86400), body('m1'))).status, 401);
});

test('a restarted hub refuses tokens issued before it started', async () => {
  const issued = signJwt({ iss: 'm1', aud: 'fleet-hub', role: 'report' }, m1.priv, 300, Date.now() - 10_000);
  const restarted = createHub({ keysPath, statePath: join(dir, 'state2.json') });
  await new Promise((r) => restarted.listen(0, '127.0.0.1', r));
  const res = await fetch(`http://127.0.0.1:${restarted.address().port}/v1/report`, { method: 'POST', headers: { Authorization: `Bearer ${issued}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body('m1')) });
  restarted.close();
  assert.equal(res.status, 401);
});

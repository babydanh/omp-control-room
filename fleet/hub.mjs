// fleet-hub: cloud machines POST signed reports; the board GETs the fleet. Read-only view, no code content.
// Env: FLEET_KEYS (path to keys.json: { agent_id: { pub: PEM, role: "report"|"read" } }),
//      FLEET_STATE (path to persisted latest reports), PORT (default 18430), HOST (default 127.0.0.1).
import { createServer } from 'node:http';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { verifyJwt } from './jwt.mjs';

const MAX_BODY = 64 * 1024;
const RATE_PER_MIN = 60;

export function createHub({ keysPath, statePath, now = () => Date.now(), startedAt = now() }) {
  const seenJti = new Map();
  const hits = new Map();
  const reports = statePath && existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {};
  const loadKeys = () => JSON.parse(readFileSync(keysPath, 'utf8'));

  const send = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  const auth = (req, role) => {
    const header = req.headers.authorization ?? '';
    if (!header.startsWith('Bearer ')) throw new Error('missing token');
    return verifyJwt(header.slice(7), { keys: loadKeys(), audience: 'fleet-hub', role, seenJti, now: now(), issuedAfter: startedAt });
  };
  const limited = (id) => {
    const minute = Math.floor(now() / 60000);
    const entry = hits.get(id);
    const count = entry && entry.minute === minute ? entry.count + 1 : 1;
    hits.set(id, { minute, count });
    return count > RATE_PER_MIN;
  };
  const persist = () => {
    if (!statePath) return;
    writeFileSync(`${statePath}.tmp`, JSON.stringify(reports), { mode: 0o600 });
    renameSync(`${statePath}.tmp`, statePath);
  };

  return createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://hub');
    if (req.method === 'GET' && url.pathname === '/v1/fleet') {
      try { auth(req, 'read'); } catch (e) { return send(res, 401, { error: e.message }); }
      return send(res, 200, { now: now(), machines: Object.values(reports) });
    }
    if (req.method === 'POST' && url.pathname === '/v1/report') {
      let claims;
      try { claims = auth(req, 'report'); } catch (e) { return send(res, 401, { error: e.message }); }
      if (limited(claims.iss)) return send(res, 429, { error: 'rate' });
      const chunks = [];
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY) { send(res, 413, { error: 'too large' }); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => {
        if (size > MAX_BODY) return;
        let body;
        try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { return send(res, 400, { error: 'json' }); }
        if (body.agent_id !== claims.iss) return send(res, 403, { error: 'agent_id mismatch' });
        reports[claims.iss] = {
          agent_id: claims.iss,
          received_at: now(),
          disk_free_gb: typeof body.disk_free_gb === 'number' ? body.disk_free_gb : null,
          sessions: Array.isArray(body.sessions) ? body.sessions.slice(0, 50) : [],
          repos: Array.isArray(body.repos) ? body.repos.slice(0, 20) : [],
        };
        persist();
        send(res, 200, { ok: true });
      });
      return;
    }
    send(res, 404, { error: 'not found' });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const server = createHub({ keysPath: process.env.FLEET_KEYS, statePath: process.env.FLEET_STATE });
  server.listen(Number(process.env.PORT ?? 18430), process.env.HOST ?? '127.0.0.1', () =>
    console.log(`fleet-hub listening ${process.env.HOST ?? '127.0.0.1'}:${process.env.PORT ?? 18430}`));
}

// Minimal EdDSA (Ed25519) JWT: sign on the machine, verify on the hub. Only alg=EdDSA is accepted.
import { createPrivateKey, createPublicKey, randomUUID, sign, verify } from 'node:crypto';

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const HEADER = b64u(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' }));

export function signJwt(claims, privateKeyPem, ttlSeconds = 300, now = Date.now()) {
  const iat = Math.floor(now / 1000);
  const body = b64u(JSON.stringify({ ...claims, iat, exp: iat + ttlSeconds, jti: randomUUID() }));
  const signature = sign(null, Buffer.from(`${HEADER}.${body}`), createPrivateKey(privateKeyPem));
  return `${HEADER}.${body}.${b64u(signature)}`;
}

/**
 * Verify a token against the key registered for its `iss`. Returns the claims or throws.
 * `keys` maps agent_id -> { pub: PEM, role }. `seenJti` is a Map jti -> expiry (ms) for replay checks.
 */
export function verifyJwt(token, { keys, audience, role, seenJti, now = Date.now(), skewSeconds = 60, maxTtlSeconds = 300, issuedAfter = 0 }) {
  const parts = String(token ?? '').split('.');
  if (parts.length !== 3) throw new Error('malformed');
  const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
  if (header.alg !== 'EdDSA') throw new Error('alg');
  const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
  const key = keys[claims.iss];
  if (!key) throw new Error('unknown issuer');
  const ok = verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey(key.pub), Buffer.from(parts[2], 'base64url'));
  if (!ok) throw new Error('signature');
  const nowS = Math.floor(now / 1000);
  if (claims.aud !== audience) throw new Error('audience');
  if (key.role !== role || claims.role !== role) throw new Error('role');
  if (typeof claims.exp !== 'number' || claims.exp + skewSeconds < nowS) throw new Error('expired');
  if (typeof claims.iat !== 'number' || claims.iat - skewSeconds > nowS) throw new Error('future');
  if (claims.exp - claims.iat > maxTtlSeconds) throw new Error('ttl');
  // The replay cache lives in memory: a token issued before this hub process started may
  // already have been used, so refuse it rather than accept a replay after a restart.
  if (claims.iat < Math.floor(issuedAfter / 1000)) throw new Error('replay');
  if (!claims.jti || seenJti.has(claims.jti)) throw new Error('replay');
  for (const [jti, until] of seenJti) if (until < now) seenJti.delete(jti);
  seenJti.set(claims.jti, (claims.exp + skewSeconds) * 1000);
  return claims;
}

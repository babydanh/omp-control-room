import { createPrivateKey, randomUUID, sign } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { type FleetConfig, readFleetConfig } from './config.js';
import { FLEET_CACHE_MS, FLEET_FETCH_TIMEOUT_MS } from './constants.js';

export type FleetHubEngine = 'claude' | 'codex' | 'omp';

export interface FleetHubSession {
  readonly engine: FleetHubEngine;
  readonly pid: number;
  readonly cwd: string;
  readonly branch: string;
}

export interface FleetHubRepo {
  readonly path: string;
  readonly branch: string;
  readonly ahead: number;
  readonly behind: number;
  readonly dirty_files: readonly string[];
}

export interface FleetHubMachine {
  readonly agent_id: string;
  readonly received_at: number;
  readonly sessions: readonly FleetHubSession[];
  readonly repos: readonly FleetHubRepo[];
}

export interface FleetHubResponse {
  readonly now: number;
  readonly machines: readonly FleetHubMachine[];
}

export interface FleetHubClient {
  fetchFleet(): Promise<FleetHubResponse>;
}

export interface FleetHubClientOptions {
  readonly configPath?: string;
  readonly loadConfig?: () => Promise<FleetConfig | null>;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
}

export class FleetUnavailableError extends Error {
  constructor() {
    super('Fleet is not configured.');
    this.name = 'FleetUnavailableError';
  }
}

const JWT_HEADER = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' })).toString('base64url');

/** Signs a short-lived read token locally. The private key and token never leave this module. */
function signReadToken(privateKeyPem: string, nowMs: number): string {
  const issuedAt = Math.floor(nowMs / 1000);
  const payload = Buffer.from(
    JSON.stringify({
      iss: 'board',
      aud: 'fleet-hub',
      role: 'read',
      iat: issuedAt,
      exp: issuedAt + 300,
      jti: randomUUID(),
    }),
  ).toString('base64url');
  const signature = sign(
    null,
    Buffer.from(`${JWT_HEADER}.${payload}`),
    createPrivateKey(privateKeyPem),
  ).toString('base64url');
  return `${JWT_HEADER}.${payload}.${signature}`;
}

export function createFleetHubClient(options: FleetHubClientOptions = {}): FleetHubClient {
  const now = options.now ?? Date.now;
  const fetcher = options.fetch ?? globalThis.fetch;
  const loadConfig = options.loadConfig ?? (() => readFleetConfig(options.configPath));
  let cached: { readonly at: number; readonly response: FleetHubResponse } | null = null;
  let inFlight: Promise<FleetHubResponse> | null = null;

  async function fetchFleet(): Promise<FleetHubResponse> {
    const config = await loadConfig();
    if (config === null) throw new FleetUnavailableError();
    if (cached !== null && now() - cached.at < FLEET_CACHE_MS) return cached.response;
    if (inFlight !== null) return inFlight;

    inFlight = fetchFromHub(config).then((response) => {
      cached = { at: now(), response };
      return response;
    });
    try {
      return await inFlight;
    } finally {
      inFlight = null;
    }
  }

  async function fetchFromHub(config: FleetConfig): Promise<FleetHubResponse> {
    const privateKeyPem = await readFile(config.keyPath, 'utf8');
    const token = signReadToken(privateKeyPem, now());
    const response = await fetcher(new URL('/v1/fleet', config.hub), {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(FLEET_FETCH_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`Fleet hub responded with ${response.status}.`);
    const payload: unknown = await response.json();
    if (
      typeof payload !== 'object' ||
      payload === null ||
      Array.isArray(payload) ||
      !('now' in payload) ||
      typeof payload.now !== 'number' ||
      !('machines' in payload) ||
      !Array.isArray(payload.machines)
    ) {
      throw new Error('Fleet hub returned an invalid response.');
    }
    return payload as FleetHubResponse;
  }

  return { fetchFleet };
}


import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import * as path from 'node:path';

import { FLEET_CONFIG_PATH_SEGMENTS } from './constants.js';

export interface FleetConfig {
  readonly hub: string;
  readonly keyPath: string;
}

export function defaultFleetConfigPath(): string {
  return path.join(homedir(), ...FLEET_CONFIG_PATH_SEGMENTS);
}

/** Missing or malformed optional config keeps the read-only Cloud view unavailable. */
export async function readFleetConfig(
  configPath = defaultFleetConfigPath(),
): Promise<FleetConfig | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(configPath, 'utf8'));
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed) ||
      !('hub' in parsed) ||
      typeof parsed.hub !== 'string' ||
      !('keyPath' in parsed) ||
      typeof parsed.keyPath !== 'string'
    ) {
      return null;
    }
    const hub = parsed.hub.trim();
    const keyPath = parsed.keyPath.trim();
    if (hub === '' || keyPath === '') return null;
    const hubUrl = new URL(hub);
    if (hubUrl.protocol !== 'https:') return null;
    return {
      hub: hubUrl.toString().replace(/\/$/, ''),
      keyPath: path.isAbsolute(keyPath) ? path.resolve(keyPath) : path.resolve(path.dirname(configPath), keyPath),
    };
  } catch {
    return null;
  }
}


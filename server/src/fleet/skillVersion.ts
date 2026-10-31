import { readFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const SKILL_VERSION = /^[0-9a-f]{12}$/;

/** Written by dong-bo-cloud.ps1 on every run: the hash of the bundle the cloud machines should hold. */
export const EXPECTED_SKILL_VERSION_FILE = (): string => path.join(os.homedir(), '.omp', 'cloud-sync-ver');

export function readExpectedSkillVersion(file: string = EXPECTED_SKILL_VERSION_FILE()): string | null {
  try {
    const text = readFileSync(file, 'utf8').trim();
    return SKILL_VERSION.test(text) ? text : null;
  } catch {
    return null;
  }
}

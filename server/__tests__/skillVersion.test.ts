import { mkdtempSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { readExpectedSkillVersion } from '../src/fleet/skillVersion.js';

describe('readExpectedSkillVersion', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'skillver-'));

  it('returns the 12-hex hash dong-bo-cloud.ps1 wrote', () => {
    const file = path.join(dir, 'ok');
    writeFileSync(file, '9e7a47bf9348\r\n');
    expect(readExpectedSkillVersion(file)).toBe('9e7a47bf9348');
  });

  it('returns null for a missing or malformed file', () => {
    const bad = path.join(dir, 'bad');
    writeFileSync(bad, 'rm -rf /');
    expect(readExpectedSkillVersion(bad)).toBeNull();
    expect(readExpectedSkillVersion(path.join(dir, 'missing'))).toBeNull();
  });
});

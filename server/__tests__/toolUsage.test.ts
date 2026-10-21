import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { readToolUsage } from '../src/ledger/toolUsage.js';

let dir: string | undefined;
async function usageFile(contents?: string): Promise<string> {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pxl-tool-usage-'));
  const file = path.join(dir, 'tool-usage.json');
  if (contents !== undefined) await fs.writeFile(file, contents);
  return file;
}
afterEach(async () => {
  if (dir !== undefined) await fs.rm(dir, { recursive: true, force: true });
  dir = undefined;
});

describe('readToolUsage', () => {
  it('reports a missing usage file with the generation command', async () => {
    const result = await readToolUsage('req', await usageFile());
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('python ~/.omp/scripts/tool-usage.py');
  });

  it('reports malformed JSON as unreadable', async () => {
    expect((await readToolUsage('req', await usageFile('{'))).ok).toBe(false);
  });

  it('maps the script output to rows, dropping malformed rows and error pairs', async () => {
    const file = await usageFile(
      JSON.stringify({
        generated_at: '2026-10-21T19:47:04',
        days: 14,
        transcripts: { omp: 615, claude: 'x' },
        rows: [
          {
            cli: 'omp',
            kind: 'mcp',
            name: 'ripwire/explore',
            calls: 50,
            ok: 30,
            err: 17,
            sessions: 9,
            last: '2026-10-21T19:00:00',
            top_errors: [['timeout', 12], ['bad'], 'x'],
          },
          { cli: 'claude', name: 'no kind' },
        ],
        unused_skills: { claude: ['seo', 3] },
      }),
    );
    const result = await readToolUsage('req', file);
    expect(result).toMatchObject({ ok: true, generatedAt: '2026-10-21T19:47:04', days: 14 });
    expect(result.transcripts).toEqual({ omp: 615 });
    expect(result.rows).toEqual([
      {
        cli: 'omp',
        kind: 'mcp',
        name: 'ripwire/explore',
        calls: 50,
        ok: 30,
        err: 17,
        sessions: 9,
        last: '2026-10-21T19:00:00',
        topErrors: [['timeout', 12]],
      },
    ]);
    expect(result.unusedSkills).toEqual({ claude: ['seo'] });
  });
});

import { expect, it } from 'vitest';

import { createWhoRunner } from '../src/ledger/ledgerRuntime.js';

it('runs who.py with the user session environment override', async () => {
  let received: NodeJS.ProcessEnv | undefined;
  const runner = createWhoRunner(async (_file, _args, options) => {
    received = options.env;
    return { ok: true, code: 0, stdout: '', stderr: '', timedOut: false, truncated: false };
  }, '/home/test/.omp/scripts/who.py');
  await runner(['send', 'session', 'hello'], { timeoutMs: 1000, okCodes: [0], maxBytes: 200 });
  expect(received?.LANE_SESSION).toBe('user');
});

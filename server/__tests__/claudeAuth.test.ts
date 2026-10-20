import { describe, expect, it } from 'vitest';

import {
  type ClaudeAuthRun,
  type ClaudeAuthRunResult,
  createClaudeAuthProbe,
} from '../src/company/claudeCode/claudeAuth.js';
import { CLAUDE_AUTH_ARGS, CLAUDE_COMMAND } from '../src/company/claudeCode/claudeCli.js';

const NOW = 1_000_000;
const TTL_MS = 60_000;
const SIGNED_IN: ClaudeAuthRunResult = {
  exitCode: 0,
  stdout: '{"loggedIn":true,"authMethod":"claude.ai"}',
};

/** A run that always answers the same way, and records each call. */
function recordingRun(answer: ClaudeAuthRunResult) {
  const calls: Array<readonly [string, readonly string[]]> = [];
  const run: ClaudeAuthRun = (file, args) => {
    calls.push([file, args]);
    return Promise.resolve(answer);
  };
  return { run, calls };
}

describe('createClaudeAuthProbe', () => {
  it('reports unknown before the first check', () => {
    const probe = createClaudeAuthProbe({ run: recordingRun(SIGNED_IN).run, now: () => NOW });
    expect(probe.current()).toEqual({ state: 'unknown' });
  });

  it('reports signed_in for a Claude account login and stamps the check time', async () => {
    const { run, calls } = recordingRun(SIGNED_IN);
    const probe = createClaudeAuthProbe({ run, now: () => NOW, ttlMs: TTL_MS });
    expect(await probe.check()).toEqual({
      state: 'signed_in',
      checkedAt: new Date(NOW).toISOString(),
    });
    expect(calls).toEqual([[CLAUDE_COMMAND, CLAUDE_AUTH_ARGS]]);
    expect(probe.current().state).toBe('signed_in');
  });

  it('reports signed_out for the CLI logged-out answer, exit 1 with loggedIn false', async () => {
    const probe = createClaudeAuthProbe({
      run: recordingRun({ exitCode: 1, stdout: '{"loggedIn":false,"authMethod":"none"}' }).run,
      now: () => NOW,
    });
    expect((await probe.check()).state).toBe('signed_out');
  });

  it('reports unknown when a non-zero exit gives no JSON answer', async () => {
    const probe = createClaudeAuthProbe({
      run: recordingRun({ exitCode: 1, stdout: '' }).run,
      now: () => NOW,
    });
    expect((await probe.check()).state).toBe('unknown');
  });

  it('reports missing when the program cannot be found', async () => {
    const probe = createClaudeAuthProbe({
      run: recordingRun({ exitCode: null, stdout: '', spawnError: 'ENOENT' }).run,
      now: () => NOW,
    });
    expect((await probe.check()).state).toBe('missing');
  });

  it('reports unknown when the probe itself fails to run', async () => {
    const run: ClaudeAuthRun = () => Promise.reject(new Error('boom'));
    const probe = createClaudeAuthProbe({ run, now: () => NOW });
    expect((await probe.check()).state).toBe('unknown');
  });

  it('reuses a fresh cached result without running the command again', async () => {
    const { run, calls } = recordingRun(SIGNED_IN);
    let clock = NOW;
    const probe = createClaudeAuthProbe({ run, now: () => clock, ttlMs: TTL_MS });
    const first = await probe.check();
    clock += TTL_MS - 1;
    expect(await probe.check()).toEqual(first);
    expect(calls).toHaveLength(1);
  });

  it('runs the command again once the cached result is older than the ttl', async () => {
    const { run, calls } = recordingRun(SIGNED_IN);
    let clock = NOW;
    const probe = createClaudeAuthProbe({ run, now: () => clock, ttlMs: TTL_MS });
    await probe.check();
    clock += TTL_MS;
    await probe.check();
    expect(calls).toHaveLength(2);
  });

  it('bypasses a fresh cache when forced', async () => {
    const { run, calls } = recordingRun(SIGNED_IN);
    const probe = createClaudeAuthProbe({ run, now: () => NOW, ttlMs: TTL_MS });
    await probe.check();
    await probe.check(true);
    expect(calls).toHaveLength(2);
  });

  it('shares one in-flight probe between concurrent callers', async () => {
    let runs = 0;
    let finish: (result: ClaudeAuthRunResult) => void = () => undefined;
    const run: ClaudeAuthRun = () => {
      runs += 1;
      return new Promise((resolve) => {
        finish = resolve;
      });
    };
    const probe = createClaudeAuthProbe({ run, now: () => NOW });
    const first = probe.check();
    const second = probe.check();
    expect(second).toBe(first);
    expect(runs).toBe(1);
    finish(SIGNED_IN);
    expect((await first).state).toBe('signed_in');
    expect(await second).toEqual(await first);
  });
});

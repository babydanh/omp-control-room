import { describe, expect, it } from 'vitest';

import {
  OMP_USAGE_ARGV,
  OmpQuotaService,
  parseOmpUsagePayload,
  type QuotaRunner,
  type QuotaRunnerRequest,
  type QuotaRunnerResult,
  redactQuotaText,
} from '../src/company/quotaService.js';

const AVAILABLE_PAYLOAD = JSON.stringify({
  generatedAt: 1790914741315,
  reports: [
    {
      provider: 'openai-codex',
      fetchedAt: 1790914684501,
      limits: [
        {
          id: 'openai-codex:primary',
          label: '7 days',
          window: { id: '7d', label: '7 days', durationMs: 604800000, resetsAt: 1791354977000 },
          amount: { used: 27, limit: 100, remaining: 73, usedFraction: 0.27, unit: 'percent' },
          status: 'ok',
        },
      ],
      metadata: { planType: 'plus', email: 'sc*', accountId: 'cd*' },
    },
    {
      provider: 'commandcode',
      fetchedAt: 1790914522732,
      limits: [
        {
          id: 'commandcode:balance',
          label: 'Credit balance',
          amount: { remaining: 6.971801644, unit: 'credits' },
        },
      ],
    },
  ],
  accountsWithoutUsage: [],
  disabledCredentials: [],
  capacity: {},
});

function ok(stdout: string): QuotaRunnerResult {
  return { stdout, stderr: '', exitCode: 0, timedOut: false };
}

interface Harness {
  service: OmpQuotaService;
  requests: QuotaRunnerRequest[];
  setResult(result: QuotaRunnerResult | (() => never)): void;
  advance(ms: number): void;
  now(): number;
}

function harness(initial: QuotaRunnerResult, startAt = 1_000_000): Harness {
  const requests: QuotaRunnerRequest[] = [];
  let clock = startAt;
  let next: QuotaRunnerResult | (() => never) = initial;
  const runner: QuotaRunner = (request) => {
    requests.push(request);
    if (typeof next === 'function') next();
    return Promise.resolve(next as QuotaRunnerResult);
  };
  return {
    service: new OmpQuotaService({
      executable: '/opt/omp/bin/omp',
      cwd: '/workspace',
      runner,
      now: () => clock,
      logger: () => {},
    }),
    requests,
    setResult: (result) => {
      next = result;
    },
    advance: (ms) => {
      clock += ms;
    },
    now: () => clock,
  };
}

describe('OmpQuotaService', () => {
  it('runs the usage command with a literal argv and no shell', async () => {
    const test = harness(ok(AVAILABLE_PAYLOAD));
    await test.service.refresh();

    expect(test.requests).toHaveLength(1);
    expect(test.requests[0].argv).toEqual(['usage', '--json', '--redact']);
    expect(test.requests[0].executable).toBe('/opt/omp/bin/omp');
    expect(test.requests[0].cwd).toBe('/workspace');
    expect(test.requests[0].timeoutMs).toBeGreaterThan(0);
    expect(OMP_USAGE_ARGV).toEqual(['usage', '--json', '--redact']);
  });

  it('allows at most one refresh per cooldown window', async () => {
    const test = harness(ok(AVAILABLE_PAYLOAD));
    const first = await test.service.refresh();

    const immediate = await test.service.refresh();
    expect(immediate.ran).toBe(false);
    expect(immediate.skipped).toBe('cooldown');
    expect(immediate.status).toBe(first.status);

    test.advance(299_999);
    expect((await test.service.refresh()).ran).toBe(false);
    expect(test.requests).toHaveLength(1);

    test.advance(1);
    expect((await test.service.refresh()).ran).toBe(true);
    expect(test.requests).toHaveLength(2);
  });

  it('keeps the last reported windows and marks them stale after a timeout', async () => {
    const test = harness(ok(AVAILABLE_PAYLOAD));
    const available = await test.service.refresh();
    expect(available.status).toBe('available');
    const before = test.service.snapshotFor('openai-codex');

    test.advance(300_000);
    test.setResult({ stdout: '', stderr: '', exitCode: null, timedOut: true });
    const timedOut = await test.service.refresh();

    expect(timedOut.status).toBe('error');
    const after = test.service.snapshotFor('openai-codex');
    expect(after?.status).toBe('stale');
    expect(after?.windows).toEqual(before?.windows);
    // A stale snapshot keeps the moment it was actually fetched, so the panel can
    // show how old the numbers are instead of implying they are current.
    expect(after?.fetchedAt).toBe(before?.fetchedAt);
  });

  it('keeps the last reported windows when the command fails outright', async () => {
    const test = harness(ok(AVAILABLE_PAYLOAD));
    await test.service.refresh();

    test.advance(300_000);
    test.setResult(() => {
      throw new Error('spawn ENOENT /opt/omp/bin/omp');
    });
    const failed = await test.service.refresh();

    expect(failed.status).toBe('error');
    expect(test.service.snapshotFor('commandcode')?.status).toBe('stale');
    expect(test.service.snapshotFor('commandcode')?.windows).toHaveLength(1);
  });

  it('marks a provider unsupported when its credential has no usage endpoint', async () => {
    const test = harness(
      ok(
        JSON.stringify({
          generatedAt: 1,
          reports: [],
          accountsWithoutUsage: [{ provider: 'local-llm', email: 'lo*' }],
          disabledCredentials: [],
        }),
      ),
    );

    const result = await test.service.refresh();
    expect(result.status).toBe('unsupported');
    expect(test.service.snapshotFor('local-llm')).toMatchObject({
      provider: 'local-llm',
      status: 'unsupported',
      accountLabel: 'lo*',
    });
    // No invented number: an unsupported provider reports no window amount.
    expect(test.service.snapshotFor('local-llm')?.windows[0].used).toBeUndefined();
  });

  it('marks a provider unauthenticated when its stored credential is disabled', async () => {
    const test = harness(
      ok(
        JSON.stringify({
          generatedAt: 1,
          reports: [],
          accountsWithoutUsage: [],
          disabledCredentials: [{ provider: 'anthropic', email: 'an*' }],
        }),
      ),
    );

    const result = await test.service.refresh();
    expect(result.status).toBe('unauthenticated');
    expect(test.service.snapshotFor('anthropic')).toMatchObject({ status: 'unauthenticated' });
  });

  it('reports nothing authenticated when the payload names no provider', async () => {
    const test = harness(
      ok(
        JSON.stringify({
          generatedAt: 1,
          reports: [],
          accountsWithoutUsage: [],
          disabledCredentials: [],
        }),
      ),
    );

    const result = await test.service.refresh();
    expect(result.status).toBe('unauthenticated');
    expect(test.service.snapshots()).toHaveLength(0);
  });

  it('reads a missing credential message from a failed command as unauthenticated', () => {
    const outcome = parseOmpUsagePayload(
      '',
      'No credentials found. Run `omp` and use /login to add accounts.\n',
      1,
    );
    expect(outcome.kind).toBe('unauthenticated');
  });

  it('reports providers the payload never mentions as gone, not stale', async () => {
    const test = harness(ok(AVAILABLE_PAYLOAD));
    await test.service.refresh();
    expect(test.service.snapshotFor('commandcode')).toBeDefined();

    test.advance(300_000);
    test.setResult(
      ok(
        JSON.stringify({
          generatedAt: 2,
          reports: [
            {
              provider: 'openai-codex',
              fetchedAt: 2,
              limits: [{ id: 'a', label: '7 days', amount: { used: 40, unit: 'percent' } }],
            },
          ],
          accountsWithoutUsage: [{ provider: 'local-llm' }],
        }),
      ),
    );
    await test.service.refresh();

    // A fresh full report is authoritative: commandcode no longer has one.
    expect(test.service.snapshotFor('commandcode')).toBeUndefined();
    // A credential with no usage endpoint is still named, with its own state.
    expect(test.service.snapshotFor('local-llm')?.status).toBe('unsupported');
    expect(test.service.snapshotFor('openai-codex')?.windows[0].used).toBe(40);
  });

  it('never attributes a quota window to a session', async () => {
    const test = harness(ok(AVAILABLE_PAYLOAD));
    await test.service.refresh();

    for (const snapshot of test.service.snapshots()) {
      expect(JSON.stringify(snapshot)).not.toContain('session');
    }
  });
});

describe('parseOmpUsagePayload', () => {
  it('preserves the provider unit and reset time instead of normalising them', () => {
    const outcome = parseOmpUsagePayload(AVAILABLE_PAYLOAD, '', 0);
    expect(outcome.kind).toBe('available');

    const codex = outcome.snapshots.find((snapshot) => snapshot.provider === 'openai-codex');
    expect(codex?.windows[0]).toMatchObject({
      label: '7 days',
      used: 27,
      remaining: 73,
      reportedUnit: 'percent',
      resetAt: new Date(1791354977000).toISOString(),
    });

    const commandcode = outcome.snapshots.find((snapshot) => snapshot.provider === 'commandcode');
    expect(commandcode?.windows[0]).toMatchObject({
      label: 'Credit balance',
      remaining: 6.971801644,
      reportedUnit: 'credits',
    });
    // A window that reported no `used` reports none; it is not zero.
    expect(commandcode?.windows[0].used).toBeUndefined();
    expect(commandcode?.windows[0].resetAt).toBeUndefined();
  });

  it('treats unparseable output as an error rather than an empty success', () => {
    const outcome = parseOmpUsagePayload('<!doctype html><h1>proxy</h1>', '', 0);
    expect(outcome.kind).toBe('error');
    expect(outcome.snapshots).toHaveLength(0);
  });
});

describe('redactQuotaText', () => {
  it('removes token-shaped text while keeping the diagnostic readable', () => {
    const redacted = redactQuotaText(
      '401 from provider: sk-live-abcdef0123456789 with Bearer aaaaaaaaaaaaaaaa and api_key=zzzzzzzzzzzz',
    );

    expect(redacted).not.toContain('sk-live-abcdef0123456789');
    expect(redacted).not.toContain('aaaaaaaaaaaaaaaa');
    expect(redacted).not.toContain('zzzzzzzzzzzz');
    expect(redacted).toContain('401 from provider');
  });

  it('keeps an already masked account label readable', () => {
    expect(redactQuotaText('account sc* reported no usage endpoint')).toBe(
      'account sc* reported no usage endpoint',
    );
  });

  it('truncates an unbounded error message', () => {
    expect(redactQuotaText('x'.repeat(1000), 32)).toHaveLength(33);
  });
});

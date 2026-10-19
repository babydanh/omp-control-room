import { describe, expect, it } from 'vitest';

import type { QuotaSnapshot } from '../../core/src/messages.js';
import { COMPANY_USAGE_LIMITS_MIN_INTERVAL_MS } from '../src/company/constants.js';
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

function byProvider(service: OmpQuotaService, provider: string): QuotaSnapshot | undefined {
  return service.snapshots().find((snapshot) => snapshot.provider === provider);
}

interface Harness {
  service: OmpQuotaService;
  requests: QuotaRunnerRequest[];
  setResult(result: QuotaRunnerResult | (() => never)): void;
  advance(ms: number): void;
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
      command: () => ({ file: '/opt/omp/bin/omp', args: [] }),
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
  };
}

describe('OmpQuotaService', () => {
  it('runs the usage command with the resolved launch args and no shell', async () => {
    const requests: QuotaRunnerRequest[] = [];
    const service = new OmpQuotaService({
      command: () => ({ file: '/opt/omp/bin/omp', args: ['--bridge'] }),
      cwd: '/workspace',
      runner: (request) => {
        requests.push(request);
        return Promise.resolve(ok(AVAILABLE_PAYLOAD));
      },
      logger: () => {},
    });
    await service.refresh();

    expect(requests).toHaveLength(1);
    expect(requests[0].argv).toEqual(['--bridge', 'usage', '--json', '--redact']);
    expect(requests[0].executable).toBe('/opt/omp/bin/omp');
    expect(requests[0].cwd).toBe('/workspace');
    expect(requests[0].timeoutMs).toBeGreaterThan(0);
    expect(OMP_USAGE_ARGV).toEqual(['usage', '--json', '--redact']);
  });

  it('allows at most one refresh per cooldown window', async () => {
    const test = harness(ok(AVAILABLE_PAYLOAD));
    const first = await test.service.refresh();

    const immediate = await test.service.refresh();
    expect(immediate.ran).toBe(false);
    expect(immediate.skipped).toBe('cooldown');
    expect(immediate.status).toBe(first.status);

    test.advance(COMPANY_USAGE_LIMITS_MIN_INTERVAL_MS - 1);
    expect((await test.service.refresh()).ran).toBe(false);
    expect(test.requests).toHaveLength(1);

    test.advance(1);
    expect((await test.service.refresh()).ran).toBe(true);
    expect(test.requests).toHaveLength(2);
  });

  it('keeps the cooldown after a launch that fails outright', async () => {
    const test = harness(ok(AVAILABLE_PAYLOAD));
    test.setResult(() => {
      throw new Error('spawn ENOENT /opt/omp/bin/omp');
    });
    expect((await test.service.refresh()).status).toBe('error');

    expect((await test.service.refresh()).ran).toBe(false);
    expect(test.requests).toHaveLength(1);
  });

  it('keeps the last reported windows and marks them stale after a timeout', async () => {
    const test = harness(ok(AVAILABLE_PAYLOAD));
    const available = await test.service.refresh();
    expect(available.status).toBe('available');
    const before = byProvider(test.service, 'openai-codex');

    test.advance(COMPANY_USAGE_LIMITS_MIN_INTERVAL_MS);
    test.setResult({ stdout: '', stderr: '', exitCode: null, timedOut: true });
    const timedOut = await test.service.refresh();

    expect(timedOut.status).toBe('error');
    const after = byProvider(test.service, 'openai-codex');
    expect(after?.status).toBe('stale');
    expect(after?.windows).toEqual(before?.windows);
    // A stale snapshot keeps the moment it was actually fetched, so the panel can
    // show how old the numbers are instead of implying they are current.
    expect(after?.fetchedAt).toBe(before?.fetchedAt);
  });

  it('keeps the last reported windows when the command fails outright', async () => {
    const test = harness(ok(AVAILABLE_PAYLOAD));
    await test.service.refresh();

    test.advance(COMPANY_USAGE_LIMITS_MIN_INTERVAL_MS);
    test.setResult(() => {
      throw new Error('spawn ENOENT /opt/omp/bin/omp');
    });
    const failed = await test.service.refresh();

    expect(failed.status).toBe('error');
    expect(byProvider(test.service, 'commandcode')?.status).toBe('stale');
    expect(byProvider(test.service, 'commandcode')?.windows).toHaveLength(1);
  });

  it('keeps two accounts of one provider as two rows', async () => {
    const payload = JSON.stringify({
      generatedAt: 1,
      reports: [
        {
          provider: 'anthropic',
          fetchedAt: 1,
          limits: [{ id: 'a:5h', label: '5 hours', amount: { used: 10, unit: 'percent' } }],
          metadata: { accountId: 'aa*' },
        },
        {
          provider: 'anthropic',
          fetchedAt: 1,
          limits: [{ id: 'a:5h', label: '5 hours', amount: { used: 80, unit: 'percent' } }],
          metadata: { accountId: 'bb*' },
        },
      ],
      accountsWithoutUsage: [],
      disabledCredentials: [],
    });
    const test = harness(ok(payload));
    await test.service.refresh();

    const rows = test.service.snapshots().filter((snapshot) => snapshot.provider === 'anthropic');
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.windows[0].used).sort()).toEqual([10, 80]);
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
    const row = byProvider(test.service, 'local-llm');
    expect(row).toMatchObject({
      provider: 'local-llm',
      status: 'unsupported',
      accountLabel: 'lo*',
      windows: [],
    });
    expect(row?.note).toBe('Nhà cung cấp này không công bố điểm đo hạn mức.');
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
    expect(byProvider(test.service, 'anthropic')).toMatchObject({
      status: 'unauthenticated',
      windows: [],
    });
    expect(byProvider(test.service, 'anthropic')?.note).toBe('Thông tin đăng nhập đã bị tắt.');
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
    expect(byProvider(test.service, 'commandcode')).toBeDefined();

    test.advance(COMPANY_USAGE_LIMITS_MIN_INTERVAL_MS);
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
    expect(byProvider(test.service, 'commandcode')).toBeUndefined();
    // A credential with no usage endpoint is still named, with its own state.
    expect(byProvider(test.service, 'local-llm')?.status).toBe('unsupported');
    expect(byProvider(test.service, 'openai-codex')?.windows[0].used).toBe(40);
  });

  it('keeps the last numbers stale when the payload has the wrong shape', async () => {
    const test = harness(ok(AVAILABLE_PAYLOAD));
    await test.service.refresh();

    test.advance(COMPANY_USAGE_LIMITS_MIN_INTERVAL_MS);
    test.setResult(ok(JSON.stringify({ generatedAt: 1 })));
    const result = await test.service.refresh();

    expect(result.status).toBe('invalid');
    expect(byProvider(test.service, 'commandcode')?.status).toBe('stale');
    expect(byProvider(test.service, 'commandcode')?.windows).toHaveLength(1);
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

  it('skips OMP progress lines before the JSON object', () => {
    const outcome = parseOmpUsagePayload(`Syncing accounts...\n${AVAILABLE_PAYLOAD}`, '', 0);
    expect(outcome.kind).toBe('available');
  });

  it('reads a capacity table keyed by provider', () => {
    const payload = JSON.stringify({
      generatedAt: 1,
      reports: [
        { provider: 'anthropic', fetchedAt: 1, limits: [], metadata: { accountId: 'acct-1' } },
      ],
      accountsWithoutUsage: [],
      disabledCredentials: [],
      capacity: {
        anthropic: [
          {
            window: '5h',
            durationMs: 18000000,
            meter: 'requests',
            accounts: 2,
            usedAccounts: 1,
            remainingAccounts: 1,
          },
        ],
      },
    });
    const outcome = parseOmpUsagePayload(payload, '', 0);
    expect(outcome.kind).toBe('available');
    expect(outcome.capacity).toHaveLength(1);
    expect(outcome.capacity[0]).toMatchObject({
      provider: 'anthropic',
      window: '5h',
      durationMs: 18000000,
      meter: 'requests',
      accounts: 2,
      usedAccounts: 1,
      remainingAccounts: 1,
    });
  });

  it('treats a malformed capacity table as an invalid payload', () => {
    const payload = JSON.stringify({
      generatedAt: 1,
      reports: [],
      accountsWithoutUsage: [],
      disabledCredentials: [],
      capacity: { anthropic: 'x' },
    });
    expect(parseOmpUsagePayload(payload, '', 0).kind).toBe('invalid');
  });

  it('treats exit-0 output that is not the usage JSON as invalid', () => {
    const outcome = parseOmpUsagePayload('<!doctype html><h1>proxy</h1>', '', 0);
    expect(outcome.kind).toBe('invalid');
    expect(outcome.snapshots).toHaveLength(0);
  });

  it('treats a failed command that printed no JSON as an error', () => {
    const outcome = parseOmpUsagePayload('not json', 'boom', 2);
    expect(outcome.kind).toBe('error');
    expect(outcome.snapshots).toHaveLength(0);
  });
});

describe('OmpQuotaService command resolution', () => {
  it('spawns nothing and rejects when the command cannot be resolved', async () => {
    const requests: QuotaRunnerRequest[] = [];
    let resolvable = false;
    const service = new OmpQuotaService({
      command: () => {
        if (!resolvable) throw new Error('omp not found');
        return { file: '/opt/omp/bin/omp', args: [] };
      },
      cwd: '/workspace',
      runner: (request) => {
        requests.push(request);
        return Promise.resolve(ok(AVAILABLE_PAYLOAD));
      },
      logger: () => {},
    });

    await expect(service.refresh()).rejects.toMatchObject({ code: 'usage_unavailable' });
    expect(requests).toHaveLength(0);

    // Nothing was attempted, so the cooldown is still open for the next request.
    resolvable = true;
    expect((await service.refresh()).ran).toBe(true);
    expect(requests).toHaveLength(1);
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

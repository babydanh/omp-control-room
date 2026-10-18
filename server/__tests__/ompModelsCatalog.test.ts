import { describe, expect, it } from 'vitest';

import { COMPANY_MODEL_CATALOG_TIMEOUT_MS } from '../src/company/constants.js';
import { buildCompanyModelCatalog } from '../src/company/modelCatalog.js';
import {
  OMP_MODELS_ARGV,
  parseOmpModelsPayload,
  readOmpModelsCatalog,
} from '../src/company/ompModelsCatalog.js';
import type { QuotaRunnerRequest, QuotaRunnerResult } from '../src/company/quotaService.js';

/** A subset of the real `omp models --json` payload: the fields Company reads. */
const PAYLOAD = JSON.stringify({
  models: [
    {
      provider: 'anthropic',
      kind: 'chat',
      id: 'claude-sonnet-5-5',
      selector: 'anthropic/claude-sonnet-5-5',
      name: 'Claude Sonnet 5.5',
      contextWindow: 200000,
      maxTokens: 64000,
      reasoning: true,
      thinking: ['low', 'medium', 'high'],
      input: ['text', 'image'],
    },
    {
      provider: 'openai',
      kind: 'chat',
      id: 'text-only',
      selector: 'openai/text-only',
      name: 'Text only',
      contextWindow: 128000,
      maxTokens: null,
      reasoning: false,
      thinking: null,
      input: ['text'],
    },
  ],
});

const COMMAND = { file: 'C:/omp/node.exe', args: ['C:/omp/cli.js'] };

/** A process boundary that answers with the given outcome and records each request. */
function runnerReturning(
  result: Partial<QuotaRunnerResult>,
  requests: QuotaRunnerRequest[] = [],
): (request: QuotaRunnerRequest) => Promise<QuotaRunnerResult> {
  return async (request) => {
    requests.push(request);
    return { stdout: '', stderr: '', exitCode: 0, timedOut: false, ...result };
  };
}

describe('parseOmpModelsPayload', () => {
  it('keys each model by its selector and keeps the modalities and levels it reports', () => {
    expect(parseOmpModelsPayload(PAYLOAD)).toEqual([
      {
        id: 'anthropic/claude-sonnet-5-5',
        provider: 'anthropic',
        model: 'claude-sonnet-5-5',
        input: ['text', 'image'],
        thinkingLevels: ['low', 'medium', 'high'],
        configured: true,
      },
      {
        id: 'openai/text-only',
        provider: 'openai',
        model: 'text-only',
        input: ['text'],
        thinkingLevels: [],
        configured: true,
      },
    ]);
  });

  it('builds catalog entries that gate images on the input modalities', () => {
    expect(buildCompanyModelCatalog(parseOmpModelsPayload(PAYLOAD))).toEqual([
      {
        id: 'anthropic/claude-sonnet-5-5',
        provider: 'anthropic',
        model: 'claude-sonnet-5-5',
        thinking: ['low', 'medium', 'high'],
        acceptsImages: true,
        credentialsConfigured: true,
      },
      {
        id: 'openai/text-only',
        provider: 'openai',
        model: 'text-only',
        thinking: [],
        acceptsImages: false,
        credentialsConfigured: true,
      },
    ]);
  });
});

describe('readOmpModelsCatalog', () => {
  it('runs the resolved command with models --json and no session flags', async () => {
    const requests: QuotaRunnerRequest[] = [];
    const models = await readOmpModelsCatalog({
      command: COMMAND,
      cwd: 'C:/ws',
      runner: runnerReturning({ stdout: PAYLOAD }, requests),
    });

    expect(models.map((model) => model.id)).toEqual([
      'anthropic/claude-sonnet-5-5',
      'openai/text-only',
    ]);
    expect(requests).toEqual([
      {
        executable: 'C:/omp/node.exe',
        argv: ['C:/omp/cli.js', ...OMP_MODELS_ARGV],
        cwd: 'C:/ws',
        timeoutMs: COMPANY_MODEL_CATALOG_TIMEOUT_MS,
      },
    ]);
    expect(OMP_MODELS_ARGV).toEqual(['models', '--json']);
  });

  it('accepts an empty list when no provider has a credential', async () => {
    await expect(
      readOmpModelsCatalog({
        command: COMMAND,
        cwd: 'C:/ws',
        runner: runnerReturning({ stdout: '{"models":[]}' }),
      }),
    ).resolves.toEqual([]);
  });

  it('refuses a read that timed out', async () => {
    await expect(
      readOmpModelsCatalog({
        command: COMMAND,
        cwd: 'C:/ws',
        runner: runnerReturning({ exitCode: null, timedOut: true }),
      }),
    ).rejects.toMatchObject({ code: 'model_catalog_unavailable' });
  });

  it('refuses a process that could not be started', async () => {
    await expect(
      readOmpModelsCatalog({
        command: COMMAND,
        cwd: 'C:/ws',
        runner: runnerReturning({ exitCode: null }),
      }),
    ).rejects.toMatchObject({ code: 'model_catalog_unavailable' });
  });

  it('refuses a non-zero exit even when stdout looks like a model list', async () => {
    await expect(
      readOmpModelsCatalog({
        command: COMMAND,
        cwd: 'C:/ws',
        runner: runnerReturning({ stdout: PAYLOAD, exitCode: 1 }),
      }),
    ).rejects.toMatchObject({ code: 'model_catalog_unavailable' });
  });

  it('refuses output with no JSON model list', async () => {
    await expect(
      readOmpModelsCatalog({
        command: COMMAND,
        cwd: 'C:/ws',
        runner: runnerReturning({ stdout: 'No models available. Set API keys.' }),
      }),
    ).rejects.toMatchObject({ code: 'model_catalog_unavailable' });
  });

  it('refuses the whole list when one row has no selector', async () => {
    const partial = JSON.stringify({
      models: [
        {
          provider: 'openai',
          id: 'text-only',
          input: ['text'],
          thinking: null,
        },
      ],
    });
    await expect(
      readOmpModelsCatalog({
        command: COMMAND,
        cwd: 'C:/ws',
        runner: runnerReturning({ stdout: partial }),
      }),
    ).rejects.toMatchObject({ code: 'model_catalog_unavailable' });
  });

  it('refuses without running anything when no executable is configured', async () => {
    const requests: QuotaRunnerRequest[] = [];
    await expect(
      readOmpModelsCatalog({
        command: { file: '', args: [] },
        cwd: 'C:/ws',
        runner: runnerReturning({ stdout: PAYLOAD }, requests),
      }),
    ).rejects.toMatchObject({ code: 'model_catalog_unavailable' });
    expect(requests).toHaveLength(0);
  });

  it('refuses when the process boundary itself fails', async () => {
    await expect(
      readOmpModelsCatalog({
        command: COMMAND,
        cwd: 'C:/ws',
        runner: () => Promise.reject(new Error('spawn EPERM')),
      }),
    ).rejects.toMatchObject({ code: 'model_catalog_unavailable' });
  });
});

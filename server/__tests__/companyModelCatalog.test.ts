import { describe, expect, it } from 'vitest';

import {
  assertImageDeliverable,
  buildCompanyModelCatalog,
  buildCompanyModelCatalogFromBridge,
  selectRoleModel,
} from '../src/company/modelCatalog.js';

describe('company model catalog', () => {
  it('reports image support from the model input modalities, not the name', () => {
    const catalog = buildCompanyModelCatalog([
      {
        id: 'openai-codex/gpt-6.1-sol',
        provider: 'openai-codex',
        model: 'gpt-6.1-sol',
        input: ['text', 'image'],
      },
      {
        id: 'openai-codex/gpt-6-luna',
        provider: 'openai-codex',
        model: 'gpt-6-luna',
        input: ['text'],
      },
    ]);

    expect(catalog).toHaveLength(2);
    expect(catalog[0]).toMatchObject({ id: 'openai-codex/gpt-6.1-sol', acceptsImages: true });
    expect(catalog[1]).toMatchObject({ id: 'openai-codex/gpt-6-luna', acceptsImages: false });
  });

  it('exposes the thinking levels a model accepts and never invents one', () => {
    const catalog = buildCompanyModelCatalog([
      {
        id: 'provider/model',
        provider: 'provider',
        model: 'model',
        input: ['text'],
        thinkingLevels: ['low', 'high'],
      },
      { id: 'provider/plain', provider: 'provider', model: 'plain', input: ['text'] },
    ]);

    expect(catalog[0].thinking).toEqual(['low', 'high']);
    expect(catalog[1].thinking).toEqual([]);
  });

  it('marks credentials as configured only when the runtime says so', () => {
    const catalog = buildCompanyModelCatalog([
      { id: 'p/m', provider: 'p', model: 'm', input: ['text'], configured: true },
      { id: 'p/n', provider: 'p', model: 'n', input: ['text'] },
    ]);

    expect(catalog[0].credentialsConfigured).toBe(true);
    expect(catalog[1].credentialsConfigured).toBe(false);
  });

  it('refuses to deliver an image to a model whose modalities exclude it', () => {
    const catalog = buildCompanyModelCatalog([
      { id: 'p/vision', provider: 'p', model: 'vision', input: ['text', 'image'] },
      { id: 'p/text', provider: 'p', model: 'text', input: ['text'] },
    ]);

    expect(() => assertImageDeliverable(catalog, 'p/vision')).not.toThrow();
    expect(() => assertImageDeliverable(catalog, 'p/text')).toThrowError(
      expect.objectContaining({ code: 'image_not_supported_by_model' }),
    );
    expect(() => assertImageDeliverable(catalog, 'p/unknown')).toThrowError(
      expect.objectContaining({ code: 'unknown_model' }),
    );
  });

  it('selects the requested model for a role or reports why it cannot', () => {
    const catalog = buildCompanyModelCatalog([
      {
        id: 'p/vision',
        provider: 'p',
        model: 'vision',
        input: ['text', 'image'],
        configured: true,
      },
      { id: 'p/text', provider: 'p', model: 'text', input: ['text'], configured: true },
      { id: 'p/unconfigured', provider: 'p', model: 'unconfigured', input: ['text'] },
    ]);

    expect(selectRoleModel(catalog, 'p/text')?.id).toBe('p/text');
    expect(() => selectRoleModel(catalog, 'p/unconfigured')).toThrowError(
      expect.objectContaining({ code: 'model_credentials_missing' }),
    );
    expect(() => selectRoleModel(catalog, 'p/missing')).toThrowError(
      expect.objectContaining({ code: 'unknown_model' }),
    );
  });

  it('projects a catalog for the run that read it and refuses one from another run', () => {
    const catalog = {
      sessionId: 'session-1',
      runEpoch: 4,
      models: [{ id: 'p/m', provider: 'p', model: 'm', input: ['text'], configured: true }],
    };

    expect(
      buildCompanyModelCatalogFromBridge(catalog, { sessionId: 'session-1', runEpoch: 4 }),
    ).toEqual([
      {
        id: 'p/m',
        provider: 'p',
        model: 'm',
        thinking: [],
        acceptsImages: false,
        credentialsConfigured: true,
      },
    ]);

    // A restart mints a new epoch, so the previous run's answer must not be
    // allowed to authorize a model choice for the new one.
    expect(() =>
      buildCompanyModelCatalogFromBridge(catalog, { sessionId: 'session-1', runEpoch: 5 }),
    ).toThrowError(expect.objectContaining({ code: 'stale_company_run_epoch' }));
    expect(() =>
      buildCompanyModelCatalogFromBridge(catalog, { sessionId: 'session-2', runEpoch: 4 }),
    ).toThrowError(expect.objectContaining({ code: 'stale_company_run_epoch' }));
  });
});

/**
 * modelCatalog: what the runtime actually offers, and what that permits.
 *
 * The one rule this module exists to enforce: an image is delivered only to a
 * model whose own input modalities include `image`. That predicate is OMP's
 * (`model.input.includes('image')` in `provider-image-budget.ts` and
 * `session-maintenance.ts`), read here from the runtime's model list rather
 * than guessed from a model name.
 *
 * Where the rows come from: only a live OMP process can answer this. The bridge
 * extension reads `ctx.models.list()` — the runtime's own credential-filtered
 * set — and delivers it over the authenticated channel as an
 * {@link OmpModelCatalog} envelope; this module turns that envelope into wire
 * entries. There is no host-side catalog and no CLI fallback, so a session
 * with no live runtime reports unavailable instead of a guessed model list.
 *
 * The gate matters because OMP ships `images.describeForTextModels`, default
 * ON: attaching an image to a text-only model silently stores it under
 * `local://` and injects a vision model's description instead. For a company
 * run that is a lie about what the worker saw, so a non-vision model is refused
 * at the call site and the attachment never reaches `sendUserMessage`.
 */

import type { CompanyModelCatalogEntry } from '../../../core/src/company.js';
import { CompanyError } from './companyError.js';

/** The subset of an OMP model descriptor this module needs. */
export interface OmpModelDescriptor {
  id: string;
  provider: string;
  model: string;
  /** Modalities the model accepts; `image` is the multimodal signal. */
  input: readonly string[];
  /** Thinking levels the model accepts, when the runtime reports them. */
  thinkingLevels?: readonly string[];
  /** Whether a usable credential exists, reported without exposing it. */
  configured?: boolean;
}

/**
 * One catalog read, bound to the run that produced it.
 *
 * The envelope is what makes a catalog checkable: `models` is only the set the
 * runtime offered to the session and epoch named here, so a catalog kept past
 * a restart can be recognized as stale instead of silently answering for a run
 * that no longer exists.
 */
export interface OmpModelCatalog {
  readonly sessionId: string;
  readonly runEpoch: number;
  readonly models: readonly OmpModelDescriptor[];
}

export function buildCompanyModelCatalog(
  models: readonly OmpModelDescriptor[],
): CompanyModelCatalogEntry[] {
  return models.map((model) => ({
    id: model.id,
    provider: model.provider,
    model: model.model,
    // Never invented: a model with no reported levels offers none, so the UI
    // cannot offer a setting the runtime would reject.
    thinking: [...(model.thinkingLevels ?? [])],
    acceptsImages: model.input.includes('image'),
    credentialsConfigured: model.configured === true,
  }));
}

/**
 * Project a catalog read from the native runtime for the run about to use it.
 *
 * A restart mints a new epoch, so a catalog cached from the previous run
 * describes a session whose credential set may since have changed. Refusing a
 * mismatched envelope keeps that answer from authorizing a model choice; the
 * caller re-reads the catalog from the live session instead.
 */
export function buildCompanyModelCatalogFromBridge(
  catalog: OmpModelCatalog,
  run: { readonly sessionId: string; readonly runEpoch: number },
): CompanyModelCatalogEntry[] {
  if (catalog.sessionId !== run.sessionId || catalog.runEpoch !== run.runEpoch) {
    throw new CompanyError(
      'stale_company_run_epoch',
      'The model catalog belongs to a different company run; read it again from the live session.',
    );
  }
  return buildCompanyModelCatalog(catalog.models);
}

function requireEntry(
  catalog: readonly CompanyModelCatalogEntry[],
  modelId: string,
): CompanyModelCatalogEntry {
  const entry = catalog.find((candidate) => candidate.id === modelId);
  if (!entry) {
    throw new CompanyError('unknown_model', `Model is not in the runtime catalog: ${modelId}`);
  }
  return entry;
}

/**
 * Refuse an image the selected model cannot take, BEFORE it is sent. Callers
 * surface this as an explicit unsupported state rather than dropping the image
 * or letting OMP describe it behind the user's back.
 */
export function assertImageDeliverable(
  catalog: readonly CompanyModelCatalogEntry[],
  modelId: string,
): void {
  const entry = requireEntry(catalog, modelId);
  if (!entry.acceptsImages) {
    throw new CompanyError(
      'image_not_supported_by_model',
      `${modelId} does not accept image input; the attachment was not delivered.`,
    );
  }
}

/**
 * Resolve the model a role will run on. A model without credentials is an
 * error the user has to resolve, not something to silently substitute.
 */
export function selectRoleModel(
  catalog: readonly CompanyModelCatalogEntry[],
  modelId: string,
): CompanyModelCatalogEntry {
  const entry = requireEntry(catalog, modelId);
  if (!entry.credentialsConfigured) {
    throw new CompanyError(
      'model_credentials_missing',
      `${modelId} has no usable credential; choose another model or configure one.`,
    );
  }
  return entry;
}

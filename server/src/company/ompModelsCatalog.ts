/**
 * ompModelsCatalog: the model catalog, read from the installed OMP without a run.
 *
 * `omp models --json` prints the chat models the CLI can actually use. Its list
 * is `ModelRegistry.getAvailable`, which keeps only providers with a usable key
 * or login, so every row is a model this machine can run and each row is
 * reported as configured. The read starts no session and spends no model turn,
 * which lets the board list models before any Director exists.
 *
 * It is the first catalog source. A live run answers the same question from
 * inside its own process (see `modelCatalog.ts`), and that answer is the fallback
 * when this read fails.
 *
 * A read that fails in any way is a `model_catalog_unavailable` refusal, never a
 * partial list: a catalog missing rows would read as the complete set of models.
 */

import { CompanyError } from './companyError.js';
import { COMPANY_MODEL_CATALOG_TIMEOUT_MS } from './constants.js';
import type { OmpModelDescriptor } from './modelCatalog.js';
import type { OmpRunnerCommand } from './ompRunner.js';
import { defaultQuotaRunner, type QuotaRunner, type QuotaRunnerResult } from './quotaService.js';

/** The literal argv appended to the resolved OMP command. */
export const OMP_MODELS_ARGV: readonly string[] = ['models', '--json'];

export interface OmpModelsReadOptions {
  /** The resolved native OMP command, never a shell wrapper. */
  readonly command: OmpRunnerCommand;
  /** Working directory for the read; the workspace, never a temp guess. */
  readonly cwd: string;
  /** Per-read deadline. Defaults to {@link COMPANY_MODEL_CATALOG_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
  /** Injectable process boundary, so tests never spawn OMP. */
  readonly runner?: QuotaRunner;
}

function unavailable(reason: string): CompanyError {
  return new CompanyError(
    'model_catalog_unavailable',
    `The model catalog could not be read: ${reason}.`,
  );
}

function malformedRow(): CompanyError {
  return unavailable('the installed OMP listed a model this build cannot read');
}

/** The value as a list of strings, or undefined when it is not one. */
function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value as unknown[];
  if (!items.every((item): item is string => typeof item === 'string')) return undefined;
  return items;
}

function parseRow(row: unknown): OmpModelDescriptor {
  if (typeof row !== 'object' || row === null) throw malformedRow();
  const fields = row as Record<string, unknown>;
  const provider = fields['provider'];
  const id = fields['id'];
  const selector = fields['selector'];
  const modes = stringList(fields['input']);
  if (
    typeof provider !== 'string' ||
    typeof id !== 'string' ||
    typeof selector !== 'string' ||
    modes === undefined
  ) {
    throw malformedRow();
  }
  // `thinking` is null for a model that does not reason; anything else must be a
  // list of levels, or the row is refused rather than guessed.
  const thinking = fields['thinking'];
  const levels = thinking === null ? [] : stringList(thinking);
  if (levels === undefined) throw malformedRow();
  return {
    id: selector,
    provider,
    model: id,
    input: modes,
    thinkingLevels: levels,
    configured: true,
  };
}

/**
 * Parse the `--json` payload of `omp models`. A payload without a model list, or
 * any row outside the expected shape, fails the whole read.
 */
export function parseOmpModelsPayload(stdout: string): OmpModelDescriptor[] {
  let payload: unknown;
  try {
    payload = JSON.parse(stdout) as unknown;
  } catch {
    throw unavailable('the installed OMP printed no JSON model list');
  }
  const envelope: Record<string, unknown> =
    typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {};
  const models = envelope['models'];
  if (!Array.isArray(models)) throw unavailable('the installed OMP printed no JSON model list');
  return (models as unknown[]).map(parseRow);
}

/**
 * Read the catalog through the installed OMP. Resolves with every model it lists
 * (empty when no provider has a credential) and rejects with
 * `model_catalog_unavailable` for anything else.
 */
export async function readOmpModelsCatalog(
  options: OmpModelsReadOptions,
): Promise<OmpModelDescriptor[]> {
  if (options.command.file.trim() === '') {
    throw unavailable('the OMP command has no executable to list models with');
  }
  let result: QuotaRunnerResult;
  try {
    result = await (options.runner ?? defaultQuotaRunner)({
      executable: options.command.file,
      argv: [...options.command.args, ...OMP_MODELS_ARGV],
      cwd: options.cwd,
      timeoutMs: options.timeoutMs ?? COMPANY_MODEL_CATALOG_TIMEOUT_MS,
    });
  } catch {
    throw unavailable('the installed OMP could not be asked for its models');
  }
  if (result.timedOut) throw unavailable('the installed OMP did not list its models in time');
  if (result.exitCode === null) throw unavailable('the installed OMP could not be started');
  if (result.exitCode !== 0) {
    throw unavailable('the installed OMP exited without listing its models');
  }
  return parseOmpModelsPayload(result.stdout);
}

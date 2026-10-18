/**
 * hostModelRoles: which models Company runs on, read from the host OMP.
 *
 * The question this module answers is the user's: "use whatever the OMP on this
 * machine is set to". OMP keeps that answer in its `modelRoles` config — a
 * record of role -> `provider/model[:effort]` selector, e.g.
 * `plan: openai-codex/gpt-6.1-sol:max`, `default: openai-codex/gpt-6-luna:xhigh`
 * — and each Company role reads the host role that matches its job
 * ({@link COMPANY_HOST_ROLE_BY_ROLE}):
 *
 *  - `plan` -> **Director**, so the role that plans reasons exactly the way
 *    `/plan` reasons in the host session.
 *  - `advisor` -> **Advisor**, the host's own read-only reviewer model.
 *  - `task` -> **Worker**, the model the host hands delegated work to.
 *  - `default` -> **QA** and **Judge**. The host's `judge` role is a one-shot
 *    classifier, not an agent; borrowing it for the verifier would change what
 *    verification means.
 *
 * A role the host has not set borrows `default`, and `hostRole` on the
 * assignment says which host role actually answered. Separate roles mean
 * separate prompt prefixes and fewer cache hits across roles; that is the
 * user's chosen trade for running each role on the model they assigned it.
 * Other host roles (`smol`, `slow`, `judge`, ...) are reported as ignored rather
 * than silently mapped.
 *
 * Where the read comes from, and what it is NOT:
 *
 *  - **Live: `omp config get modelRoles --json`**, run once through the resolved
 *    native OMP command. This is OMP's own reader, so it sees the same config
 *    layering (user file, XDG) the CLI resolves for itself, and it needs no
 *    permission to read a settings file the user never agreed to hand over.
 *  - **Not the catalog.** `modelCatalog.ts` carries what the runtime *offers*;
 *    it deliberately projects five facts per model and drops everything else, so
 *    it cannot say which selector a *role* points at. The two are complementary
 *    and are used for different jobs: this module chooses, the catalog
 *    authorizes (an id resolved here that the live catalog does not list is
 *    refused later, by `selectRoleModel`).
 *  - **Not the extension context.** The bridge's `ctx` exposes `models.list()`
 *    and `modelRegistry.hasConfiguredAuth` and no configuration read at all, so
 *    role -> model mapping is not reachable from inside a Company run.
 *  - **Not environment overrides.** OMP also resolves `PI_PLAN_MODEL` /
 *    `PI_SLOW_MODEL` at runtime, and the `config get` read does not see them:
 *    with `PI_PLAN_MODEL` pointed at another selector, the read still reports
 *    the configured one. A session OMP runs under an override is therefore not
 *    reflected here. Company-launched runs inherit that environment, so the run
 *    itself still gets the override OMP would apply to it.
 *
 * When the host exposes nothing usable — OMP not installed, a CLI without
 * `config`, a timeout, unparseable output — the resolution falls back to
 * {@link COMPANY_DEFAULT_MODELS} / {@link COMPANY_FALLBACK_ROLE_THINKING}
 * and says so in `source`. A fallback is never silent and never partially
 * invented: each slot falls back on its own, and `source` reports whether the
 * board is fully host-resolved, mixed, or entirely fallback.
 *
 * **Model ids stay bare.** A resolved selector is split into `model` and
 * `thinking`, because OMP lists the catalog by bare `provider/model` and reports
 * the effort separately: `requestedModel` is matched against the catalog by id,
 * so baking `:max` into the id would make every lookup miss, and `ompRunner`
 * passes the two as separate `--model` / `--thinking` flags.
 */

import {
  COMPANY_HOST_DEFAULT_ROLE,
  COMPANY_HOST_ROLE_BY_ROLE,
  type CompanyRole,
} from '../../../core/src/company.js';
import {
  COMPANY_DEFAULT_MODELS,
  COMPANY_FALLBACK_ROLE_THINKING,
  COMPANY_MODEL_ROLES_TIMEOUT_MS,
} from './constants.js';
import type { OmpRunnerCommand } from './ompRunner.js';
import { defaultQuotaRunner, type QuotaRunner, type QuotaRunnerResult } from './quotaService.js';

/**
 * The literal argv for the read, quoted here so a caller cannot smuggle shell
 * syntax into it. `--json` is requested, but a bare record is also accepted so a
 * CLI that drops the flag still resolves rather than silently falling back.
 */
export const OMP_MODEL_ROLES_ARGV: readonly string[] = ['config', 'get', 'modelRoles', '--json'];

/** Company roles, in the order the board is presented. */
export const COMPANY_ROLES: readonly CompanyRole[] = [
  'director',
  'advisor',
  'worker',
  'qa',
  'judge',
  'chat',
];

/**
 * One host role, as Company uses it: the bare selector and the effort the host
 * paired with it.
 *
 * `thinking` is null when the host's selector carries no `:effort` suffix. That
 * is not an error and is not filled with a guess: the caller decides, and a
 * fallback effort is applied only where one already existed as a fallback.
 */
export interface HostRoleSelector {
  readonly model: string;
  readonly thinking: string | null;
}

/** What one Company role will run on, and where that answer came from. */
export interface CompanyRoleModelAssignment {
  readonly role: CompanyRole;
  /** Bare `provider/model` id — never carries an `:effort` suffix. */
  readonly model: string;
  /** Effort, kept out of `model` because the catalog reports it separately. */
  readonly thinking: string;
  /**
   * The host role this was taken from -- the role's own, or `default` when the
   * host has not set it. Null when it came from the fallback.
   */
  readonly hostRole: string | null;
  /** False when `thinking` fell back because the host selector had no effort. */
  readonly thinkingFromHost: boolean;
}
export interface CompanyModelResolution {
  readonly assignments: Readonly<Record<CompanyRole, CompanyRoleModelAssignment>>;
  /**
   * `host` when every role resolved from the host, `mixed` when only some did,
   * and `fallback` when none did. There is no fourth state: a role is either
   * read from the host or taken from the documented fallback.
   */
  readonly source: 'host' | 'mixed' | 'fallback';
  /** Host roles Company deliberately does not map, sorted for stable display. */
  readonly ignoredHostRoles: readonly string[];
  /** Why the fallback is in play; null when the host answered for every role. */
  readonly diagnostic: string | null;
}

/**
 * Runs one OMP command. This is the quota read's process boundary, reused so
 * that a second `execFile` policy (shell-free argv, kill on timeout) cannot
 * drift from the first.
 */
export type HostModelRolesRunner = QuotaRunner;

/** One OMP command's outcome, as the process boundary reports it. */
export type HostModelRolesRunnerResult = QuotaRunnerResult;

export interface HostModelRolesReadOptions {
  /** The resolved native OMP command, never a shell wrapper. */
  readonly command: OmpRunnerCommand;
  /** Working directory for the read; the workspace, never a temp guess. */
  readonly cwd: string;
  /** Per-read deadline. Defaults to {@link COMPANY_MODEL_ROLES_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
  /** Injectable process boundary, so tests never spawn OMP. */
  readonly runner?: HostModelRolesRunner;
}

/**
 * Split one host selector into its bare id and its effort.
 *
 * The suffix is treated as an effort only when what precedes the last colon
 * looks like a selector (it carries a `/`) and the suffix cannot itself be part
 * of an id (no `/`, no whitespace). Anything else is kept whole as the id, so a
 * selector this parser cannot understand is still passed on verbatim instead of
 * being truncated into a model that does not exist.
 */
function splitRoleSelector(value: string): HostRoleSelector | null {
  const selector = value.trim();
  if (selector === '' || /\s/.test(selector)) return null;

  const colon = selector.lastIndexOf(':');
  if (colon > 0 && selector.indexOf('/') < colon) {
    const base = selector.slice(0, colon);
    const effort = selector.slice(colon + 1);
    if (base !== '' && effort !== '' && !effort.includes('/')) {
      return { model: base, thinking: effort };
    }
  }
  return { model: selector, thinking: null };
}

/**
 * Parse whatever `omp config get modelRoles` printed, in either shape it ships:
 * the `--json` envelope (`{ key, value, type }`) and the bare record printed
 * without the flag.
 *
 * A value that is not a usable selector string is skipped rather than coerced,
 * and an unreadable payload yields an empty record — the caller's cue to use the
 * documented fallback. Nothing here throws: a parse failure is a fallback, not
 * an error the user has to clear.
 */
export function parseHostModelRolesPayload(stdout: string): Record<string, HostRoleSelector> {
  let payload: unknown;
  try {
    payload = JSON.parse(stdout) as unknown;
  } catch {
    return {};
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return {};

  const envelope = payload as Record<string, unknown>;
  const roles =
    typeof envelope['value'] === 'object' && envelope['value'] !== null
      ? (envelope['value'] as Record<string, unknown>)
      : envelope;

  const parsed: Record<string, HostRoleSelector> = {};
  for (const [name, value] of Object.entries(roles)) {
    if (name === 'key' || name === 'type' || name === 'description') continue;
    if (typeof value !== 'string') continue;
    const selector = splitRoleSelector(value);
    if (selector !== null) parsed[name] = selector;
  }
  return parsed;
}

/**
 * Resolve the board's models from a host role record.
 *
 * Pure: pass `null`, `{}`, or a record and the same shape comes back with its
 * provenance intact, which is what lets `createRoleProfiles` stay synchronous
 * while the read itself happens once, before a run starts.
 */
export function resolveCompanyModelRoles(
  roles: Readonly<Record<string, HostRoleSelector>> | null | undefined,
): CompanyModelResolution {
  const host = roles ?? {};
  const shared = host[COMPANY_HOST_DEFAULT_ROLE];

  const assignments = {} as Record<CompanyRole, CompanyRoleModelAssignment>;
  for (const role of COMPANY_ROLES) {
    const ownRole = COMPANY_HOST_ROLE_BY_ROLE[role];
    const own = host[ownRole];
    const selector = own ?? shared;
    assignments[role] = {
      role,
      model: selector?.model ?? COMPANY_DEFAULT_MODELS[role],
      thinking: selector?.thinking ?? COMPANY_FALLBACK_ROLE_THINKING[role],
      hostRole: own ? ownRole : shared ? COMPANY_HOST_DEFAULT_ROLE : null,
      thinkingFromHost: selector !== undefined && selector.thinking !== null,
    };
  }

  const fromHost = COMPANY_ROLES.filter((role) => assignments[role].hostRole !== null).length;
  const source: CompanyModelResolution['source'] =
    fromHost === 0 ? 'fallback' : fromHost === COMPANY_ROLES.length ? 'host' : 'mixed';

  const mapped = new Set(Object.values(COMPANY_HOST_ROLE_BY_ROLE));
  const ignoredHostRoles = Object.keys(host)
    .filter((name) => !mapped.has(name))
    .sort();

  return {
    assignments,
    source,
    ignoredHostRoles,
    diagnostic:
      source === 'fallback'
        ? 'the host OMP exposed no usable model roles; Company is running on its documented fallback models'
        : source === 'mixed'
          ? 'the host OMP resolved only some of the roles Company reads; the rest use the documented fallback'
          : null,
  };
}

/**
 * Read the host's model roles and resolve the board from them.
 *
 * Never throws and never hangs: a missing OMP, a rejected command, a timeout or
 * a payload this module cannot read all end as the documented fallback with a
 * `diagnostic` saying so. One read answers the whole board, so callers read once
 * before a run and pass the resolution on rather than reading per role.
 */
export async function readCompanyModelRoles(
  options: HostModelRolesReadOptions,
): Promise<CompanyModelResolution> {
  const fallback = (diagnostic: string): CompanyModelResolution => ({
    ...resolveCompanyModelRoles(null),
    diagnostic,
  });

  if (options.command.file.trim() === '') {
    return fallback('the OMP command has no executable to read model roles with');
  }

  let result: HostModelRolesRunnerResult;
  try {
    result = await (options.runner ?? defaultQuotaRunner)({
      executable: options.command.file,
      argv: [...options.command.args, ...OMP_MODEL_ROLES_ARGV],
      cwd: options.cwd,
      timeoutMs: options.timeoutMs ?? COMPANY_MODEL_ROLES_TIMEOUT_MS,
    });
  } catch {
    return fallback('the host OMP could not be asked for its model roles');
  }

  const roles = parseHostModelRolesPayload(result.stdout);
  const resolution = resolveCompanyModelRoles(roles);
  // Roles the host did print are used even when it also complained: what OMP
  // answered is still its answer, and the exit status only decides the
  // explanation when there is nothing usable in it.
  if (resolution.source !== 'fallback') return resolution;

  if (result.timedOut) {
    return fallback('the host OMP did not report its model roles in time');
  }
  if (result.exitCode === null) {
    return fallback('the OMP command could not be started to read the host model roles');
  }
  if (result.exitCode !== 0) {
    return fallback('the host OMP has no readable modelRoles configuration');
  }
  return {
    ...resolution,
    diagnostic: 'the host OMP reported no usable plan/advisor/task/default model roles',
  };
}

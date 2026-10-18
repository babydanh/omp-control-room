/**
 * CompanyState: the durable domain reducer.
 *
 * `CompanyState` is a pure value derived from `CompanyState.initial` plus the
 * ordered `CompanyEvent` journal. Nothing here touches the filesystem: the
 * store owns durability, the coordinator owns orchestration, and this module
 * owns only the transition rules, so replay after a crash reproduces exactly
 * the state the owner had committed.
 *
 * Invariants enforced here (they are the ones a broken journal or a racing
 * writer would otherwise silently violate):
 *  - `revision` always equals the sequence number of the last applied event.
 *  - An event is applied only when `baseRevision` matches the current
 *    revision, so two writers cannot interleave changes into one state.
 *  - Counters are committed by the same event that creates the object they
 *    name, so a crash can never re-issue a display code.
 */

import type {
  CompanyChange,
  CompanyEvent,
  CompanyRole,
  CompanySettings,
  CompanyState,
  RoleProfile,
} from '../../../core/src/company.js';
import { CompanyError } from './companyError.js';
import {
  COMPANY_IDLE_PARK_SECONDS,
  COMPANY_MAX_LIVE_RUNNERS,
  COMPANY_MAX_MODEL_CALLS,
  COMPANY_MAX_RETAINED_SESSIONS,
  COMPANY_MAX_WORKERS,
  COMPANY_SCHEMA_VERSION,
} from './constants.js';
import {
  COMPANY_ROLES,
  type CompanyModelResolution,
  resolveCompanyModelRoles,
} from './hostModelRoles.js';

/** Tools policy per role. Only Workers may write, and only inside a scope. */
const ROLE_TOOLS_POLICY: Record<CompanyRole, RoleProfile['toolsPolicy']> = {
  director: 'read-only',
  advisor: 'read-only',
  worker: 'scoped-write',
  qa: 'verification-only',
  judge: 'read-only',
  chat: 'omp',
};

/**
 * The board's models when no host answered for them.
 *
 * Resolved through the same code path a live host read takes, with an empty host
 * record, so the offline board and a host that answered only one slot produce
 * their values from ONE transcription (`COMPANY_DEFAULT_MODELS` and
 * `COMPANY_FALLBACK_ROLE_THINKING`, both documented fallbacks) instead of a
 * second copy that could drift from it.
 *
 * Every creator below defaults to this, which is what keeps a unit test, an
 * offline workspace and a machine whose OMP cannot be reached on exactly the
 * models they ran on before the host was ever consulted.
 */
const FALLBACK_MODEL_ROLES: CompanyModelResolution = resolveCompanyModelRoles(null);

/**
 * One profile per Company role, each running on what the resolution assigned it.
 *
 * `requestedModel` stays a BARE `provider/model` id: the catalog matches on the
 * id and takes the effort from `thinking`, so an `:effort` suffix here would make
 * every catalog lookup miss. Both halves come from the resolution, which is read
 * ONCE before a run starts (see `workspaceCompanyHost.ts`) and never per role or
 * per turn.
 */
export function createRoleProfiles(
  modelRoles: CompanyModelResolution = FALLBACK_MODEL_ROLES,
): Record<string, RoleProfile> {
  const profiles: Record<string, RoleProfile> = {};
  for (const role of COMPANY_ROLES) {
    const assignment = modelRoles.assignments[role];
    profiles[role] = {
      role,
      requestedModel: assignment.model,
      thinking: assignment.thinking,
      // Company profiles never inherit global OMP workflows silently: an
      // empty fingerprint means "no company workflow loaded", which the
      // coordinator surfaces instead of assuming the user's global setup.
      workflowFingerprint: '',
      toolsPolicy: ROLE_TOOLS_POLICY[role],
    };
  }
  return profiles;
}

export function createInitialCompanySettings(
  workspacePath: string,
  modelRoles: CompanyModelResolution = FALLBACK_MODEL_ROLES,
): CompanySettings {
  return {
    workspacePath,
    maxRetainedSessions: COMPANY_MAX_RETAINED_SESSIONS,
    maxLiveRunners: COMPANY_MAX_LIVE_RUNNERS,
    maxConcurrentModelCalls: COMPANY_MAX_MODEL_CALLS,
    maxWorkers: COMPANY_MAX_WORKERS,
    idleParkSeconds: COMPANY_IDLE_PARK_SECONDS,
    roleProfiles: createRoleProfiles(modelRoles),
    verificationProfiles: {},
  };
}

/**
 * Give a stored settings record the profiles it predates. A board saved before
 * the chat role existed has no `chat` profile; it gets the one a fresh board
 * would have, and every profile already stored is left exactly as it was.
 */
export function withMissingRoleProfiles(
  state: CompanyState,
  modelRoles: CompanyModelResolution = FALLBACK_MODEL_ROLES,
): CompanyState {
  const missing = COMPANY_ROLES.filter((role) => state.settings.roleProfiles[role] === undefined);
  if (missing.length === 0) return state;
  const fresh = createRoleProfiles(modelRoles);
  const roleProfiles: Record<string, RoleProfile> = { ...state.settings.roleProfiles };
  for (const role of missing) {
    const profile = fresh[role];
    if (profile) roleProfiles[role] = profile;
  }
  return { ...state, settings: { ...state.settings, roleProfiles } };
}

export function createInitialCompanyState(
  workspacePath: string,
  modelRoles: CompanyModelResolution = FALLBACK_MODEL_ROLES,
): CompanyState {
  return {
    schemaVersion: COMPANY_SCHEMA_VERSION,
    revision: 0,
    counters: { session: 0, task: 0, contract: 0 },
    settings: createInitialCompanySettings(workspacePath, modelRoles),
    prompts: {},
    contracts: {},
    tasks: {},
    sessions: {},
    questions: {},
    attempts: {},
    reports: {},
    evidence: {},
    usageIndex: {},
    quotas: {},
  };
}

/**
 * Apply one committed event. Returns a new state; the input is never mutated,
 * so a rejected event cannot leave a half-applied state behind.
 */
export function applyCompanyEvent(state: CompanyState, event: CompanyEvent): CompanyState {
  if (event.baseRevision !== state.revision) {
    throw new CompanyError(
      'company_revision_conflict',
      `Event base revision ${event.baseRevision} does not match current revision ${state.revision}.`,
    );
  }
  if (event.sequence !== state.revision + 1) {
    throw new CompanyError(
      'company_sequence_conflict',
      `Event sequence ${event.sequence} does not follow revision ${state.revision}.`,
    );
  }

  const next: CompanyState = {
    ...state,
    settings: state.settings,
    counters: state.counters,
    prompts: { ...state.prompts },
    contracts: { ...state.contracts },
    tasks: { ...state.tasks },
    sessions: { ...state.sessions },
    questions: { ...state.questions },
    attempts: { ...state.attempts },
    reports: { ...state.reports },
    evidence: { ...state.evidence },
    usageIndex: { ...state.usageIndex },
    quotas: { ...state.quotas },
    revision: event.sequence,
  };

  for (const change of event.changes) {
    applyChange(next, change);
  }
  return next;
}

function applyChange(state: CompanyState, change: CompanyChange): void {
  if (change.op === 'remove') {
    switch (change.entity) {
      case 'prompt':
        delete state.prompts[change.id];
        break;
      case 'contract':
        delete state.contracts[change.id];
        break;
      case 'task':
        delete state.tasks[change.id];
        break;
      case 'session':
        delete state.sessions[change.id];
        break;
      case 'question':
        delete state.questions[change.id];
        break;
      case 'attempt':
        delete state.attempts[change.id];
        break;
      case 'report':
        delete state.reports[change.id];
        break;
      case 'evidence':
        delete state.evidence[change.id];
        break;
      case 'usage':
        delete state.usageIndex[change.id];
        break;
      case 'quota':
        delete state.quotas[change.id];
        break;
      default: {
        const unhandled: never = change;
        throw new CompanyError(
          'company_invalid_change',
          `Remove change for non-removable entity: ${JSON.stringify(unhandled)}`,
        );
      }
    }
    return;
  }

  switch (change.entity) {
    case 'prompt':
      state.prompts[change.id] = change.value;
      return;
    case 'contract':
      state.contracts[change.id] = change.value;
      return;
    case 'task':
      state.tasks[change.id] = change.value;
      return;
    case 'session':
      state.sessions[change.id] = change.value;
      return;
    case 'question':
      state.questions[change.id] = change.value;
      return;
    case 'attempt':
      state.attempts[change.id] = change.value;
      return;
    case 'report':
      state.reports[change.id] = change.value;
      return;
    case 'evidence':
      state.evidence[change.id] = change.value;
      return;
    case 'settings':
      state.settings = change.value;
      return;
    case 'usage': {
      // One usage index bucket per company session; entries are appended in
      // event order and deduped downstream by (nativeSessionId, nativeEntryId).
      const bucket = state.usageIndex[change.id];
      state.usageIndex[change.id] = bucket ? [...bucket, change.value] : [change.value];
      return;
    }
    case 'quota':
      state.quotas[change.id] = change.value;
      return;
    case 'counters':
      state.counters = change.value;
      return;
    default: {
      const unhandled: never = change;
      throw new CompanyError(
        'company_invalid_change',
        `Unknown change: ${JSON.stringify(unhandled)}`,
      );
    }
  }
}

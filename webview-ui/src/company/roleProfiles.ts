/**
 * roleProfiles: which model each company role runs on.
 *
 * The server owns the profiles; this only edits the copy the user is changing
 * and sends it back. A profile change applies at the NEXT dispatch (or on an
 * idle session) -- never mid-tool -- so the drawer keeps showing the model's
 * EFFECTIVE value beside the requested one instead of pretending the swap
 * already happened.
 */

import type { CompanyRole, RoleProfile } from '../../../core/src/company.js';
import type { CompanyViewState } from './companyState.js';

export const COMPANY_ROLES: readonly CompanyRole[] = [
  // Chat sessions are plain omp sessions; they sit above the Company roles in the sidebar.
  'chat',
  'director',
  'advisor',
  'worker',
  'qa',
  'judge',
];

export const ROLE_LABELS: Record<CompanyRole, string> = {
  chat: 'Phiên chat',
  director: 'Giám đốc',
  advisor: 'Cố vấn',
  worker: 'Nhân viên',
  qa: 'QA',
  judge: 'Trọng tài',
};

/** A role as the board shows it; an unknown role is shown as sent. */
export function companyRoleLabel(role: string): string {
  return ROLE_LABELS[role as CompanyRole] ?? role;
}

/**
 * The role's mark on a card or a rail strip: a company-edge class plus one
 * company-edge-* colour class from index.css. It draws a bar on the leading edge.
 */
export const ROLE_EDGE_CLASS: Record<CompanyRole, string> = {
  chat: 'company-edge company-edge-chat',
  director: 'company-edge company-edge-director',
  advisor: 'company-edge company-edge-advisor',
  worker: 'company-edge company-edge-worker',
  qa: 'company-edge company-edge-qa',
  judge: 'company-edge company-edge-judge',
};

/** The profile the server has for a role, if it declared one. */
export function roleProfile(state: CompanyViewState, role: CompanyRole): RoleProfile | null {
  return state.settings?.roleProfiles[role] ?? null;
}

/**
 * The profile map with one role pointed at a new model, and optionally a new
 * thinking level. Unknown roles keep the profile they already had rather than
 * being rebuilt from defaults the client does not know.
 */
export function withRoleModel(
  profiles: Record<string, RoleProfile>,
  role: CompanyRole,
  modelId: string,
  thinking?: string,
): Record<string, RoleProfile> {
  const existing = profiles[role];
  if (!existing) return profiles;
  return {
    ...profiles,
    [role]: {
      ...existing,
      requestedModel: modelId,
      ...(thinking === undefined ? {} : { thinking }),
    },
  };
}

/**
 * The thinking level to save with a model: the wanted one when the model
 * accepts it, else the model's highest. Undefined when the model declares no
 * level -- the server saves only a level the model declares, so keeping the
 * old one would be refused.
 */
export function thinkingForModel(
  levels: readonly string[],
  wanted: string | undefined,
): string | undefined {
  if (wanted !== undefined && levels.includes(wanted)) return wanted;
  return levels.at(-1);
}

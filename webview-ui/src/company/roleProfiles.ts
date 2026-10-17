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
  'director',
  'advisor',
  'worker',
  'qa',
  'judge',
];

export const ROLE_LABELS: Record<CompanyRole, string> = {
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

/** Left-edge colour that marks a role on a card and in the role strip. */
export const ROLE_EDGE_CLASS: Record<CompanyRole, string> = {
  director: 'border-l-accent-bright',
  advisor: 'border-l-status-permission',
  worker: 'border-l-status-active',
  qa: 'border-l-status-success',
  judge: 'border-l-warning',
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

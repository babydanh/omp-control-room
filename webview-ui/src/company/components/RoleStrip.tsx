/**
 * RoleStrip: which model each Company role runs on, as the server declared it.
 *
 * A role the server sent no profile for says so instead of borrowing a
 * neighbour's model; the composer is where a role's model is changed.
 */

import type { RoleProfile } from '../../../../core/src/company.js';
import { COMPANY_ROLES, ROLE_EDGE_CLASS, ROLE_LABELS } from '../roleProfiles.js';

export interface RoleStripProps {
  profiles: Readonly<Record<string, RoleProfile>>;
}

export function RoleStrip({ profiles }: RoleStripProps) {
  return (
    <ul
      className="flex flex-wrap gap-2 border-b-2 border-border px-3 py-2 text-2xs"
      data-testid="role-strip"
    >
      {COMPANY_ROLES.map((role) => {
        const profile = profiles[role];
        return (
          <li
            key={role}
            className={`border-2 border-l-4 border-border bg-bg-dark px-2 py-1 ${ROLE_EDGE_CLASS[role]}`}
          >
            <span className="text-text">{ROLE_LABELS[role]}</span>
            <span className="text-text-muted">
              {profile
                ? ` · ${profile.requestedModel}${profile.thinking ? ` · ${profile.thinking}` : ''}`
                : ' · chưa có hồ sơ'}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

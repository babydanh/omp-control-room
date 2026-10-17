/**
 * RoleStrip: which model each Company role runs on, and where to change it.
 *
 * Clicking a role opens OMP's model switcher for that role: search the live
 * catalog, pick a model, pick a thinking level the model declares. The change
 * goes to the server, which validates it against the same catalog and applies
 * it at the role's next turn -- never mid-tool. A role the server sent no
 * profile for says so instead of borrowing a neighbour's model.
 */

import { useMemo, useState } from 'react';

import type {
  CompanyModelCatalogEntry,
  CompanyRole,
  RoleProfile,
} from '../../../../core/src/company.js';
import { COMPANY_ROLES, ROLE_EDGE_CLASS, ROLE_LABELS } from '../roleProfiles.js';

/** Rows shown at once; the search narrows a 700-model catalog to these. */
const PICKER_ROWS = 40;

export interface RoleStripProps {
  profiles: Readonly<Record<string, RoleProfile>>;
  catalog: readonly CompanyModelCatalogEntry[];
  onChange: (role: CompanyRole, modelId: string, thinking: string | undefined) => void;
}

function ModelPicker({
  profile,
  catalog,
  onPick,
}: {
  profile: RoleProfile;
  catalog: readonly CompanyModelCatalogEntry[];
  onPick: (modelId: string, thinking: string | undefined) => void;
}) {
  const [query, setQuery] = useState('');
  const [modelId, setModelId] = useState(profile.requestedModel);
  const [thinking, setThinking] = useState(profile.thinking);

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return catalog
      .filter((entry) => entry.credentialsConfigured)
      .filter((entry) => needle === '' || entry.id.toLowerCase().includes(needle))
      .slice(0, PICKER_ROWS);
  }, [catalog, query]);
  const chosen = catalog.find((entry) => entry.id === modelId);
  const levels = chosen?.thinking ?? [];

  return (
    <div
      className="absolute left-0 top-full z-20 mt-1 flex w-[400px] max-w-[90vw] flex-col gap-[6px] border-2 border-accent bg-bg-dark p-[8px] text-2xs"
      data-testid="model-picker"
    >
      <input
        autoFocus
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Tìm model (vd: opus, gpt, haiku)…"
        className="border-2 border-border bg-bg p-1 text-text"
      />
      <ul className="max-h-[260px] overflow-auto">
        {rows.map((entry) => (
          <li key={entry.id}>
            <button
              type="button"
              onClick={() => {
                setModelId(entry.id);
                if (!entry.thinking.includes(thinking)) setThinking(entry.thinking.at(-1) ?? '');
              }}
              className={
                entry.id === modelId
                  ? 'w-full cursor-pointer bg-active-bg px-1 text-left text-text'
                  : 'w-full cursor-pointer px-1 text-left text-text-muted hover:text-text'
              }
            >
              {entry.id}
            </button>
          </li>
        ))}
        {rows.length === 0 && <li className="text-text-muted">Không có model nào khớp.</li>}
      </ul>
      <label className="flex items-center gap-2 text-text-muted">
        Mức suy nghĩ
        <select
          value={thinking}
          onChange={(event) => setThinking(event.target.value)}
          disabled={levels.length === 0}
          className="border-2 border-border bg-bg p-1 text-text"
        >
          {levels.length === 0 && <option value={thinking}>{thinking || 'model không có'}</option>}
          {levels.map((level) => (
            <option key={level} value={level}>
              {level}
            </option>
          ))}
        </select>
      </label>
      <button
        type="button"
        onClick={() => onPick(modelId, levels.length === 0 ? undefined : thinking)}
        className="cursor-pointer border-2 border-accent px-2 py-1 text-text"
      >
        Dùng {modelId}
      </button>
    </div>
  );
}

export function RoleStrip({ profiles, catalog, onChange }: RoleStripProps) {
  const [open, setOpen] = useState<CompanyRole | null>(null);
  return (
    <ul
      className="flex flex-wrap gap-2 border-b-2 border-border px-3 py-2 text-2xs"
      data-testid="role-strip"
    >
      {COMPANY_ROLES.map((role) => {
        const profile = profiles[role];
        return (
          <li key={role} className="relative">
            <button
              type="button"
              disabled={!profile}
              onClick={() => setOpen((current) => (current === role ? null : role))}
              aria-expanded={open === role}
              title="Bấm để đổi model và mức suy nghĩ của vai này"
              className={`cursor-pointer border-2 border-l-4 border-border bg-bg-dark px-2 py-1 text-left hover:border-accent ${ROLE_EDGE_CLASS[role]}`}
            >
              <span className="text-text">{ROLE_LABELS[role]}</span>
              <span className="text-text-muted">
                {profile
                  ? ` · ${profile.requestedModel}${profile.thinking ? ` · ${profile.thinking}` : ''} ▾`
                  : ' · chưa có hồ sơ'}
              </span>
            </button>
            {open === role && profile && (
              <ModelPicker
                profile={profile}
                catalog={catalog}
                onPick={(modelId, thinking) => {
                  onChange(role, modelId, thinking);
                  setOpen(null);
                }}
              />
            )}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * ModelPicker: OMP's model switcher for one role, opened in place under that role's
 * row in the "Vai trò & model" dialog.
 *
 * Search the live catalog, pick a model, pick a thinking level the model
 * declares. The server validates the choice against the same catalog and
 * applies it at the role's next turn, never mid-tool.
 */

import { useMemo, useState } from 'react';

import type { CompanyModelCatalogEntry, RoleProfile } from '../../../../core/src/company.js';
import { CompanyButton } from './CompanyButton.js';

/** Rows shown at once; the search narrows a 700-model catalog to these. */
const PICKER_ROWS = 40;

export interface ModelPickerProps {
  profile: RoleProfile;
  catalog: readonly CompanyModelCatalogEntry[];
  onPick: (modelId: string, thinking: string | undefined) => void;
}

export function ModelPicker({ profile, catalog, onPick }: ModelPickerProps) {
  const [query, setQuery] = useState('');
  const [modelId, setModelId] = useState(profile.requestedModel);
  const [thinking, setThinking] = useState(profile.thinking);

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    // The server saves only a thinking level the model declares, so a model
    // that declares none could never be saved: "Dùng" would always fail.
    return catalog
      .filter((entry) => entry.credentialsConfigured && entry.thinking.length > 0)
      .filter((entry) => needle === '' || entry.id.toLowerCase().includes(needle))
      .slice(0, PICKER_ROWS);
  }, [catalog, query]);
  const chosen = catalog.find((entry) => entry.id === modelId);
  const levels = chosen?.thinking ?? [];

  return (
    <div
      className="flex flex-col gap-[6px] rounded-(--company-radius-md) border border-hairline bg-raised p-[8px] text-2xs"
      data-testid="model-picker"
    >
      <input
        autoFocus
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Tìm model (vd: opus, gpt, haiku)…"
        className="rounded-(--company-radius-sm) bg-bg p-1 text-text"
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
                  ? 'company-selected w-full cursor-pointer rounded-(--company-radius-sm) px-1 text-left text-text'
                  : 'w-full cursor-pointer rounded-(--company-radius-sm) px-1 text-left text-text-muted hover:bg-hover hover:text-text'
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
          className="rounded-(--company-radius-sm) bg-bg p-1 text-text"
        >
          {levels.length === 0 && <option value={thinking}>{thinking || 'model không có'}</option>}
          {levels.map((level) => (
            <option key={level} value={level}>
              {level}
            </option>
          ))}
        </select>
      </label>
      <CompanyButton
        variant="accent"
        size="sm"
        onClick={() => onPick(modelId, levels.length === 0 ? undefined : thinking)}
      >
        Dùng {modelId}
      </CompanyButton>
    </div>
  );
}

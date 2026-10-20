/**
 * SquadSettingsSection: the folder's squad settings, in a section the squad drawer keeps closed
 * until it is opened. The server owns the values: a save sends the whole set, and the form takes
 * its values again from the snapshot the server sends back.
 */

import { useState } from 'react';

import type { SquadSettings } from '../../../../core/src/messages.js';
import type { CompanyClient } from '../companyClient.js';
import {
  SQUAD_COUNT_LIMITS,
  type SquadSettingsDraft,
  squadSettingsDraftOf,
  squadSettingsFromDraft,
} from '../squadSettingsView.js';
import { useCommandDialog } from '../useCommandDialog.js';
import { CompanyButton } from './CompanyButton.js';

const SAVE_FALLBACK = 'Chưa lưu được cài đặt đội.';

const FIELD_CLASS =
  'rounded-(--company-radius-sm) bg-well px-2 py-1.5 text-xs text-text disabled:text-text-muted';

export interface SquadSettingsSectionProps {
  client: CompanyClient;
  workspacePath: string;
  /** The folder's settings as the server holds them; null until the first snapshot arrives. */
  settings: SquadSettings | null;
}

/** The squad settings, closed by default. The form re-mounts when the server's values change. */
export function SquadSettingsSection({
  client,
  workspacePath,
  settings,
}: SquadSettingsSectionProps) {
  return (
    <details className="flex flex-col gap-2 text-xs">
      <summary className="cursor-pointer text-2xs font-semibold text-text-muted">
        Cài đặt đội
      </summary>
      {settings === null ? (
        <p className="text-2xs text-text-muted">Đang tải cài đặt đội…</p>
      ) : (
        <SquadSettingsForm
          key={JSON.stringify(settings)}
          client={client}
          workspacePath={workspacePath}
          settings={settings}
        />
      )}
    </details>
  );
}

interface SquadSettingsFormProps {
  client: CompanyClient;
  workspacePath: string;
  settings: SquadSettings;
}

function SquadSettingsForm({ client, workspacePath, settings }: SquadSettingsFormProps) {
  const command = useCommandDialog(client);
  const [draft, setDraft] = useState<SquadSettingsDraft>(() => squadSettingsDraftOf(settings));
  const reading = squadSettingsFromDraft(draft);
  const parallel = SQUAD_COUNT_LIMITS.maxParallel;
  const sessions = SQUAD_COUNT_LIMITS.maxSquadSessions;

  function save(): void {
    if (!reading.ok) return;
    void command.run(client.setSquadSettings(workspacePath, reading.settings), SAVE_FALLBACK);
  }

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      <NumberSetting
        id="squad-setting-max-parallel"
        label="Việc chạy song song"
        hint={`Số việc chạy cùng lúc, từ ${parallel.min} đến ${parallel.max}.`}
        value={draft.maxParallel}
        min={parallel.min}
        max={parallel.max}
        step={1}
        disabled={command.pending}
        onChange={(value) => setDraft((current) => ({ ...current, maxParallel: value }))}
      />
      <NumberSetting
        id="squad-setting-max-sessions"
        label="Phiên đội tối đa"
        hint={`Số phiên omp của đội được mở cùng lúc, từ ${sessions.min} đến ${sessions.max}.`}
        value={draft.maxSquadSessions}
        min={sessions.min}
        max={sessions.max}
        step={1}
        disabled={command.pending}
        onChange={(value) => setDraft((current) => ({ ...current, maxSquadSessions: value }))}
      />
      <NumberSetting
        id="squad-setting-min-free-ram"
        label="RAM trống tối thiểu (GB)"
        hint="Dưới mức RAM trống này thì không mở thêm phiên. Bước 0,5 GB."
        value={draft.minFreeRamGb}
        min={0}
        step={0.5}
        disabled={command.pending}
        onChange={(value) => setDraft((current) => ({ ...current, minFreeRamGb: value }))}
      />
      <ToggleSetting
        id="squad-setting-auto-judge"
        label="Tự chấm kết quả"
        hint="Trọng tài tự chấm kết quả khi việc xong."
        checked={draft.autoJudge}
        disabled={command.pending}
        onChange={(checked) => setDraft((current) => ({ ...current, autoJudge: checked }))}
      />
      <ToggleSetting
        id="squad-setting-auto-approve"
        label="Tự duyệt đề xuất bước tiếp"
        hint="Đề xuất bước tiếp không có cảnh báo thì tự được duyệt, không chờ bạn."
        checked={draft.autoApproveNext}
        disabled={command.pending}
        onChange={(checked) => setDraft((current) => ({ ...current, autoApproveNext: checked }))}
      />
      {reading.ok ? null : (
        <p role="alert" className="text-danger">
          {reading.reason}
        </p>
      )}
      {command.notice === null ? null : (
        <p className="text-2xs text-warning">{command.notice}</p>
      )}
      <div className="flex flex-wrap gap-1.5">
        <CompanyButton
          type="submit"
          size="sm"
          variant="accent"
          disabled={command.pending || !reading.ok}
        >
          Lưu cài đặt
        </CompanyButton>
      </div>
    </form>
  );
}

interface NumberSettingProps {
  id: string;
  label: string;
  hint: string;
  value: string;
  min: number;
  max?: number;
  step: number;
  disabled: boolean;
  onChange(value: string): void;
}

function NumberSetting({
  id,
  label,
  hint,
  value,
  min,
  max,
  step,
  disabled,
  onChange,
}: NumberSettingProps) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-text-muted">
        {label}
      </label>
      <input
        id={id}
        type="number"
        inputMode="decimal"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        aria-describedby={`${id}-hint`}
        onChange={(event) => onChange(event.target.value)}
        className={FIELD_CLASS}
      />
      <p id={`${id}-hint`} className="text-2xs text-text-muted">
        {hint}
      </p>
    </div>
  );
}

interface ToggleSettingProps {
  id: string;
  label: string;
  hint: string;
  checked: boolean;
  disabled: boolean;
  onChange(checked: boolean): void;
}

function ToggleSetting({ id, label, hint, checked, disabled, onChange }: ToggleSettingProps) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="flex items-center justify-between gap-2 text-text">
        {label}
        <input
          id={id}
          type="checkbox"
          checked={checked}
          disabled={disabled}
          aria-describedby={`${id}-hint`}
          onChange={(event) => onChange(event.target.checked)}
          className="size-4 shrink-0"
        />
      </label>
      <p id={`${id}-hint`} className="text-2xs text-text-muted">
        {hint}
      </p>
    </div>
  );
}

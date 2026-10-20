/**
 * SquadSettingsSection: the folder's squad settings, in a section the squad drawer keeps closed
 * until it is opened. The server owns the values: a save sends the whole set, and the form takes
 * its values again from the snapshot the server sends back. Opening the section asks the server
 * once whether Claude Code is installed and signed in.
 */

import { useState } from 'react';

import type { ClaudeCodeStatus, SquadSettings } from '../../../../core/src/messages.js';
import { claudeStatusLabel } from '../claudeCodeView.js';
import type { CompanyClient } from '../companyClient.js';
import {
  brainOf,
  CLAUDE_SETTING_LIMITS,
  permissionOf,
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

const BRAIN_OPTIONS: readonly { value: string; label: string }[] = [
  { value: 'omp', label: 'omp (mặc định)' },
  { value: 'claude', label: 'Claude Code (claude -p)' },
];

const PERMISSION_OPTIONS: readonly { value: string; label: string }[] = [
  { value: 'auto', label: 'auto (classifier duyệt)' },
  { value: 'acceptEdits', label: 'acceptEdits (chỉ duyệt sửa file)' },
];

export interface SquadSettingsSectionProps {
  client: CompanyClient;
  workspacePath: string;
  /** The folder's settings as the server holds them; null until the first snapshot arrives. */
  settings: SquadSettings | null;
  /** The folder's last Claude Code check; null until a snapshot carries one. */
  claudeStatus: ClaudeCodeStatus | null;
  /** The server names the user's Claude config defines for this folder, sorted. */
  claudeMcpServers: string[];
}

/** The squad settings, closed by default. The form re-mounts when the server's values change. */
export function SquadSettingsSection({
  client,
  workspacePath,
  settings,
  claudeStatus,
  claudeMcpServers,
}: SquadSettingsSectionProps) {
  return (
    <details
      className="flex flex-col gap-2 text-xs"
      onToggle={(event) => {
        // Opening the section asks the server once. Closing it, or a re-render, asks nothing.
        if (event.currentTarget.open) client.checkClaudeCode(workspacePath);
      }}
    >
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
          claudeStatus={claudeStatus}
          claudeMcpServers={claudeMcpServers}
        />
      )}
    </details>
  );
}

interface SquadSettingsFormProps {
  client: CompanyClient;
  workspacePath: string;
  settings: SquadSettings;
  claudeStatus: ClaudeCodeStatus | null;
  claudeMcpServers: string[];
}

function SquadSettingsForm({
  client,
  workspacePath,
  settings,
  claudeStatus,
  claudeMcpServers,
}: SquadSettingsFormProps) {
  const command = useCommandDialog(client);
  const [draft, setDraft] = useState<SquadSettingsDraft>(() => squadSettingsDraftOf(settings));
  const reading = squadSettingsFromDraft(draft);
  const parallel = SQUAD_COUNT_LIMITS.maxParallel;
  const sessions = SQUAD_COUNT_LIMITS.maxSquadSessions;
  const models = CLAUDE_SETTING_LIMITS.modelChars;
  const runs = CLAUDE_SETTING_LIMITS.maxClaudeRuns;
  const turns = CLAUDE_SETTING_LIMITS.claudeMaxTurns;
  const budget = CLAUDE_SETTING_LIMITS.claudeMaxBudgetUsd;
  const tools = CLAUDE_SETTING_LIMITS.claudeAllowedTools;

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
      <section aria-labelledby="squad-claude-heading" className="flex flex-col gap-3">
        <p id="squad-claude-heading" className="text-2xs font-semibold text-text-muted">
          Claude Code
        </p>
        <p role="status" data-testid="claude-code-status" className="text-2xs text-text">
          {claudeStatusLabel(claudeStatus)}
        </p>
        <SelectSetting
          id="squad-setting-brain"
          label="Bộ não của đội"
          hint="omp: đội chạy bằng omp như trước. Claude Code: trưởng nhóm và trọng tài chạy qua claude -p."
          value={draft.brain}
          options={BRAIN_OPTIONS}
          disabled={command.pending}
          onChange={(value) => setDraft((current) => ({ ...current, brain: brainOf(value) }))}
        />
        <TextSetting
          id="squad-setting-claude-leader"
          label="Model của trưởng nhóm"
          hint={`Tên model Claude, từ ${models.min} đến ${models.max} ký tự. Mặc định: opus.`}
          value={draft.claudeModelLeader}
          disabled={command.pending}
          onChange={(value) => setDraft((current) => ({ ...current, claudeModelLeader: value }))}
        />
        <TextSetting
          id="squad-setting-claude-judge"
          label="Model của trọng tài"
          hint={`Tên model Claude, từ ${models.min} đến ${models.max} ký tự. Mặc định: sonnet.`}
          value={draft.claudeModelJudge}
          disabled={command.pending}
          onChange={(value) => setDraft((current) => ({ ...current, claudeModelJudge: value }))}
        />
        <ToggleSetting
          id="squad-setting-prefer-claude"
          label="Ưu tiên Claude Code cho việc tự chọn"
          hint="Việc để agent tự chọn sẽ ưu tiên Claude Code trước omp."
          checked={draft.preferClaude}
          disabled={command.pending}
          onChange={(checked) => setDraft((current) => ({ ...current, preferClaude: checked }))}
        />
        <NumberSetting
          id="squad-setting-max-claude-runs"
          label="Số lần Claude Code chạy cùng lúc"
          hint={`Từ ${runs.min} đến ${runs.max} lần chạy.`}
          value={draft.maxClaudeRuns}
          min={runs.min}
          max={runs.max}
          step={1}
          disabled={command.pending}
          onChange={(value) => setDraft((current) => ({ ...current, maxClaudeRuns: value }))}
        />
        <NumberSetting
          id="squad-setting-claude-max-turns"
          label="Số lượt tối đa mỗi lần chạy"
          hint={`Từ ${turns.min} đến ${turns.max} lượt, truyền cho --max-turns.`}
          value={draft.claudeMaxTurns}
          min={turns.min}
          max={turns.max}
          step={1}
          disabled={command.pending}
          onChange={(value) => setDraft((current) => ({ ...current, claudeMaxTurns: value }))}
        />
        <NumberSetting
          id="squad-setting-claude-max-budget"
          label="Ngân sách mỗi lần chạy (USD)"
          hint="Từ 0,1 đến 50 USD, truyền cho --max-budget-usd. Bước 0,1."
          value={draft.claudeMaxBudgetUsd}
          min={budget.min}
          max={budget.max}
          step={0.1}
          disabled={command.pending}
          onChange={(value) => setDraft((current) => ({ ...current, claudeMaxBudgetUsd: value }))}
        />
        <SelectSetting
          id="squad-setting-claude-permission"
          label="Chế độ quyền khi sửa"
          hint="auto: classifier của Claude Code duyệt thao tác an toàn, chặn thao tác rủi ro. acceptEdits: chỉ tự duyệt sửa file; lệnh khác theo danh sách dưới."
          value={draft.claudePermission}
          options={PERMISSION_OPTIONS}
          disabled={command.pending}
          onChange={(value) =>
            setDraft((current) => ({ ...current, claudePermission: permissionOf(value) }))
          }
        />
        <TextareaSetting
          id="squad-setting-claude-allowed-tools"
          label="Công cụ được tự chạy khi sửa"
          hint={`Mỗi dòng một quyền, ví dụ Bash(git status*). Tối đa ${tools.maxCount} dòng. Không áp dụng cho việc chỉ đọc.`}
          value={draft.claudeAllowedTools}
          disabled={command.pending}
          onChange={(value) => setDraft((current) => ({ ...current, claudeAllowedTools: value }))}
        />
        <WorkerMcpSetting
          id="squad-setting-claude-worker-mcp"
          names={claudeMcpServers}
          selected={draft.claudeWorkerMcp}
          disabled={command.pending}
          onChange={(selected) =>
            setDraft((current) => ({ ...current, claudeWorkerMcp: selected }))
          }
        />
      </section>
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

interface SelectSettingProps {
  id: string;
  label: string;
  hint: string;
  value: string;
  options: readonly { value: string; label: string }[];
  disabled: boolean;
  onChange(value: string): void;
}

function SelectSetting({ id, label, hint, value, options, disabled, onChange }: SelectSettingProps) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-text-muted">
        {label}
      </label>
      <select
        id={id}
        value={value}
        disabled={disabled}
        aria-describedby={`${id}-hint`}
        onChange={(event) => onChange(event.target.value)}
        className={FIELD_CLASS}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <p id={`${id}-hint`} className="text-2xs text-text-muted">
        {hint}
      </p>
    </div>
  );
}

interface TextSettingProps {
  id: string;
  label: string;
  hint: string;
  value: string;
  disabled: boolean;
  onChange(value: string): void;
}

function TextSetting({ id, label, hint, value, disabled, onChange }: TextSettingProps) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-text-muted">
        {label}
      </label>
      <input
        id={id}
        type="text"
        autoComplete="off"
        spellCheck={false}
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

interface TextareaSettingProps {
  id: string;
  label: string;
  hint: string;
  value: string;
  disabled: boolean;
  onChange(value: string): void;
}

function TextareaSetting({ id, label, hint, value, disabled, onChange }: TextareaSettingProps) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-text-muted">
        {label}
      </label>
      <textarea
        id={id}
        rows={4}
        autoComplete="off"
        spellCheck={false}
        value={value}
        disabled={disabled}
        aria-describedby={`${id}-hint`}
        onChange={(event) => onChange(event.target.value)}
        className={`${FIELD_CLASS} resize-y`}
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

interface WorkerMcpSettingProps {
  id: string;
  /** The server names the user's Claude config defines for this folder. */
  names: readonly string[];
  /** The names the squad has chosen. One the config no longer defines still shows, to clear. */
  selected: readonly string[];
  disabled: boolean;
  onChange(selected: string[]): void;
}

/** The MCP servers a worker run may load, as toggle chips. Nothing is chosen by default. */
function WorkerMcpSetting({ id, names, selected, disabled, onChange }: WorkerMcpSettingProps) {
  const missing = selected.filter((name) => !names.includes(name));
  const shown = [...names, ...missing];
  const hintId = `${id}-hint`;

  function toggle(name: string): void {
    const next = selected.includes(name)
      ? selected.filter((entry) => entry !== name)
      : [...selected, name];
    onChange(next);
  }

  return (
    <fieldset className="flex flex-col gap-1.5" disabled={disabled} aria-describedby={hintId}>
      <legend className="text-2xs font-semibold text-text-muted">
        Máy chủ MCP cho việc chạy Claude Code
      </legend>
      <p id={hintId} className="text-2xs text-text-muted">
        Chỉ máy chủ được chọn mới được nạp khi chạy việc, không nạp máy chủ khác trong cấu hình.
        Máy chủ có token ghi thẳng trong cấu hình (headers, hoặc biến môi trường như TOKEN, KEY,
        SECRET) không hiện ở đây. Mặc định: không máy chủ nào.
      </p>
      {shown.length === 0 ? (
        <p className="text-2xs text-text-muted">
          Không tìm thấy máy chủ MCP nào trong cấu hình Claude Code trên máy này.
        </p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {shown.map((name) => (
            <button
              key={name}
              type="button"
              aria-pressed={selected.includes(name)}
              className="company-toggle touch-target max-w-full truncate text-xs"
              onClick={() => toggle(name)}
            >
              {missing.includes(name) ? `${name} (không còn dùng được)` : name}
            </button>
          ))}
        </div>
      )}
    </fieldset>
  );
}

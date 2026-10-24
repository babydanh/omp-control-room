import { useEffect, useState } from 'react';

import type {
  ProjectPrepareScript,
  ProjectSettingField,
  ProjectSettingsMessage,
  ProjectSettingsValues,
} from '../../../../core/src/messages.js';
import type { ProjectStore } from './projectStore.js';
import { useProjectState } from './projectStore.js';

export interface LayeredSettingsDialogProps {
  store: ProjectStore;
  nodeId: string | null;
  onClose: () => void;
  globalOmpRoleModels?: readonly { role: string; model: string; thinking?: string }[];
}

type SettingsScope = 'project' | 'folder';
type EditorValue = string | number | ProjectPrepareScript;

interface SettingFieldDefinition {
  field: ProjectSettingField;
  label: string;
  type: 'engine' | 'model' | 'number' | 'prepare';
  min?: number;
  max?: number;
  step?: number;
}

const FIELDS: readonly SettingFieldDefinition[] = [
  { field: 'engineLeader', label: 'Engine · Trưởng', type: 'engine' },
  { field: 'engineJudge', label: 'Engine · Thẩm định', type: 'engine' },
  { field: 'engineWorker', label: 'Engine · Thực thi', type: 'engine' },
  { field: 'claudeModelLeader', label: 'Model Claude · Trưởng', type: 'model' },
  { field: 'claudeModelJudge', label: 'Model Claude · Thẩm định', type: 'model' },
  { field: 'maxParallel', label: 'Việc chạy song song', type: 'number', min: 1, max: 24 },
  { field: 'maxPerRepo', label: 'Mỗi repo chạy cùng lúc', type: 'number', min: 1, max: 8 },
  { field: 'minFreeDiskGb', label: 'Ổ đĩa trống tối thiểu (GB)', type: 'number', min: 0, max: 500, step: 0.5 },
  { field: 'maxClaudeRuns', label: 'Phiên Claude đồng thời', type: 'number', min: 1, max: 4 },
  { field: 'maxAgyRuns', label: 'Phiên agy đồng thời', type: 'number', min: 1, max: 4 },
  { field: 'worktreePrepare', label: 'Chuẩn bị worktree', type: 'prepare' },
];

const ENGINE_LABELS: Readonly<Record<string, string>> = {
  omp: 'OMP',
  claude: 'Claude Code',
  agy: 'agy (Antigravity)',
};

const SOURCE_LABELS = { global: 'toàn cục', project: 'Project', folder: 'thư mục' } as const;

export function LayeredSettingsDialog({ store, nodeId, onClose, globalOmpRoleModels = [] }: LayeredSettingsDialogProps) {
  const state = useProjectState(store);
  const target = state.nodes.find((node) => node.id === nodeId);
  const folderAvailable = target?.kind === 'folder';
  const [scope, setScope] = useState<SettingsScope>('project');
  const [drafts, setDrafts] = useState<Partial<Record<ProjectSettingField, EditorValue>>>({});
  const [lastCommandId, setLastCommandId] = useState<string | null>(null);

  useEffect(() => {
    store.requestSettings(nodeId ?? undefined);
  }, [nodeId, store]);

  useEffect(() => {
    if (lastCommandId === null || state.pending[lastCommandId] !== undefined) return;
    if (state.results[lastCommandId] !== undefined) store.requestSettings(nodeId ?? undefined);
    setLastCommandId(null);
  }, [lastCommandId, nodeId, state.pending, state.results, store]);

  useEffect(() => {
    if (!folderAvailable && scope === 'folder') setScope('project');
  }, [folderAvailable, scope]);

  const settings = state.settings?.nodeId === (nodeId ?? undefined) ? state.settings : null;
  const error = state.errors[`settings:${nodeId ?? ''}`];

  function save(field: ProjectSettingField, value: EditorValue): void {
    if (nodeId === null) return;
    const requestId = store.setSetting({
      scope,
      nodeId,
      field,
      value,
    });
    setLastCommandId(requestId);
  }

  function clear(field: ProjectSettingField): void {
    if (nodeId === null) return;
    const requestId = store.clearSetting({ scope, nodeId, field });
    setLastCommandId(requestId);
  }

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center">
      <button type="button" aria-label="Đóng cài đặt theo tầng" onClick={onClose} className="absolute inset-0 cursor-default bg-black/40" />
      <section role="dialog" aria-modal="true" aria-labelledby="project-settings-title" className="relative flex max-h-[90vh] w-[min(680px,94vw)] flex-col gap-3 overflow-hidden rounded-(--company-radius-md) border border-hairline bg-panel p-3 text-text max-md:h-full max-md:max-h-none max-md:w-full max-md:rounded-none">
        <header className="flex items-center justify-between gap-2">
          <h2 id="project-settings-title" className="text-sm font-semibold">Cài đặt theo tầng</h2>
          <button type="button" className="company-icon-btn touch-target" aria-label="Đóng" onClick={onClose}>×</button>
        </header>
        <label className="flex items-center gap-2 text-xs text-text-muted">
          Đang sửa
          <select className="rounded-(--company-radius-sm) border border-hairline bg-well px-2 py-1.5 text-text" value={scope} onChange={(event) => setScope(event.target.value as SettingsScope)}>
            <option value="project">Project</option>
            {folderAvailable && <option value="folder">Thư mục</option>}
          </select>
        </label>
        {error && <p role="alert" className="text-xs text-status-danger">{error}</p>}
        {settings === null ? (
          <p role="status" className="text-xs text-text-muted">Đang tải cài đặt…</p>
        ) : (
          <div className="flex min-h-0 flex-col gap-2 overflow-y-auto">
            {FIELDS.map((definition) => (
              <SettingRow
                key={definition.field}
                definition={definition}
                message={settings}
                scope={scope}
                draft={drafts[definition.field]}
                onDraft={(value) => setDrafts((current) => ({ ...current, [definition.field]: value }))}
                onSave={(value) => save(definition.field, value)}
                onClear={() => clear(definition.field)}
              />
            ))}
            {globalOmpRoleModels.length > 0 && (
              <section className="flex flex-col gap-1 rounded-(--company-radius-sm) bg-raised p-2 text-xs">
                <h3 className="font-semibold">Model OMP toàn cục · chỉ đọc</h3>
                {globalOmpRoleModels.map((entry) => (
                  <p key={entry.role} className="text-text-muted">
                    {entry.role}: <code className="font-mono text-text">{entry.model}{entry.thinking ? ` · ${entry.thinking}` : ''}</code>
                  </p>
                ))}
              </section>
            )}
          </div>
        )}
        <footer className="flex justify-end border-t border-hairline pt-2">
          <button type="button" className="rounded-(--company-radius-sm) border border-hairline bg-raised px-3 py-1.5 text-xs" onClick={onClose}>Đóng</button>
        </footer>
      </section>
    </div>
  );
}

interface SettingRowProps {
  definition: SettingFieldDefinition;
  message: ProjectSettingsMessage;
  scope: SettingsScope;
  draft: EditorValue | undefined;
  onDraft(value: EditorValue): void;
  onSave(value: EditorValue): void;
  onClear(): void;
}

function SettingRow({ definition, message, scope, draft, onDraft, onSave, onClear }: SettingRowProps) {
  const effective = message.values[definition.field as keyof ProjectSettingsValues];
  const source = message.sources[definition.field];
  const hasOverride = source === scope;
  const shownDraft = draft ?? effective;
  const stateLabel = hasOverride ? 'đang ghi đè' : source === undefined ? 'không tầng nào đặt' : `kế thừa từ ${SOURCE_LABELS[source]}`;
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_minmax(160px,1fr)_auto] items-center gap-2 rounded-(--company-radius-sm) border border-hairline bg-raised p-2 max-sm:grid-cols-1">
      <div className="min-w-0">
        <div className="text-xs font-medium">{definition.label}</div>
        <div className="text-2xs text-text-muted">Hiệu lực: {formatValue(definition, effective)} · {stateLabel}</div>
      </div>
      <SettingInput definition={definition} value={shownDraft} onChange={onDraft} />
      <div className="flex items-center justify-end gap-1">
        <button type="button" className="rounded-(--company-radius-sm) border border-hairline bg-panel px-2 py-1 text-2xs" disabled={shownDraft === undefined} onClick={() => shownDraft !== undefined && onSave(shownDraft)}>Lưu</button>
        {hasOverride && <button type="button" className="rounded-(--company-radius-sm) border border-hairline bg-panel px-2 py-1 text-2xs" onClick={onClear}>Bỏ ghi đè</button>}
      </div>
    </div>
  );
}

function SettingInput({ definition, value, onChange }: {
  definition: SettingFieldDefinition;
  value: EditorValue | undefined;
  onChange(value: EditorValue): void;
}) {
  const fieldClass = 'min-w-0 rounded-(--company-radius-sm) border border-hairline bg-well px-2 py-1.5 text-xs text-text';
  if (definition.type === 'engine') {
    return (
      <select className={fieldClass} value={typeof value === 'string' ? value : ''} onChange={(event) => onChange(event.target.value)}>
        <option value="">Chọn engine</option>
        {Object.entries(ENGINE_LABELS).map(([engine, label]) => <option key={engine} value={engine}>{label}</option>)}
      </select>
    );
  }
  if (definition.type === 'number') {
    return <input className={fieldClass} type="number" min={definition.min} max={definition.max} step={definition.step ?? 1} value={typeof value === 'number' ? value : ''} onChange={(event) => onChange(Number(event.target.value))} />;
  }
  if (definition.type === 'prepare') {
    const script = isPrepareScript(value) ? value : { argv: [], timeoutMs: 60_000 };
    return (
      <div className="grid min-w-0 gap-1">
        <input aria-label="Đối số script dạng JSON array" className={fieldClass} value={JSON.stringify(script.argv)} placeholder='["npm", "install"]' onChange={(event) => {
          try {
            const argv: unknown = JSON.parse(event.target.value) as unknown;
            if (Array.isArray(argv) && argv.every((part) => typeof part === 'string')) onChange({ ...script, argv });
          } catch { /* Keep the last valid argv while the user edits JSON. */ }
        }} />
        <input aria-label="Timeout script chuẩn bị worktree (ms)" className={fieldClass} type="number" min={1000} max={600000} step={1000} value={script.timeoutMs} onChange={(event) => onChange({ ...script, timeoutMs: Number(event.target.value) })} />
      </div>
    );
  }
  return <input className={fieldClass} value={typeof value === 'string' ? value : ''} maxLength={64} onChange={(event) => onChange(event.target.value)} />;
}

function isPrepareScript(value: unknown): value is ProjectPrepareScript {
  return typeof value === 'object' && value !== null && 'argv' in value && 'timeoutMs' in value && Array.isArray(value.argv) && typeof value.timeoutMs === 'number';
}

function formatValue(definition: SettingFieldDefinition, value: unknown): string {
  if (value === undefined) return 'chưa đặt';
  if (definition.type === 'engine' && typeof value === 'string') return ENGINE_LABELS[value] ?? value;
  if (definition.type === 'prepare' && isPrepareScript(value)) return `${JSON.stringify(value.argv)} · ${value.timeoutMs} ms`;
  return String(value);
}

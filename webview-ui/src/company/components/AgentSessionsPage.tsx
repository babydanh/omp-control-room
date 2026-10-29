import { useMemo, useState } from 'react';

import { AGENT_ENGINES } from '../../../../core/src/agentEngines.js';
import type { FleetMachineSnapshot, LedgerSession } from '../../../../core/src/messages.js';
import { buildUnifiedAgentSessions, filterUnifiedAgentSessions, type UnifiedAgentEngine } from '../agentSessions.js';

export interface AgentSessionsPageProps {
  readonly localSessions: readonly LedgerSession[];
  readonly machines: readonly FleetMachineSnapshot[];
  readonly onRefreshFleet: () => void;
  readonly fleetAvailable: boolean;
  readonly localAvailable: boolean;
}

export function AgentSessionsPage({ localSessions, machines, onRefreshFleet, fleetAvailable, localAvailable }: AgentSessionsPageProps) {
  const [engine, setEngine] = useState<UnifiedAgentEngine | 'all'>('all');
  const [machine, setMachine] = useState<string | 'all'>('all');
  const rows = useMemo(() => buildUnifiedAgentSessions(localSessions, machines), [localSessions, machines]);
  const filtered = useMemo(
    () => filterUnifiedAgentSessions(rows, { engine, machine }),
    [rows, engine, machine],
  );
  const machineNames = [...new Set(rows.map((row) => row.machine))];

  return (
    <main className="company-shell-page flex min-h-0 flex-1 flex-col overflow-hidden" aria-label="Phiên agent">
      <header className="flex items-center justify-between gap-3 border-b border-hairline px-4 py-3">
        <div className="min-w-0">
          <h1 className="text-base font-semibold text-text">Phiên</h1>
          <p className="text-xs text-text-muted">
            {localAvailable ? 'Phiên cục bộ trong activity.db' : 'activity.db chưa khả dụng'} · Phiên Cloud trên cùng một danh sách.
          </p>
        </div>
        <button type="button" onClick={onRefreshFleet} disabled={!fleetAvailable} title={fleetAvailable ? undefined : 'Chưa kết nối Fleet'} className="company-btn company-btn-md company-btn-ghost touch-target shrink-0 disabled:opacity-50">Làm mới máy Cloud</button>
      </header>
      <div className="flex flex-wrap items-center gap-3 border-b border-hairline px-4 py-3">
        <label className="flex items-center gap-2 text-xs text-text-secondary">
          Công cụ
          <select aria-label="Lọc theo công cụ" className="rounded border border-hairline bg-well px-2 py-1 text-text" value={engine} onChange={(event) => setEngine(event.target.value as UnifiedAgentEngine | 'all')}>
            <option value="all">Tất cả</option>
            {AGENT_ENGINES.map((provider) => <option key={provider.id} value={provider.id}>{provider.label}</option>)}
            <option value="unknown">Không rõ</option>
          </select>
        </label>
        <label className="flex items-center gap-2 text-xs text-text-secondary">
          Máy
          <select aria-label="Lọc theo máy" className="rounded border border-hairline bg-well px-2 py-1 text-text" value={machine} onChange={(event) => setMachine(event.target.value)}>
            <option value="all">Tất cả máy</option>
            {machineNames.map((name) => <option key={name} value={name}>{name === 'local' ? 'Máy này' : name}</option>)}
          </select>
        </label>
        <span className="text-xs text-text-muted">{filtered.length}/{rows.length} phiên</span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-4">
        {filtered.length === 0 ? (
          <p className="text-sm text-text-muted">Không có phiên phù hợp với bộ lọc.</p>
        ) : (
          <ul aria-label="Danh sách phiên" className="space-y-2">
            {filtered.map((row) => (
              <li key={`${row.source}/${row.machine}/${row.sessionId}`} className="grid gap-2 rounded border border-hairline bg-panel px-3 py-2 text-xs sm:grid-cols-[minmax(9rem,0.7fr)_minmax(9rem,1fr)_minmax(8rem,0.8fr)_minmax(12rem,2fr)] sm:items-center">
                <span className="flex min-w-0 items-center gap-2 font-medium text-text">
                  <span aria-hidden="true" className="shrink-0">{row.icon}</span>
                  <span className="truncate">{row.engineLabel}</span>
                  <span className="truncate text-text-muted">{row.name}</span>
                </span>
                <span className="truncate text-text-secondary" title={row.machine === 'local' ? 'Máy này' : row.machine}>{row.machine === 'local' ? 'Máy này' : row.machine}</span>
                <span className={`shrink-0 ${row.status === 'running' ? 'text-success' : 'text-text-muted'}`}>
                  {row.status === 'running' ? 'đang chạy' : row.status === 'idle' ? 'rảnh' : 'đã kết thúc'}
                </span>
                <span className="min-w-0 space-y-1">
                  <span className="block break-all font-mono text-text-muted" title={row.cwd}>{row.cwd || '—'}</span>
                  <span className="block truncate text-text-secondary" title={row.branch ?? undefined}>{row.branch ?? 'Chưa rõ nhánh'}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}

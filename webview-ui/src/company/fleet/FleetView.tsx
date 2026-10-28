import { useEffect } from 'react';

import type { FleetMachineSnapshot } from '../../../../core/src/messages.js';
import { fleetStore } from './fleetClient.js';
import { useFleetState } from './fleetStore.js';

const REFRESH_INTERVAL_MS = 15_000;

export function FleetView() {
  const fleet = useFleetState(fleetStore);

  useEffect(() => {
    fleetStore.requestFleet();
    const timer = window.setInterval(() => fleetStore.requestFleet(), REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <div className="company-shell-page flex min-h-0 flex-1 flex-col overflow-hidden">
      <header className="flex items-center justify-between gap-3 border-b border-hairline px-4 py-3">
        <div className="min-w-0">
          <h1 className="text-base font-semibold text-text">Cloud</h1>
          <p className="text-xs text-text-muted">Máy InstaBox được báo cáo cho hub fleet.</p>
        </div>
        <button
          type="button"
          onClick={() => fleetStore.requestFleet()}
          className="company-btn company-btn-md company-btn-ghost touch-target shrink-0"
        >
          Làm mới
        </button>
      </header>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
        {fleet.error !== null && (
          <p role="alert" className="rounded border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-warning">
            {fleet.error}
          </p>
        )}
        {fleet.snapshot === null && fleet.latestRequestId !== null && (
          <p role="status" className="text-sm text-text-muted">Đang tải danh sách máy Cloud…</p>
        )}
        {fleet.snapshot?.machines.length === 0 && fleet.error === null && (
          <p className="text-sm text-text-muted">Hub chưa báo cáo máy nào.</p>
        )}
        {fleet.snapshot !== null && fleet.snapshot.machines.length > 0 && (
          <div className="grid gap-3 md:grid-cols-2">
            {fleet.snapshot.machines.map((machine) => (
              <MachineCard key={machine.agentId} machine={machine} />
            ))}
          </div>
        )}
        {fleet.snapshot !== null && (
          <section aria-labelledby="fleet-overlaps-title" className="space-y-2">
            <h2 id="fleet-overlaps-title" className="text-sm font-semibold text-text">Cảnh báo trùng tệp</h2>
            {fleet.snapshot.overlaps.length === 0 ? (
              <p className="text-sm text-text-muted">Chưa phát hiện tệp trùng lặp.</p>
            ) : (
              <ul className="space-y-2">
                {fleet.snapshot.overlaps.map((overlap) => (
                  <li
                    key={`${overlap.repo}\u0000${overlap.path}`}
                    className="rounded border border-warning/30 bg-warning/10 px-3 py-2 text-sm"
                  >
                    <p className="break-all font-mono text-text">{overlap.repo}/{overlap.path}</p>
                    <p className="mt-1 text-xs text-warning">
                      Máy: {overlap.machines.join(', ')}{overlap.local ? ' · có phiên cục bộ' : ''}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
      </div>
    </div>
  );
}

function MachineCard({ machine }: { machine: FleetMachineSnapshot }) {
  const lastSeen = new Intl.DateTimeFormat('vi-VN', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(machine.receivedAt);
  const stateLabel = machine.state === 'stale' ? 'Ngủ / mất kết nối' : 'Đang hoạt động';

  return (
    <article className="space-y-3 rounded border border-hairline bg-well p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h2 className="break-all font-mono text-sm font-semibold text-text">{machine.agentId}</h2>
        <span className={`text-xs ${machine.state === 'stale' ? 'text-warning' : 'text-text-muted'}`}>
          {stateLabel}
        </span>
      </div>
      <p className="text-xs text-text-muted">
        Lần cuối thấy: {lastSeen}
        {machine.diskFreeGb !== undefined && (
          <span className={machine.diskFreeGb < 3 ? 'text-warning' : ''}> · đĩa trống {machine.diskFreeGb} GB</span>
        )}
      </p>
      <p className="text-sm text-text-secondary">
        {machine.sessionCount} phiên · {machine.engines.length > 0 ? machine.engines.join(', ') : 'không có engine'}
      </p>
      {machine.repos.length > 0 ? (
        <ul className="space-y-1 border-t border-hairline pt-2">
          {machine.repos.map((repo, index) => (
            <li key={`${repo.name}-${repo.branch}-${index}`} className="flex flex-wrap gap-x-2 text-xs text-text-secondary">
              <span className="font-medium text-text">{repo.name}</span>
              <span className="break-all font-mono">{repo.branch}</span>
              <span>{repo.dirtyCount} tệp thay đổi</span>
              {repo.merged === true && <span className="text-success">đã vào main</span>}
            </li>
          ))}
        </ul>
      ) : (
        <p className="border-t border-hairline pt-2 text-xs text-text-muted">Chưa có repository được báo cáo.</p>
      )}
    </article>
  );
}

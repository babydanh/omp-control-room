import { useEffect, useState } from 'react';

import type { FleetMachineSnapshot } from '../../../../core/src/messages.js';
import { MAX_SESSIONS_PER_MACHINE, pickMachine, projectMachines, randomSuffix, slugFromPrompt } from './cloudTaskPick.js';
import { CloudTerminal } from './CloudTerminal.js';
import { fleetStore } from './fleetClient.js';
import { type FleetState, useFleetState } from './fleetStore.js';

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
        {fleet.terminal !== null && (
          <CloudTerminal
            key={fleet.terminal.terminalId}
            terminalId={fleet.terminal.terminalId}
            label={`${fleet.terminal.machine} · ${fleet.terminal.session}`}
            onClose={() => fleetStore.closeTerminal()}
          />
        )}
        <ActionStatus fleet={fleet} />
        {fleet.diff !== null && <DiffPanel diff={fleet.diff} />}
        {fleet.snapshot !== null && fleet.snapshot.machines.length > 0 && (
          <TaskForm machines={fleet.snapshot.machines} busy={fleet.action !== null} />
        )}
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
              <MachineCard key={machine.agentId} machine={machine} busy={fleet.action !== null} />
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
                      {overlap.level === 'line' ? 'Trùng dòng' : 'Trùng tệp'} · Máy: {overlap.machines.join(', ')}
                      {overlap.local ? ' · có phiên cục bộ' : ''}
                    </p>
                    {overlap.detail ? <p className="mt-1 break-all font-mono text-xs text-text-muted">{overlap.detail}</p> : null}
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

function ActionStatus({ fleet }: { fleet: FleetState }) {
  if (fleet.action !== null) {
    const what = {
      terminal: 'Đang mở terminal',
      task: 'Đang tạo worktree và mở Claude',
      lavish: 'Đang nối cổng tới Lavish',
      diff: 'Đang đọc thay đổi',
    }[fleet.action.kind];
    return (
      <p role="status" className="text-sm text-text-muted">
        {what} trên {fleet.action.machine} ({fleet.action.session})… máy đang ngủ thì mất 1–2 phút.
      </p>
    );
  }
  if (fleet.actionError !== null) {
    return (
      <p role="alert" className="rounded border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-warning">
        {fleet.actionError}
      </p>
    );
  }
  if (fleet.createdTask !== null) {
    const { machine, session } = fleet.createdTask;
    return (
      <p className="flex flex-wrap items-center gap-2 rounded border border-hairline px-3 py-2 text-sm">
        Đã giao việc: Claude đang chạy trong phiên <span className="font-mono">{session}</span> trên {machine}.
        <button type="button" className="company-btn company-btn-sm company-btn-ghost" onClick={() => fleetStore.openTerminal(machine, session)}>
          Mở terminal
        </button>
      </p>
    );
  }
  return null;
}

const AUTO = '';

const TASK_REPOS = [
  { value: 'all', label: 'Cả 3 repo (một agent làm trọn tính năng)' },
  { value: 'backend', label: 'Chỉ Backend' },
  { value: 'web', label: 'Chỉ Web' },
  { value: 'app', label: 'Chỉ App' },
] as const;

/**
 * "Tạo Claude cloud": type the request, press the button. By default the board picks the least busy project
 * machine (below 3 agents), all three repositories, and a task name made from the request; "Tùy chọn" overrides.
 */
function TaskForm({ machines, busy }: { machines: readonly FleetMachineSnapshot[]; busy: boolean }) {
  const [machine, setMachine] = useState(AUTO);
  const [repo, setRepo] = useState<(typeof TASK_REPOS)[number]['value']>('all');
  const [slug, setSlug] = useState('');
  const [prompt, setPrompt] = useState('');
  const candidates = projectMachines(machines);
  const target = machine === AUTO ? pickMachine(machines) : machine;
  const slugOk = slug === '' || /^[a-z0-9][a-z0-9-]{0,39}$/.test(slug);
  const ready = !busy && target !== null && slugOk && prompt.trim() !== '';
  const load = candidates.find((pick) => pick.machine === target);

  return (
    <form
      id="tao-claude-cloud"
      className="space-y-2 rounded border border-hairline bg-well p-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (!ready || target === null) return;
        fleetStore.createTask({ machine: target, repo, slug: slug || slugFromPrompt(prompt, randomSuffix()), prompt });
        setPrompt('');
        setSlug('');
      }}
    >
      <label className="block text-sm font-semibold text-text">
        Tạo Claude cloud
        <textarea
          className="mt-1 w-full rounded border border-hairline bg-transparent p-2 text-sm font-normal"
          rows={3}
          maxLength={20000}
          placeholder="Gõ việc cần làm, ví dụ: Sửa lỗi xếp sân đôi khi đổi giờ thi đấu"
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
        />
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <p className="min-w-0 flex-1 text-xs text-text-muted">
          {target === null
            ? candidates.length === 0
              ? 'Chưa có máy nào đủ 3 repo đồ án.'
              : `Cả ${candidates.length} máy đều đã chạy đủ ${MAX_SESSIONS_PER_MACHINE} việc. Đợi một việc xong hoặc chọn máy trong Tùy chọn.`
            : `Sẽ chạy trên ${target}${load ? ` (đang có ${load.sessions}/${MAX_SESSIONS_PER_MACHINE} việc)` : ''} · ${TASK_REPOS.find((item) => item.value === repo)?.label ?? repo}`}
        </p>
        <button type="submit" disabled={!ready} className="company-btn company-btn-md company-btn-primary">
          Tạo Claude cloud
        </button>
      </div>
      <details className="text-xs text-text-muted">
        <summary className="cursor-pointer">Tùy chọn (máy, repo, tên việc)</summary>
        <div className="mt-2 grid gap-2 md:grid-cols-3">
          <label>
            Máy
            <select className="mt-1 w-full rounded border border-hairline bg-transparent p-1 text-sm" value={machine} onChange={(event) => setMachine(event.target.value)}>
              <option value={AUTO}>Tự chọn máy rảnh nhất</option>
              {candidates.map((pick) => (
                <option key={pick.machine} value={pick.machine}>
                  {pick.machine} ({pick.sessions}/{MAX_SESSIONS_PER_MACHINE} việc)
                </option>
              ))}
            </select>
          </label>
          <label>
            Repo
            <select
              className="mt-1 w-full rounded border border-hairline bg-transparent p-1 text-sm"
              value={repo}
              onChange={(event) => setRepo(TASK_REPOS.find((item) => item.value === event.target.value)?.value ?? 'all')}
            >
              {TASK_REPOS.map((item) => (
                <option key={item.value} value={item.value}>{item.label}</option>
              ))}
            </select>
          </label>
          <label>
            Tên việc (để trống: tự đặt từ nội dung)
            <input
              className="mt-1 w-full rounded border border-hairline bg-transparent p-1 font-mono text-sm"
              value={slug}
              maxLength={40}
              placeholder="sua-xep-san-ab12"
              onChange={(event) => setSlug(event.target.value.toLowerCase())}
            />
          </label>
        </div>
      </details>
    </form>
  );
}

function formatIdle(seconds: number): string {
  if (seconds < 60) return 'vừa hoạt động';
  if (seconds < 3600) return `rảnh ${Math.floor(seconds / 60)} phút`;
  return `rảnh ${Math.floor(seconds / 3600)} giờ`;
}

function MachineCard({ machine, busy }: { machine: FleetMachineSnapshot; busy: boolean }) {
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
      {(machine.tmuxSessions ?? []).length > 0 && (
        <ul className="space-y-1 border-t border-hairline pt-2">
          {(machine.tmuxSessions ?? []).map((session) => (
            <li key={session.name} className="flex flex-wrap items-center gap-x-2 text-xs text-text-secondary">
              <span className="font-mono font-medium text-text">{session.name}</span>
              {session.command ? <span>{session.command}</span> : null}
              {session.branch ? <span className="break-all font-mono">{session.branch}</span> : null}
              <span className="text-text-muted">{formatIdle(session.idleSeconds)}{session.attached ? ' · có người đang xem' : ''}</span>
              <button
                type="button"
                disabled={busy}
                className="company-btn company-btn-sm company-btn-ghost ml-auto"
                onClick={() => fleetStore.openTerminal(machine.agentId, session.name)}
              >
                Mở terminal
              </button>
            </li>
          ))}
        </ul>
      )}
      {(machine.lavishSessions ?? []).length > 0 && (
        <ul className="space-y-1 border-t border-hairline pt-2">
          {(machine.lavishSessions ?? []).map((session) => (
            <li key={session.key} className="flex flex-wrap items-center gap-x-2 text-xs text-text-secondary">
              <span className="font-medium text-text">Lavish</span>
              <span className="break-all font-mono">{shortPath(session.file)}</span>
              <button
                type="button"
                disabled={busy}
                className="company-btn company-btn-sm company-btn-ghost ml-auto"
                onClick={() => fleetStore.openLavish(machine.agentId, session.key, openPendingTab())}
              >
                Mở Lavish
              </button>
            </li>
          ))}
        </ul>
      )}
      {machine.repos.length > 0 ? (
        <ul className="space-y-1 border-t border-hairline pt-2">
          {machine.repos.map((repo, index) => (
            <li key={`${repo.name}-${repo.branch}-${index}`} className="flex flex-wrap items-center gap-x-2 text-xs text-text-secondary">
              <span className="font-medium text-text">{repo.name}</span>
              <span className="break-all font-mono">{repo.branch}</span>
              <span>{repo.dirtyCount} tệp thay đổi</span>
              <span className={repo.merged === true && repo.dirtyCount === 0 ? 'text-success' : 'text-text-muted'}>{deliveryLabel(repo)}</span>
              {repo.path ? (
                <button
                  type="button"
                  disabled={busy}
                  className="company-btn company-btn-sm company-btn-ghost ml-auto"
                  onClick={() => repo.path && fleetStore.requestDiff(machine.agentId, repo.path)}
                >
                  Xem thay đổi
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="border-t border-hairline pt-2 text-xs text-text-muted">Chưa có repository được báo cáo.</p>
      )}
    </article>
  );
}

/** `/data/home/wt/backend-x/.lavish/plan.html` -> `backend-x/.lavish/plan.html`. */
function shortPath(file: string): string {
  return file.replace(/^\/data\/home\/(wt\/)?/, '');
}

/** A blank tab opened inside the click (so it is not blocked as a popup), pointed at Lavish once the port is forwarded. */
function openPendingTab() {
  const tab = window.open('about:blank', '_blank');
  if (!tab) return null;
  tab.opener = null;
  tab.document.title = 'Đang nối tới Lavish…';
  tab.document.body.textContent = 'Đang nối cổng tới máy cloud (máy ngủ thì mất 1–2 phút)…';
  return { navigate: (url: string) => tab.location.replace(url), close: () => tab.close() };
}

function diffLineClass(line: string): string {
  if (line.startsWith('###')) return 'font-semibold text-text';
  if (line.startsWith('+') && !line.startsWith('+++')) return 'text-success';
  if (line.startsWith('-') && !line.startsWith('---')) return 'text-warning';
  if (line.startsWith('@@')) return 'text-accent';
  return 'text-text-secondary';
}

/** Rendering is one element per line: cap it so a huge diff cannot freeze the board. */
const DIFF_MAX_LINES = 4000;

function DiffPanel({ diff }: { diff: NonNullable<FleetState['diff']> }) {
  const lines = diff.text.split('\n');
  const shown = lines.slice(0, DIFF_MAX_LINES);
  return (
    <section className="flex max-h-[70vh] flex-col rounded border border-hairline bg-well">
      <header className="flex items-center justify-between gap-2 border-b border-hairline px-3 py-2">
        <span className="break-all font-mono text-sm text-text">
          {diff.machine} · {diff.path}
        </span>
        {diff.truncated ? <span className="text-xs text-warning">Đã cắt bớt (quá 300 KB)</span> : null}
        <button type="button" className="company-btn company-btn-sm company-btn-ghost" onClick={() => fleetStore.closeDiff()}>
          Đóng
        </button>
      </header>
      <pre className="min-h-0 flex-1 overflow-auto p-3 font-mono text-xs leading-5">
        {shown.map((line, index) => (
          <div key={index} className={diffLineClass(line)}>
            {line || ' '}
          </div>
        ))}
        {lines.length > shown.length ? (
          <div className="text-warning">… còn {lines.length - shown.length} dòng. Xem đủ bằng git diff trong terminal.</div>
        ) : null}
      </pre>
    </section>
  );
}

/** Same three steps the local board shows: only on the branch, on staging, in main. */
/** Status of the committed HEAD; uncommitted edits are called out so they are not read as delivered. */
function deliveryLabel(repo: FleetMachineSnapshot['repos'][number]): string {
  const step = repo.merged === true ? 'đã vào main' : repo.staged === true ? 'đã lên staging' : repo.merged === false ? 'chỉ trên nhánh' : '';
  if (step === '' || repo.dirtyCount === 0) return step;
  return `${step} (phần đã commit) · còn ${repo.dirtyCount} tệp chưa commit`;
}

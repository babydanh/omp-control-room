import { useEffect, useRef, useState } from 'react';

import type { FleetMachineSnapshot, FleetTaskCreateMessage } from '../../../../core/src/messages.js';
import { sessionFaceHue } from '../projects/projectTreeView.js';
import { SessionFace } from '../projects/SessionFace.js';
import { cloudFaceMood, type PendingCloudRow } from './cloudRows.js';
import { pickMachine } from './cloudTaskPick.js';
import type { CloudRequest } from './FleetView.js';

/** The tree polls the hub on its own: the Cloud page's refresh only runs while that page is open. */
const REFRESH_MS = 30_000;

type CloudEngine = NonNullable<FleetTaskCreateMessage['engine']>;

export interface CloudNewTask {
  readonly machine: string;
  readonly prompt: string;
  readonly engine: CloudEngine;
}

export interface CloudSessionsProps {
  readonly machines: readonly FleetMachineSnapshot[];
  readonly refresh: () => void;
  /** Opens the session's terminal in the detail drawer, like a local agent. */
  readonly onOpenTerminal: (machine: string, session: string) => void;
  readonly onOpenDiff: (machine: string, path: string) => void;
  /** Starts a cloud task; the board names it and opens its terminal once the machine has created it. */
  readonly onCreate: (task: CloudNewTask) => void;
  /** The row held while a task is being created, before the machine reports its tmux session. */
  readonly pending: PendingCloudRow | null;
  /** The last cloud action's failure, shown under the header. */
  readonly error: string | null;
  /** A cloud action is running: one at a time, so a double click never creates two tasks. */
  readonly busy: boolean;
  /** A right-click "Phiên mới · Claude/omp cloud": open the request box with that agent chosen. */
  readonly request: CloudRequest | null;
  /** The cloud session the drawer shows, so its row can be marked. */
  readonly selected: { readonly machine: string; readonly session: string } | null;
}

/**
 * Sidebar section listing the agents running in tmux on cloud machines, next to the local sessions: each
 * is a face-and-name chip like a local agent. A click opens its terminal in the drawer, the repo chips open
 * the diff of the worktrees on its branch, and "+ Tạo Claude cloud" takes the request right here.
 */
export function CloudSessionsSection({ machines, refresh, onOpenTerminal, onOpenDiff, onCreate, pending, error, busy, request, selected }: CloudSessionsProps) {
  const [open, setOpen] = useState(true);
  const [formOpen, setFormOpen] = useState(false);
  const [engine, setEngine] = useState<CloudEngine>('claude');
  const [prompt, setPrompt] = useState('');
  const promptBox = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const timer = window.setInterval(refresh, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);
  // A new right-click request opens the box and chooses the agent again, even when it was chosen before.
  useEffect(() => {
    if (request === null) return;
    setEngine(request.engine);
    setOpen(true);
    setFormOpen(true);
  }, [request]);
  useEffect(() => {
    if (formOpen) promptBox.current?.focus();
  }, [formOpen]);

  const rows = machines.flatMap((machine) =>
    (machine.tmuxSessions ?? []).map((session) => ({
      machine,
      session,
      // Worktrees on the session's branch: one for a single-repo task, three for "Cả 3 repo".
      repos: session.branch ? machine.repos.filter((repo) => repo.branch === session.branch && repo.path) : [],
    })),
  );
  const target = pickMachine(machines);
  const agentName = engine === 'omp' ? 'omp' : 'Claude';
  const ready = !busy && target !== null && prompt.trim() !== '';

  return (
    <section aria-label="Cloud" className="flex flex-col gap-1">
      <div className="flex items-center">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="touch-target flex min-w-0 flex-1 items-center gap-1 rounded px-2 text-left text-xs font-semibold text-text-muted hover:bg-hover"
        >
          <span aria-hidden="true">{open ? '▾' : '▸'}</span>Cloud ({rows.length})
        </button>
        <button
          type="button"
          aria-expanded={formOpen}
          onClick={() => {
            setOpen(true);
            setFormOpen(!formOpen);
          }}
          title="Tạo Claude cloud: gõ việc, board tự chọn máy rảnh"
          className="touch-target shrink-0 rounded px-2 text-xs text-text-secondary hover:bg-hover"
        >
          + Tạo Claude cloud
        </button>
      </div>
      {formOpen && (
        <form
          className="mx-2 flex flex-col gap-1 rounded-lg border border-white/5 bg-white/[0.03] p-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (!ready || target === null) return;
            onCreate({ machine: target, prompt: prompt.trim(), engine });
            setPrompt('');
            setFormOpen(false);
          }}
        >
          <textarea
            ref={promptBox}
            aria-label={`Việc cho ${agentName} cloud`}
            className="w-full rounded border border-hairline bg-transparent p-2 text-sm"
            rows={3}
            maxLength={20000}
            placeholder="Gõ việc cần làm, ví dụ: Sửa lỗi xếp sân đôi khi đổi giờ thi đấu"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
          />
          <div className="flex items-center gap-1">
            <select
              aria-label="Agent"
              className="rounded bg-well px-1 py-1 text-xs text-text"
              value={engine}
              onChange={(event) => setEngine(event.target.value === 'omp' ? 'omp' : 'claude')}
            >
              <option value="claude">Claude</option>
              <option value="omp">omp</option>
            </select>
            <span className="min-w-0 flex-1 truncate text-2xs text-text-muted">
              {target === null ? 'Chưa có máy rảnh đủ 3 repo' : `chạy trên ${target}`}
            </span>
            <button type="submit" disabled={!ready} className="company-btn company-btn-sm company-btn-primary">
              Tạo
            </button>
          </div>
        </form>
      )}
      {error !== null && (
        <p role="alert" className="mx-2 rounded border border-warning/30 bg-warning/10 px-2 py-1 text-xs text-warning">
          {error}
        </p>
      )}
      {open && pending !== null && (
        <div
          role="status"
          className="mx-2 flex min-w-0 items-center gap-2.5 rounded-lg border border-white/5 bg-white/[0.03] px-2 py-1.5 text-xs"
        >
          <SessionFace mood="work" hue={sessionFaceHue(`${pending.machine}/${pending.session}`)} size="lg" variant="cloud" />
          <span className="min-w-0 flex-1 truncate text-text">{pending.session}</span>
          <span className="shrink-0 text-2xs text-text-muted">đang khởi động · {pending.machine}</span>
        </div>
      )}
      {open &&
        rows.map(({ machine, session, repos }) => {
          const isSelected = selected?.machine === machine.agentId && selected.session === session.name;
          return (
            <div key={`${machine.agentId}/${session.name}`} className="mx-2 flex min-w-0 items-center gap-1 text-xs">
              <button
                type="button"
                aria-current={isSelected ? 'true' : undefined}
                title={`Mở terminal: ${machine.agentId} · ${session.name}${session.branch ? ` · ${session.branch}` : ''}`}
                onClick={() => onOpenTerminal(machine.agentId, session.name)}
                className={`touch-target flex min-w-0 flex-1 items-center gap-2.5 rounded-lg border px-2 py-1.5 text-left transition-colors duration-150 ${
                  isSelected ? 'border-accent/50 bg-selected text-text' : 'border-white/5 bg-white/[0.03] hover:border-white/10 hover:bg-hover'
                }`}
              >
                <SessionFace mood={cloudFaceMood(session.idleSeconds)} hue={sessionFaceHue(`${machine.agentId}/${session.name}`)} size="lg" variant="cloud" />
                <span className="min-w-0 flex-1 truncate text-text">{session.name}</span>
                <span className="shrink-0 font-mono text-2xs text-text-muted">{machine.agentId}</span>
                <span className={`shrink-0 text-2xs ${session.idleSeconds < 60 ? 'text-success' : 'text-text-muted'}`}>
                  {session.idleSeconds < 60 ? 'đang làm' : `rảnh ${Math.floor(session.idleSeconds / 60)}′`}
                </span>
              </button>
              {repos.map((repo) => (
                <button
                  key={repo.path}
                  type="button"
                  title={`Xem thay đổi: ${repo.name}`}
                  onClick={() => repo.path && onOpenDiff(machine.agentId, repo.path)}
                  className="shrink-0 rounded border border-hairline px-1 text-2xs text-text-secondary hover:bg-hover"
                >
                  {repoChip(repo.name)}
                </button>
              ))}
            </div>
          );
        })}
    </section>
  );
}

function repoChip(name: string): string {
  if (/backend/i.test(name)) return 'BE';
  if (/web/i.test(name)) return 'Web';
  if (/app/i.test(name)) return 'App';
  return name.slice(0, 4);
}

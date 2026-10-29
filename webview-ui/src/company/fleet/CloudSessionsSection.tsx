import { useEffect, useState } from 'react';

import type { FleetMachineSnapshot } from '../../../../core/src/messages.js';

/** The tree polls the hub on its own: the Cloud page's refresh only runs while that page is open. */
const REFRESH_MS = 30_000;

export interface CloudSessionsProps {
  readonly machines: readonly FleetMachineSnapshot[];
  readonly refresh: () => void;
  readonly onOpenTerminal: (machine: string, session: string) => void;
  readonly onOpenDiff: (machine: string, path: string) => void;
}

/**
 * Sidebar section listing the agents running in tmux on cloud machines, next to the local sessions:
 * a click opens the session's terminal, the repo chips open the diff of the worktrees on its branch.
 */
export function CloudSessionsSection({ machines, refresh, onOpenTerminal, onOpenDiff }: CloudSessionsProps) {
  const [open, setOpen] = useState(true);
  useEffect(() => {
    const timer = window.setInterval(refresh, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const rows = machines.flatMap((machine) =>
    (machine.tmuxSessions ?? []).map((session) => ({
      machine,
      session,
      // Worktrees on the session's branch: one for a single-repo task, three for "Cả 3 repo".
      repos: session.branch ? machine.repos.filter((repo) => repo.branch === session.branch && repo.path) : [],
    })),
  );
  if (rows.length === 0) return null;

  return (
    <section aria-label="Cloud" className="flex flex-col">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="touch-target flex items-center gap-1 rounded px-2 text-left text-xs font-semibold text-text-muted hover:bg-hover"
      >
        <span aria-hidden="true">{open ? '▾' : '▸'}</span>Cloud ({rows.length})
      </button>
      {open &&
        rows.map(({ machine, session, repos }) => (
          <div key={`${machine.agentId}/${session.name}`} className="flex min-w-0 items-center gap-1 px-2 text-xs">
            <button
              type="button"
              title={`Mở terminal: ${machine.agentId} · ${session.name}${session.branch ? ` · ${session.branch}` : ''}`}
              onClick={() => onOpenTerminal(machine.agentId, session.name)}
              className="touch-target flex min-w-0 flex-1 items-center gap-2 rounded text-left hover:bg-hover"
            >
              <span aria-hidden="true">☁</span>
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
        ))}
    </section>
  );
}

function repoChip(name: string): string {
  if (/backend/i.test(name)) return 'BE';
  if (/web/i.test(name)) return 'Web';
  if (/app/i.test(name)) return 'App';
  return name.slice(0, 4);
}

import { useEffect, useRef, useState } from 'react';

import type { FleetMachineSnapshot, FleetTaskCreateMessage } from '../../../../core/src/messages.js';
import { sessionFaceHue } from '../projects/projectTreeView.js';
import { SessionFace } from '../projects/SessionFace.js';
import { cloudFolderKey, type CloudFolders, type CloudPlaceNode, placeCloudRows } from './cloudFolders.js';
import { cloudFaceMood, type PendingCloudRow } from './cloudRows.js';
import { pickMachine } from './cloudTaskPick.js';
import type { CloudRequest } from './FleetView.js';

/** The tree polls the hub on its own: the Cloud page's refresh only runs while that page is open. */
const REFRESH_MS = 30_000;

type CloudEngine = NonNullable<FleetTaskCreateMessage['engine']>;
type CloudRepo = FleetMachineSnapshot['repos'][number];

export interface CloudNewTask {
  readonly machine: string;
  readonly prompt: string;
  readonly engine: CloudEngine;
  /** The Project-tree node the request came from; its session then sits under that node, like a local one. */
  readonly nodeId?: string;
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
  /** Which tree node started each session; those sessions show under that node. */
  readonly folders: CloudFolders;
  /** The tree nodes that exist now: a session with no node of its own (by start or by repository) stays in the closing "Cloud khác" list. */
  readonly nodes: readonly CloudPlaceNode[];
}

interface CloudRow {
  readonly machine: string;
  readonly session: string;
  readonly idleSeconds: number;
  readonly branch: string | undefined;
  /** Worktrees on the session's branch: one for a single-repo task, three for "Cả 3 repo". */
  readonly repos: readonly CloudRepo[];
}

function cloudRows(machines: readonly FleetMachineSnapshot[]): CloudRow[] {
  return machines.flatMap((machine) =>
    (machine.tmuxSessions ?? []).map((session) => ({
      machine: machine.agentId,
      session: session.name,
      idleSeconds: session.idleSeconds,
      branch: session.branch,
      repos: session.branch ? machine.repos.filter((repo) => repo.branch === session.branch && repo.path) : [],
    })),
  );
}

/**
 * The agents running in tmux on cloud machines that fit no tree node (no node started them and no folder is named like
 * their repository): collapsed at the foot of the tree, one face-and-name chip each. Everything else sits under its folder.
 */
export function CloudSessionsSection(props: CloudSessionsProps) {
  const { machines, refresh, pending, selected, folders, nodes, request } = props;
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const timer = window.setInterval(refresh, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const folderIds = new Set(nodes.map((node) => node.id));
  const { loose } = placeCloudRows(cloudRows(machines), folders, nodes);
  const pendingFolder = pending === null ? undefined : folders[cloudFolderKey(pending.machine, pending.session)];
  const pendingHere = pending !== null && !folderIds.has(pendingFolder ?? '') ? pending : null;
  // A failed create shows under the node that asked for it; only one whose node is gone is shown here.
  const error = request?.nodeId !== undefined && folderIds.has(request.nodeId) ? null : props.error;
  if (loose.length === 0 && pendingHere === null && error === null) return null;
  const shown = open || pendingHere !== null;

  return (
    <section aria-label="Cloud khác" className="flex flex-col gap-1">
      {loose.length > 0 && (
        <button
          type="button"
          aria-expanded={shown}
          onClick={() => setOpen(!open)}
          className="touch-target flex w-full items-center gap-1 rounded px-2 text-left text-xs font-semibold text-text-muted hover:bg-hover"
        >
          <span aria-hidden="true">{shown ? '▾' : '▸'}</span>Cloud khác ({loose.length})
        </button>
      )}
      {error !== null && (
        <p role="alert" className="mx-2 rounded border border-warning/30 bg-warning/10 px-2 py-1 text-xs text-warning">
          {error}
        </p>
      )}
      {shown && pendingHere !== null && <CloudPendingChip row={pendingHere} />}
      {shown &&
        loose.map((row) => (
          <CloudRowChip key={cloudFolderKey(row.machine, row.session)} row={row} selected={selected} onOpenTerminal={props.onOpenTerminal} onOpenDiff={props.onOpenDiff} />
        ))}
    </section>
  );
}

/**
 * The cloud sessions of one tree node, listed under it like its local sessions: the request box when a
 * right-click asked for one here, the row held while the task starts, then one chip per session.
 */
export function CloudFolderRows({ nodeId, depth, ...props }: CloudSessionsProps & { readonly nodeId: string; readonly depth: number }) {
  const { machines, pending, folders, nodes, request, busy, selected } = props;
  const [formOpen, setFormOpen] = useState(false);
  useEffect(() => {
    if (request?.nodeId === nodeId) setFormOpen(true);
  }, [request, nodeId]);

  const rows = placeCloudRows(cloudRows(machines), folders, nodes).byFolder.get(nodeId) ?? [];
  const pendingHere = pending !== null && folders[cloudFolderKey(pending.machine, pending.session)] === nodeId ? pending : null;
  const error = request?.nodeId === nodeId ? props.error : null;
  if (!formOpen && rows.length === 0 && pendingHere === null && error === null) return null;
  return (
    <div className="flex flex-col gap-1" style={{ paddingLeft: `${depth * 12}px` }}>
      {error !== null && (
        <p role="alert" className="mx-2 rounded border border-warning/30 bg-warning/10 px-2 py-1 text-xs text-warning">
          {error}
        </p>
      )}
      {formOpen && request !== null && (
        <CloudNewForm
          key={request.token}
          machines={machines}
          busy={busy}
          initialEngine={request.engine}
          nodeId={nodeId}
          onSubmit={(task) => {
            props.onCreate(task);
            setFormOpen(false);
          }}
        />
      )}
      {pendingHere !== null && <CloudPendingChip row={pendingHere} />}
      {rows.map((row) => (
        <CloudRowChip key={cloudFolderKey(row.machine, row.session)} row={row} selected={selected} onOpenTerminal={props.onOpenTerminal} onOpenDiff={props.onOpenDiff} />
      ))}
    </div>
  );
}

function CloudNewForm({
  machines,
  busy,
  initialEngine,
  nodeId,
  onSubmit,
}: {
  readonly machines: readonly FleetMachineSnapshot[];
  readonly busy: boolean;
  readonly initialEngine: CloudEngine;
  readonly nodeId?: string;
  readonly onSubmit: (task: CloudNewTask) => void;
}) {
  const [engine, setEngine] = useState<CloudEngine>(initialEngine);
  const [prompt, setPrompt] = useState('');
  const promptBox = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    promptBox.current?.focus();
  }, []);
  const target = pickMachine(machines);
  const agentName = engine === 'omp' ? 'omp' : 'Claude';
  const ready = !busy && target !== null && prompt.trim() !== '';
  return (
    <form
      className="mx-2 flex flex-col gap-1 rounded-lg border border-white/5 bg-white/[0.03] p-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (!ready || target === null) return;
        onSubmit({ machine: target, prompt: prompt.trim(), engine, ...(nodeId === undefined ? {} : { nodeId }) });
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
  );
}

function CloudPendingChip({ row }: { readonly row: PendingCloudRow }) {
  return (
    <div role="status" className="mx-2 flex min-w-0 items-center gap-2.5 rounded-lg border border-white/5 bg-white/[0.03] px-2 py-1.5 text-xs">
      <SessionFace mood="work" hue={sessionFaceHue(`${row.machine}/${row.session}`)} size="lg" variant="cloud" />
      <span className="min-w-0 flex-1 truncate text-text">{row.session}</span>
      <span className="shrink-0 text-2xs text-text-muted">đang khởi động · {row.machine}</span>
    </div>
  );
}

function CloudRowChip({
  row,
  selected,
  onOpenTerminal,
  onOpenDiff,
}: {
  readonly row: CloudRow;
  readonly selected: CloudSessionsProps['selected'];
  readonly onOpenTerminal: CloudSessionsProps['onOpenTerminal'];
  readonly onOpenDiff: CloudSessionsProps['onOpenDiff'];
}) {
  const isSelected = selected?.machine === row.machine && selected.session === row.session;
  return (
    <div className="mx-2 flex min-w-0 items-center gap-1 text-xs">
      <button
        type="button"
        aria-current={isSelected ? 'true' : undefined}
        title={`Mở terminal: ${row.machine} · ${row.session}${row.branch ? ` · ${row.branch}` : ''}`}
        onClick={() => onOpenTerminal(row.machine, row.session)}
        className={`touch-target flex min-w-0 flex-1 items-center gap-2.5 rounded-lg border px-2 py-1.5 text-left transition-colors duration-150 ${
          isSelected ? 'border-accent/50 bg-selected text-text' : 'border-white/5 bg-white/[0.03] hover:border-white/10 hover:bg-hover'
        }`}
      >
        <SessionFace mood={cloudFaceMood(row.idleSeconds)} hue={sessionFaceHue(`${row.machine}/${row.session}`)} size="lg" variant="cloud" />
        <span className="min-w-0 flex-1 truncate text-text">{row.session}</span>
        <span className="shrink-0 font-mono text-2xs text-text-muted">{row.machine}</span>
        <span className={`shrink-0 text-2xs ${row.idleSeconds < 60 ? 'text-success' : 'text-text-muted'}`}>
          {row.idleSeconds < 60 ? 'đang làm' : `rảnh ${Math.floor(row.idleSeconds / 60)}′`}
        </span>
      </button>
      {row.repos.map((repo) => (
        <button
          key={repo.path}
          type="button"
          title={`Xem thay đổi: ${repo.name}`}
          onClick={() => repo.path && onOpenDiff(row.machine, repo.path)}
          className="shrink-0 rounded border border-hairline px-1 text-2xs text-text-secondary hover:bg-hover"
        >
          {repoChip(repo.name)}
        </button>
      ))}
    </div>
  );
}

function repoChip(name: string): string {
  if (/backend/i.test(name)) return 'BE';
  if (/web/i.test(name)) return 'Web';
  if (/app/i.test(name)) return 'App';
  return name.slice(0, 4);
}

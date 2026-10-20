import { type DragEvent, useEffect, useMemo, useState } from 'react';

import type { ProjectTreeNode } from '../../../../core/src/messages.js';
import type { AgentMenuRequest } from '../agentMenu.js';
import { useAgentMenuGestures } from '../useAgentMenuGestures.js';
import type { ProjectStore } from './projectStore.js';
import {
  buildAgentTree,
  canMoveProjectNode,
  countSessions,
  filterProjectTree,
  isRunningNode,
  type ProjectTreeBranch,
} from './projectTreeView.js';

const COLLAPSED_KEY = 'company.projectTree.collapsed.v1';
const AGENT_KINDS = ['omp', 'sub', 'claude', 'agy', 'herdr', 'board'] as const;
const AGENT_KIND_CLASS: Readonly<Record<NonNullable<ProjectTreeNode['agentKind']>, string>> = {
  omp: 'text-accent',
  sub: 'text-warning',
  claude: 'text-status-active',
  agy: 'text-status-waiting',
  herdr: 'text-text-secondary',
  board: 'text-text',
};
const SESSION_STATE_LABEL: Readonly<Record<string, string>> = {
  running: 'đang chạy',
  working: 'đang chạy',
  active: 'đang chạy',
  busy: 'đang chạy',
  waiting: 'đang chờ',
  waiting_input: 'chờ bạn',
  blocked: 'chờ bạn',
  idle: 'rảnh',
  sleeping: 'ngủ',
};
const STRUCTURE_ICON: Readonly<Partial<Record<ProjectTreeNode['kind'], string>>> = {
  project: '▰',
  group: '▸',
  folder: '📁',
};

function readCollapsed(): ReadonlySet<string> {
  try {
    const stored = window.localStorage.getItem(COLLAPSED_KEY);
    const parsed: unknown = stored === null ? [] : JSON.parse(stored);
    return Array.isArray(parsed) ? new Set(parsed.filter((item): item is string => typeof item === 'string')) : new Set();
  } catch {
    return new Set();
  }
}

export interface ProjectTreeProps {
  nodes: readonly ProjectTreeNode[];
  selectedProjectId: string | null;
  store: ProjectStore;
  onSelectProject: (projectId: string | null) => void;
  onCreateNode: (kind: 'project' | 'folder' | 'group', parentId?: string) => void;
  onOpenChanges: (checkoutId: string, tab?: 'diff' | 'merge') => void;
  onOpenSettings: (nodeId: string | null) => void;
  onNewSession: (nodeId: string, engine?: 'omp' | 'claude' | 'agy') => void;
  /** Opens a session row; `checkoutPath` is where it works, for sessions the board cannot show. */
  onOpenSession: (session: ProjectTreeNode, checkoutPath: string | undefined) => void;
  onMenu: (request: AgentMenuRequest) => void;
}

/** Sidebar: Project → groups → folders → the sessions working there. Git and files live on other pages. */
export function ProjectTree(props: ProjectTreeProps) {
  const { nodes, selectedProjectId, onSelectProject, onCreateNode } = props;
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [agentKind, setAgentKind] = useState<ProjectTreeNode['agentKind'] | 'all'>('all');
  // Default view: only sessions that are working or waiting on you; untick to see idle ones too.
  const [liveOnly, setLiveOnly] = useState(true);
  const tree = useMemo(() => buildAgentTree(nodes), [nodes]);
  const selectedRoots = selectedProjectId === null
    ? tree
    : tree.filter((branch) => branch.node.id === selectedProjectId);
  const visible = filterProjectTree(selectedRoots, { agentKind, liveOnly });
  useEffect(() => {
    try {
      window.localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsed]));
    } catch {
      // Storage is optional in embedded and restricted browser contexts.
    }
  }, [collapsed]);

  const toggleCollapse = (id: string) => setCollapsed((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });
  const moveNode = (sourceId: string, target: ProjectTreeNode) => {
    if (!nodes.some((node) => node.id === sourceId) || !canMoveProjectNode(nodes, sourceId, target.id)) return;
    const source = nodes.find((node) => node.id === sourceId);
    const parentId = target.kind === 'project' || target.kind === 'group' ? target.id : target.parentId;
    const siblings = nodes.filter((node) => node.parentId === parentId);
    let index = target.kind === 'folder' ? siblings.findIndex((node) => node.id === target.id) : undefined;
    const sourceIndex = siblings.findIndex((node) => node.id === sourceId);
    if (index !== undefined && index < 0) return;
    if (index !== undefined && source?.parentId === parentId && sourceIndex >= 0 && sourceIndex < index) index -= 1;
    props.store.moveNode({ nodeId: sourceId, ...(parentId === undefined ? {} : { parentId }), ...(index === undefined ? {} : { index }) });
  };
  return (
    <nav aria-label="Dự án" className="flex min-h-0 flex-col gap-1 border-b border-hairline px-2 py-2">
      <div className="flex items-center gap-1">
        <button type="button" aria-pressed={selectedProjectId === null} onClick={() => onSelectProject(null)} className="touch-target min-w-0 flex-1 rounded px-2 text-left text-2xs text-text-secondary aria-pressed:bg-selected">Tất cả dự án</button>
        <button type="button" aria-label="Tạo project" title="Tạo project" onClick={() => onCreateNode('project')} className="touch-target rounded px-2 text-text-secondary">➕</button>
      </div>
      <div className="flex items-center gap-2 px-2 text-2xs text-text-muted">
        <select aria-label="Lọc theo công cụ" value={agentKind} onChange={(event) => setAgentKind(event.target.value as ProjectTreeNode['agentKind'] | 'all')} className="min-w-0 flex-1 rounded bg-well px-1 py-1 text-text">
          <option value="all">Mọi công cụ</option>
          {AGENT_KINDS.map((kind) => <option key={kind} value={kind}>{kind}</option>)}
        </select>
        <label className="flex items-center gap-1" title="Bỏ chọn để xem cả phiên đang rảnh"><input type="checkbox" checked={liveOnly} onChange={(event) => setLiveOnly(event.target.checked)} />Đang hoạt động</label>
      </div>
      <div className="min-h-0 overflow-y-auto">
        {visible.map((branch) => (
          <ProjectTreeRow key={branch.node.id} branch={branch} depth={0} collapsed={collapsed} onToggleCollapse={toggleCollapse} onMove={moveNode} {...props} />
        ))}
        {visible.length === 0 && (
          <p className="px-2 py-3 text-2xs text-text-muted">
            {nodes.length === 0 ? 'Đang tải dự án…' : 'Chưa có Project nào.'}
          </p>
        )}
      </div>
    </nav>
  );
}

interface ProjectTreeRowProps extends ProjectTreeProps {
  branch: ProjectTreeBranch;
  depth: number;
  collapsed: ReadonlySet<string>;
  onToggleCollapse: (id: string) => void;
  onMove: (sourceId: string, target: ProjectTreeNode) => void;
}

function ProjectTreeRow({ branch, depth, collapsed, onToggleCollapse, onMove, ...props }: ProjectTreeRowProps) {
  const { node, children } = branch;
  const isCollapsed = collapsed.has(node.id);
  const menu = useAgentMenuGestures<HTMLButtonElement>(
    useMemo(() => ({ kind: 'projectNode' as const, node }), [node]),
    props.onMenu,
  );
  const isSession = node.kind === 'session';
  const receivesDrop = !isSession;
  const counts = isSession ? null : countSessions(branch);
  const onDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!receivesDrop) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  };
  return (
    <div>
      <div
        draggable={node.kind === 'folder' || node.kind === 'group'}
        onDragStart={(event) => event.dataTransfer.setData('text/plain', node.id)}
        onDragOver={onDragOver}
        onDrop={(event) => {
          if (!receivesDrop) return;
          event.preventDefault();
          event.stopPropagation();
          onMove(event.dataTransfer.getData('text/plain'), node);
        }}
        className="group flex min-w-0 items-center gap-1 rounded-(--company-radius-sm) hover:bg-hover"
        style={{ paddingLeft: `${depth * 10}px` }}
      >
        {children.length > 0 ? (
          <button type="button" aria-label={isCollapsed ? 'Mở rộng' : 'Thu gọn'} aria-expanded={!isCollapsed} onClick={() => onToggleCollapse(node.id)} className="touch-target size-5 shrink-0 text-text-muted">{isCollapsed ? '›' : '⌄'}</button>
        ) : <span className="w-5 shrink-0" />}
        <button
          type="button"
          aria-label={`${node.kind}: ${node.name}`}
          title={isSession ? [node.title, branch.where].filter(Boolean).join(' · ') : node.path ?? node.name}
          onClick={() => {
            if (node.kind === 'project') props.onSelectProject(node.id);
            else if (isSession) props.onOpenSession(node, branch.checkoutPath);
            else onToggleCollapse(node.id);
          }}
          {...menu}
          className={`touch-target flex min-w-0 flex-1 items-center gap-2 rounded px-1 text-left text-xs ${node.kind === 'project' && props.selectedProjectId === node.id ? 'bg-selected text-text' : 'text-text-secondary'} ${isSession ? 'py-1' : ''}`}
        >
          {isSession ? (
            <>
              <span aria-hidden="true" className={`size-2 shrink-0 rounded-full ${isRunningNode(node) ? 'bg-status-success' : 'bg-status-permission'}`} />
              <span className="min-w-0 flex-1 leading-tight">
                <span className="block truncate text-text">{node.name}</span>
                <span className="block truncate text-2xs text-text-muted">
                  {node.agentKind !== undefined && <span className={AGENT_KIND_CLASS[node.agentKind]}>{node.agentKind}</span>}
                  {branch.where !== undefined && ` · ${branch.where}`}
                  {node.state !== undefined && ` · ${SESSION_STATE_LABEL[node.state.toLowerCase()] ?? node.state}`}
                </span>
              </span>
            </>
          ) : (
            <>
              <span aria-hidden="true" className="shrink-0 text-text-muted">{STRUCTURE_ICON[node.kind] ?? '·'}</span>
              <span className={`min-w-0 flex-1 truncate ${node.kind === 'project' ? 'font-semibold text-text' : ''}`}>{node.name}</span>
              {counts !== null && counts.total > 0 && (
                <span className="shrink-0 text-2xs text-text-muted" title={`${counts.running} đang chạy / ${counts.total} phiên`}>
                  {counts.running > 0 ? `${counts.running} chạy` : `${counts.total} phiên`}
                </span>
              )}
            </>
          )}
        </button>
      </div>
      {!isCollapsed && children.map((child) => (
        <ProjectTreeRow key={child.node.id} branch={child} depth={depth + 1} collapsed={collapsed} onToggleCollapse={onToggleCollapse} onMove={onMove} {...props} />
      ))}
    </div>
  );
}

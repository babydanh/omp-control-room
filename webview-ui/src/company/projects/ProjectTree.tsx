import { type DragEvent, useEffect, useMemo, useState } from 'react';

import type { ProjectTreeNode } from '../../../../core/src/messages.js';
import type { AgentMenuRequest } from '../agentMenu.js';
import { useAgentMenuGestures } from '../useAgentMenuGestures.js';
import type { ProjectStore } from './projectStore.js';
import { buildProjectTree, canMoveProjectNode, filterProjectTree, type ProjectTreeBranch } from './projectTreeView.js';

const COLLAPSED_KEY = 'company.projectTree.collapsed.v1';
const AGENT_KINDS = ['omp', 'sub', 'claude', 'agy', 'herdr', 'board'] as const;
const AGENT_KIND_CLASS: Readonly<Record<NonNullable<ProjectTreeNode['agentKind']>, string>> = {
  omp: 'bg-accent/12 text-text',
  sub: 'bg-warning/12 text-warning',
  claude: 'bg-status-active/12 text-status-active',
  agy: 'bg-status-waiting/12 text-status-waiting',
  herdr: 'bg-raised text-text-muted',
  board: 'bg-selected text-text',
};
const SESSION_STATE_LABEL: Readonly<Record<string, string>> = {
  running: 'Đang chạy',
  waiting: 'Đang chờ',
  waiting_input: 'Đang chờ bạn',
  idle: 'Đang nghỉ',
  ended: 'Đã kết thúc',
  active: 'Đang chạy',
  busy: 'Đang chạy',
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
  onOpenSession: (sessionId: string) => void;
  onMenu: (request: AgentMenuRequest) => void;
}

export function ProjectTree(props: ProjectTreeProps) {
  const { nodes, selectedProjectId, onSelectProject, onCreateNode } = props;
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [agentKind, setAgentKind] = useState<ProjectTreeNode['agentKind'] | 'all'>('all');
  const [overlapOnly, setOverlapOnly] = useState(false);
  const [runningOnly, setRunningOnly] = useState(false);
  const tree = useMemo(() => buildProjectTree(nodes), [nodes]);
  const selectedRoots = selectedProjectId === null
    ? tree
    : tree.filter((branch) => branch.node.id === selectedProjectId);
  const visible = filterProjectTree(selectedRoots, { agentKind, overlapOnly, runningOnly });
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
        <button type="button" aria-label="Tạo project" onClick={() => onCreateNode('project')} className="touch-target rounded px-2 text-text-secondary">➕</button>
      </div>
      <label className="flex items-center gap-2 px-2 text-2xs text-text-muted">Công cụ
        <select aria-label="Lọc theo công cụ" value={agentKind} onChange={(event) => setAgentKind(event.target.value as ProjectTreeNode['agentKind'] | 'all')} className="min-w-0 flex-1 rounded bg-well px-1 py-1 text-text">
          <option value="all">Tất cả</option>
          {AGENT_KINDS.map((kind) => <option key={kind} value={kind}>{kind}</option>)}
        </select>
      </label>
      <label className="flex items-center gap-2 px-2 text-2xs text-text-muted"><input type="checkbox" checked={overlapOnly} onChange={(event) => setOverlapOnly(event.target.checked)} />Chỉ chồng dòng</label>
      <label className="flex items-center gap-2 px-2 text-2xs text-text-muted"><input type="checkbox" checked={runningOnly} onChange={(event) => setRunningOnly(event.target.checked)} />Chỉ đang chạy</label>
      <div className="min-h-0 overflow-y-auto">
        {visible.map((branch) => (
          <ProjectTreeRow key={branch.node.id} branch={branch} depth={0} collapsed={collapsed} onToggleCollapse={toggleCollapse} onMove={moveNode} {...props} />
        ))}
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
  const receivesDrop = node.kind === 'project' || node.kind === 'group' || node.kind === 'folder';
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
        style={{ paddingLeft: `${depth * 12}px` }}
      >
        {children.length > 0 ? (
          <button type="button" aria-label={isCollapsed ? 'Mở rộng' : 'Thu gọn'} aria-expanded={!isCollapsed} onClick={() => onToggleCollapse(node.id)} className="touch-target size-6 shrink-0 text-text-muted">{isCollapsed ? '›' : '⌄'}</button>
        ) : <span className="w-6 shrink-0" />}
        <button
          type="button"
          aria-label={`${node.kind}: ${node.name}`}
          onClick={() => {
            if (node.kind === 'project') props.onSelectProject(node.id);
            else if (node.kind === 'checkout') props.onOpenChanges(node.path ?? node.id);
            else if (node.kind === 'session' && node.sessionId !== undefined) props.onOpenSession(node.sessionId);
          }}
          {...menu}
          className={`touch-target flex min-w-0 flex-1 items-center gap-1.5 truncate rounded px-1.5 text-left text-xs ${node.kind === 'project' && props.selectedProjectId === node.id ? 'bg-selected text-text' : 'text-text-secondary'}`}
        >
          <span aria-hidden="true" className="shrink-0 text-text-muted">{node.kind === 'project' ? '▰' : node.kind === 'group' ? '▸' : node.kind === 'folder' ? '📁' : node.kind === 'repository' ? '⌘' : node.kind === 'checkout' ? '⑂' : node.kind === 'session' ? '●' : '·'}</span>
          <span className="min-w-0 flex-1 truncate">{node.name}</span>
          {node.agentKind !== undefined && <span className={`rounded px-1 text-2xs ${AGENT_KIND_CLASS[node.agentKind]}`}>{node.agentKind}</span>}
          {node.state !== undefined && <span className="truncate text-2xs text-text-muted">{SESSION_STATE_LABEL[node.state] ?? node.state}</span>}
          {node.overlap && <span title={`Chồng dòng với ${(node.overlappingWorktrees ?? []).join(', ')}`} className="text-warning">⚠</span>}
          {node.pendingWork && <span title="Có việc dở" className="text-warning">•</span>}
          {node.dirty && <span title="Có thay đổi" className="text-warning">●</span>}
          {node.branch !== undefined && <span className="max-w-24 truncate text-2xs text-text-muted">{node.branch}</span>}
          {(node.ahead !== undefined || node.behind !== undefined) && <span className="text-2xs text-text-muted">↑{node.ahead ?? 0} ↓{node.behind ?? 0}</span>}
          {(node.additions !== undefined || node.deletions !== undefined) && <span className="text-2xs text-text-muted">+{node.additions ?? 0} −{node.deletions ?? 0}</span>}
          {node.title !== undefined && <span className="max-w-32 truncate text-2xs text-text-muted">{node.title}</span>}
        </button>
      </div>
      {!isCollapsed && children.map((child) => (
        <ProjectTreeRow key={child.node.id} branch={child} depth={depth + 1} collapsed={collapsed} onToggleCollapse={onToggleCollapse} onMove={onMove} {...props} />
      ))}
    </div>
  );
}

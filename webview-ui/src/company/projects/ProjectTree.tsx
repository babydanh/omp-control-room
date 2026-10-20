import type { ProjectTreeNode } from '../../../../core/src/messages.js';

export interface ProjectTreeProps {
  nodes: readonly ProjectTreeNode[];
  selectedProjectId: string | null;
  onSelectProject: (projectId: string | null) => void;
  onCreateNode: (kind: 'project' | 'folder' | 'group', parentId?: string) => void;
  onOpenChanges: (checkoutId: string) => void;
  onOpenSettings: (nodeId: string | null) => void;
  onNewSession: (nodeId: string) => void;
}

function checkoutForProject(nodes: readonly ProjectTreeNode[], projectId: string): ProjectTreeNode | undefined {
  const descendants = new Set([projectId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of nodes) {
      if (node.parentId !== undefined && descendants.has(node.parentId) && !descendants.has(node.id)) {
        descendants.add(node.id);
        changed = true;
      }
    }
  }
  return nodes.find((node) => node.kind === 'checkout' && node.parentId !== undefined && descendants.has(node.parentId));
}
export function ProjectTree({ nodes, selectedProjectId, onSelectProject, onCreateNode, onOpenChanges, onOpenSettings, onNewSession }: ProjectTreeProps) {
  const projects = nodes.filter((node) => node.kind === 'project');
  return (
    <nav aria-label="Dự án" className="flex flex-col gap-1 border-b border-hairline px-2 py-2">
      <button type="button" aria-pressed={selectedProjectId === null} onClick={() => onSelectProject(null)} className="touch-target rounded px-2 text-left text-2xs text-text-secondary aria-pressed:bg-selected">Tất cả dự án</button>
      {projects.map((project) => (
        <div key={project.id} className="flex min-w-0 items-center gap-1">
          <button type="button" aria-pressed={selectedProjectId === project.id} onClick={() => onSelectProject(project.id)} className="touch-target min-w-0 flex-1 truncate rounded px-2 text-left text-2xs text-text-secondary aria-pressed:bg-selected">
            {project.name}
          </button>
          {selectedProjectId === project.id && (
            <>
              <button type="button" onClick={() => {
                const checkout = checkoutForProject(nodes, project.id);
                onOpenChanges(checkout?.path ?? checkout?.id ?? project.path ?? project.id);
              }} className="touch-target rounded px-2 text-2xs text-text-secondary">Thay đổi</button>
              <button type="button" onClick={() => onOpenSettings(project.id)} className="touch-target rounded px-2 text-2xs text-text-secondary">Cài đặt</button>
              <button type="button" onClick={() => onNewSession(project.id)} className="touch-target rounded px-2 text-2xs text-text-secondary">Phiên mới</button>
            </>
          )}
        </div>
      ))}
      <div className="flex gap-1">
        <button type="button" onClick={() => onCreateNode('project')} className="touch-target rounded px-2 text-2xs text-text-secondary">+ Dự án</button>
        <button type="button" onClick={() => onCreateNode('group')} className="touch-target rounded px-2 text-2xs text-text-secondary">+ Nhóm</button>
      </div>
    </nav>
  );
}

/** Which Project-tree node (folder) started each cloud session, kept in this browser: the hub only knows machines. */
export type CloudFolders = Readonly<Record<string, string>>;

export const CLOUD_FOLDERS_KEY = 'omp.company.cloudFolders';

export function cloudFolderKey(machine: string, session: string): string {
  return `${machine}/${session}`;
}

export function parseCloudFolders(raw: string | null): CloudFolders {
  if (raw === null) return {};
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  } catch {
    return {};
  }
}

export function readCloudFolders(): CloudFolders {
  try {
    return parseCloudFolders(window.localStorage.getItem(CLOUD_FOLDERS_KEY));
  } catch {
    return {};
  }
}

export function writeCloudFolders(folders: CloudFolders): void {
  try {
    window.localStorage.setItem(CLOUD_FOLDERS_KEY, JSON.stringify(folders));
  } catch {
    // Storage is optional in embedded and restricted browser contexts.
  }
}

/** The part of a tree node placement reads: its id, its place in the tree and the folder it points at. */
export interface CloudPlaceNode {
  readonly id: string;
  readonly parentId?: string;
  readonly kind: string;
  readonly path?: string;
}

function segments(path: string): string[] {
  return path.split(/[\\/]+/).filter(Boolean).map((part) => part.toLowerCase());
}

/** Each folder's own name plus every directory name its sessions work in: a repo checked out inside it counts as its repo. */
function folderNames(nodes: readonly CloudPlaceNode[]): Map<string, { readonly node: CloudPlaceNode; readonly names: Set<string> }> {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const folders = new Map<string, { readonly node: CloudPlaceNode; readonly names: Set<string> }>();
  for (const node of nodes) {
    if (node.kind === 'folder' && node.path !== undefined) folders.set(node.id, { node, names: new Set(segments(node.path).slice(-1)) });
  }
  for (const node of nodes) {
    if (node.path === undefined) continue;
    let owner = node.parentId === undefined ? undefined : byId.get(node.parentId);
    for (let hops = 0; owner !== undefined && owner.kind !== 'folder' && hops < nodes.length; hops += 1) {
      owner = owner.parentId === undefined ? undefined : byId.get(owner.parentId);
    }
    const names = owner === undefined ? undefined : folders.get(owner.id)?.names;
    if (names !== undefined) for (const part of segments(node.path)) names.add(part);
  }
  return folders;
}

/** The folder that holds the session's repositories; worktrees in several folders sit under their shared project. */
function folderOfRepos(repos: readonly { readonly name: string }[], folders: ReturnType<typeof folderNames>): string | undefined {
  const matched = new Map<string, CloudPlaceNode>();
  for (const repo of repos) {
    const wanted = repo.name.toLowerCase();
    for (const { node, names } of folders.values()) if (names.has(wanted)) matched.set(node.id, node);
  }
  const [first, ...rest] = [...matched.values()];
  if (first === undefined) return undefined;
  const parent = first.parentId;
  return parent !== undefined && rest.length > 0 && rest.every((node) => node.parentId === parent) ? parent : first.id;
}

/**
 * Rows under their tree node: the one the user started them from, else the folder named like their repository.
 * A row that matches no node stays loose.
 */
export function placeCloudRows<T extends { readonly machine: string; readonly session: string; readonly repos?: readonly { readonly name: string }[] }>(
  rows: readonly T[],
  folders: CloudFolders,
  nodes: readonly CloudPlaceNode[],
): { readonly byFolder: Map<string, T[]>; readonly loose: T[] } {
  const ids = new Set(nodes.map((node) => node.id));
  const index = folderNames(nodes);
  const byFolder = new Map<string, T[]>();
  const loose: T[] = [];
  for (const row of rows) {
    const chosen = folders[cloudFolderKey(row.machine, row.session)];
    const folder = chosen !== undefined && ids.has(chosen) ? chosen : folderOfRepos(row.repos ?? [], index);
    if (folder === undefined) loose.push(row);
    else byFolder.set(folder, [...(byFolder.get(folder) ?? []), row]);
  }
  return { byFolder, loose };
}

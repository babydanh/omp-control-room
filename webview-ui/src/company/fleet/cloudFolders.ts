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

/** Rows under the folder that started them; a row with no folder, or whose folder is gone, stays loose. */
export function placeCloudRows<T extends { readonly machine: string; readonly session: string }>(
  rows: readonly T[],
  folders: CloudFolders,
  folderIds: ReadonlySet<string>,
): { readonly byFolder: Map<string, T[]>; readonly loose: T[] } {
  const byFolder = new Map<string, T[]>();
  const loose: T[] = [];
  for (const row of rows) {
    const folder = folders[cloudFolderKey(row.machine, row.session)];
    if (folder === undefined || !folderIds.has(folder)) loose.push(row);
    else byFolder.set(folder, [...(byFolder.get(folder) ?? []), row]);
  }
  return { byFolder, loose };
}

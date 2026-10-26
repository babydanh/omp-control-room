/**
 * folderPick: choosing a folder through Windows' own folder dialog. A browser page never learns a
 * folder's real path, so the server opens the dialog on its machine and names the folder chosen.
 * Every control that asks for a folder (a new Project, a folder added to one, the folder switcher,
 * a new session with no folder open) goes through here.
 */

import { failureNotice } from './commandResults.js';
import type { CompanyClient } from './companyClient.js';

const PICK_FALLBACK = 'Không mở được hộp chọn thư mục.';
const OPEN_FALLBACK = 'Chưa mở được thư mục này trên bảng.';

/** What the dialog gave: the folder chosen, null when it was cancelled, or why it could not open. */
export type FolderPick = { readonly path: string } | { readonly notice: string } | null;

export async function pickFolder(client: CompanyClient): Promise<FolderPick> {
  const verdict = await client.waitForCommand(client.pickFolder());
  const notice = failureNotice(verdict, PICK_FALLBACK);
  if (notice !== null) return { notice };
  return verdict.workspacePath === undefined ? null : { path: verdict.workspacePath };
}

/** What choosing a folder to show came to: the board shows it, the dialog was cancelled, or why not. */
export type FolderOpen = 'opened' | 'cancelled' | { readonly notice: string };

/** Choose a folder in Windows' dialog and point the board at it. */
export async function openPickedFolder(client: CompanyClient): Promise<FolderOpen> {
  const picked = await pickFolder(client);
  if (picked === null) return 'cancelled';
  if ('notice' in picked) return picked;
  const refused = failureNotice(await client.waitForCommand(client.openWorkspace(picked.path)), OPEN_FALLBACK);
  return refused === null ? 'opened' : { notice: refused };
}

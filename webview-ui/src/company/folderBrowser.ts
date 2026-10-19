/**
 * folderBrowser: the pure rules behind the folder browser and the folder name dialog. It
 * splits a path into breadcrumbs, filters a listing, and checks a typed name against the
 * server's rules so the dialog can hint before anything is sent. DOM-free and React-free.
 */

import { folderBasename } from './folderView.js';

/** One step of a path: the label a breadcrumb shows and the path it names. */
export interface FolderCrumb {
  label: string;
  path: string;
}

/** A drive letter at the start of a path, such as `D:`. */
const DRIVE_PATTERN = /^[A-Za-z]:/;

/** The longest folder name the server accepts. */
const FOLDER_NAME_MAX_LENGTH = 255;

/** Characters a folder name may not hold: the path separators and the punctuation Windows forbids. */
const FOLDER_NAME_FORBIDDEN_PATTERN = /[\\/:*?"<>|]/;

/** The device names Windows reserves, with or without an extension, in any case. */
const WINDOWS_RESERVED_NAME_PATTERN = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/**
 * The steps from the root down to `path`, for a breadcrumb trail. Windows drive paths and
 * posix paths are both read, with either slash. Each crumb keeps the separator the input
 * used, so the path a crumb names can be sent back to the server as it is.
 */
export function breadcrumbs(path: string): FolderCrumb[] {
  const separator = path.includes('\\') ? '\\' : '/';
  const drive = DRIVE_PATTERN.exec(path)?.[0];
  const rest = drive === undefined ? path : path.slice(drive.length);
  const crumbs: FolderCrumb[] = [];
  let current = '';
  if (drive !== undefined) {
    current = `${drive}${separator}`;
    crumbs.push({ label: drive, path: current });
  } else if (/^[\\/]/.test(path)) {
    current = separator;
    crumbs.push({ label: separator, path: current });
  }
  for (const segment of rest.split(/[\\/]+/)) {
    if (segment === '') continue;
    const joined =
      current === '' || current.endsWith(separator) ? current : `${current}${separator}`;
    current = `${joined}${segment}`;
    crumbs.push({ label: segment, path: current });
  }
  return crumbs;
}

/**
 * The folders whose name contains the filter, ignoring case. A blank filter keeps every
 * folder, in the order the listing sent them.
 */
export function filterFolderEntries<T extends { name: string }>(
  entries: readonly T[],
  filter: string,
): T[] {
  const needle = filter.trim().toLowerCase();
  if (needle === '') return [...entries];
  return entries.filter((entry) => entry.name.toLowerCase().includes(needle));
}

/**
 * Why a typed folder name cannot be used, in Vietnamese, or null when it can. These are the
 * server's rules, repeated so the dialog can hint before anything is sent.
 */
export function folderNameError(name: string): string | null {
  // The server trims a typed name before it checks it, so the hint does the same.
  const trimmed = name.trim();
  if (trimmed === '') return 'Hãy nhập tên thư mục.';
  if (trimmed.length > FOLDER_NAME_MAX_LENGTH) {
    return `Tên thư mục dài tối đa ${FOLDER_NAME_MAX_LENGTH} ký tự.`;
  }
  if (FOLDER_NAME_FORBIDDEN_PATTERN.test(trimmed)) {
    return 'Tên thư mục không được chứa các ký tự \\ / : * ? " < > |';
  }
  if (trimmed === '.' || trimmed === '..') return 'Tên thư mục không được là "." hoặc "..".';
  if (trimmed.endsWith('.')) return 'Tên thư mục không được kết thúc bằng dấu chấm.';
  if (WINDOWS_RESERVED_NAME_PATTERN.test(trimmed)) {
    return 'Tên này là tên thiết bị Windows dành riêng; hãy chọn tên khác.';
  }
  return null;
}

/** The name a new folder or a rename starts from: the last segment of `path`. */
export function defaultFolderName(path: string): string {
  return folderBasename(path);
}

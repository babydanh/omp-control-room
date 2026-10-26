/**
 * folderName: the pure rules behind the folder name dialog. It checks a typed name against the
 * rules a folder name follows on Windows, so the dialog can hint before anything is sent, and
 * gives the name a rename starts from. DOM-free and React-free.
 */

import { folderBasename } from './folderView.js';

/** The longest folder name Windows accepts. */
const FOLDER_NAME_MAX_LENGTH = 255;

/** Characters a folder name may not hold: the path separators and the punctuation Windows forbids. */
const FOLDER_NAME_FORBIDDEN_PATTERN = /[\\/:*?"<>|]/;

/** The device names Windows reserves, with or without an extension, in any case. */
const WINDOWS_RESERVED_NAME_PATTERN = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/** Why a typed folder name cannot be used, in Vietnamese, or null when it can. */
export function folderNameError(name: string): string | null {
  // A typed name is trimmed before it is checked.
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

/** The name a rename starts from: the last segment of `path`. */
export function defaultFolderName(path: string): string {
  return folderBasename(path);
}

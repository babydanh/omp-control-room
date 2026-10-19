/**
 * folderBrowser: the file-system side of the Company folder browser. It lists the
 * folders the board's picker shows, creates a folder inside one, and checks folder
 * names against the rules every platform this app runs on accepts.
 *
 * Every call takes an injectable {@link FolderFs}: production passes node:fs, tests
 * pass a fake to drive the error paths. Refusals are {@link CompanyError}s whose code
 * is a {@link FolderErrorCode} and whose message is shown to the user as it stands.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { CompanyError } from './companyError.js';

/** Most folders one listing carries; a larger folder is listed with `truncated` set. */
export const FOLDER_LIST_LIMIT = 1000;

/** Longest folder name accepted, in characters. */
export const FOLDER_NAME_MAX_LENGTH = 255;

const FOLDER_ERROR_MESSAGES = {
  folder_path_invalid: 'Đường dẫn không hợp lệ.',
  folder_not_found: 'Thư mục không tồn tại.',
  not_a_folder: 'Đây không phải thư mục.',
  folder_unreadable: 'Không đọc được thư mục này.',
  folder_name_invalid: 'Tên thư mục không hợp lệ.',
  folder_name_too_long: 'Tên thư mục quá dài.',
  folder_exists: 'Thư mục đã tồn tại.',
  folder_create_failed: 'Không tạo được thư mục.',
} as const;

export type FolderErrorCode = keyof typeof FOLDER_ERROR_MESSAGES;

/** A place the picker starts from: a drive, the file-system root, or the home folder. */
export interface FolderRoot {
  kind: 'drive' | 'root' | 'home';
  name: string;
  path: string;
}

/** One folder inside a listed folder. */
export interface FolderEntry {
  name: string;
  path: string;
}

/**
 * What the picker shows. The start view has no `path` and no `parent`; a folder
 * listing has no `roots`.
 */
export interface FolderListing {
  path: string | null;
  parent: string | null;
  roots: FolderRoot[];
  entries: FolderEntry[];
  truncated: boolean;
}

/** The directory entry fields the listing reads. */
export interface FolderDirent {
  readonly name: string;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

/** The file-system calls the folder browser makes. */
export interface FolderFs {
  /** The platform whose path rules apply: drive roots on win32, `/` elsewhere. */
  readonly platform: NodeJS.Platform;
  homedir(): string;
  realpath(target: string): Promise<string>;
  /** Follows symbolic links. */
  stat(target: string): Promise<{ isDirectory(): boolean }>;
  /** Does not follow symbolic links. */
  lstat(target: string): Promise<{ isDirectory(): boolean }>;
  readdir(target: string): Promise<FolderDirent[]>;
  /** Creates one directory; the parent must already exist. */
  mkdir(target: string): Promise<void>;
}

/** The production file system. */
export const NODE_FOLDER_FS: FolderFs = {
  platform: process.platform,
  homedir: () => os.homedir(),
  realpath: (target) => fs.promises.realpath(target),
  stat: (target) => fs.promises.stat(target),
  lstat: (target) => fs.promises.lstat(target),
  readdir: (target) => fs.promises.readdir(target, { withFileTypes: true }),
  mkdir: async (target) => {
    await fs.promises.mkdir(target);
  },
};

/** The `code` a Node file-system error carries, such as `ENOENT`, when there is one. */
function systemErrorCode(err: unknown): string | undefined {
  if (err && typeof err === 'object' && 'code' in err && typeof err.code === 'string') {
    return err.code;
  }
  return undefined;
}

const DRIVE_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

/** Windows device names; a folder may not be called one, with or without an extension. */
const RESERVED_DEVICE_NAME = /^(CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(\.|$)/i;

/** Characters no folder name may contain on any platform this app runs on. */
const FORBIDDEN_NAME_CHARACTERS = /[\\/:*?"<>|]/;

/** The path rules of the platform the file system reports, not of the one running the tests. */
function pathApi(platform: NodeJS.Platform): typeof path.posix {
  return platform === 'win32' ? path.win32 : path.posix;
}

function refuse(code: FolderErrorCode, cause?: unknown): CompanyError {
  return new CompanyError(
    code,
    FOLDER_ERROR_MESSAGES[code],
    cause === undefined ? undefined : { cause },
  );
}

async function isDirectoryAt(io: FolderFs, target: string): Promise<boolean> {
  try {
    return (await io.stat(target)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Check a typed folder path and return its canonical form. The path must be absolute
 * for the platform and must not contain a `..` segment, so the spelling the user typed
 * cannot climb out of the folder they named.
 */
export async function resolveFolderPath(
  input: string,
  io: FolderFs = NODE_FOLDER_FS,
): Promise<string> {
  const p = pathApi(io.platform);
  if (input.includes('\0') || !p.isAbsolute(input) || input.split(/[\\/]/).includes('..')) {
    throw refuse('folder_path_invalid');
  }
  let canonical: string;
  try {
    canonical = await io.realpath(input);
  } catch (err) {
    throw refuse('folder_not_found', err);
  }
  let stats: { isDirectory(): boolean };
  try {
    stats = await io.stat(canonical);
  } catch (err) {
    throw refuse('folder_not_found', err);
  }
  if (!stats.isDirectory()) throw refuse('not_a_folder');
  return canonical;
}

/** Case-insensitive order by name; equal names in different cases fall back to plain order. */
function compareNames(a: string, b: string): number {
  const lowerA = a.toLowerCase();
  const lowerB = b.toLowerCase();
  if (lowerA < lowerB) return -1;
  if (lowerA > lowerB) return 1;
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * The folders directly inside a canonical folder, sorted by name and capped at
 * {@link FOLDER_LIST_LIMIT}. Files are left out; a symbolic link counts when it
 * resolves to a directory. Dot-folders are listed.
 */
export async function listFolder(
  canonicalPath: string,
  io: FolderFs = NODE_FOLDER_FS,
): Promise<FolderListing> {
  const p = pathApi(io.platform);
  let dirents: FolderDirent[];
  try {
    dirents = await io.readdir(canonicalPath);
  } catch (err) {
    throw refuse('folder_unreadable', err);
  }
  const names: string[] = [];
  const links: string[] = [];
  for (const dirent of dirents) {
    if (dirent.isDirectory()) names.push(dirent.name);
    else if (dirent.isSymbolicLink()) links.push(dirent.name);
  }
  const linkedDirectories = await Promise.all(
    links.map(async (name) =>
      (await isDirectoryAt(io, p.join(canonicalPath, name))) ? name : null,
    ),
  );
  for (const name of linkedDirectories) {
    if (name !== null) names.push(name);
  }
  names.sort(compareNames);
  const parent = p.dirname(canonicalPath);
  return {
    path: canonicalPath,
    parent: parent === canonicalPath ? null : parent,
    roots: [],
    entries: names
      .slice(0, FOLDER_LIST_LIMIT)
      .map((name) => ({ name, path: p.join(canonicalPath, name) })),
    truncated: names.length > FOLDER_LIST_LIMIT,
  };
}

/**
 * The picker's start view: every drive that exists on win32, or `/` elsewhere, then
 * the home folder. It lists no folders itself, so `path` and `parent` are null.
 */
export async function startView(io: FolderFs = NODE_FOLDER_FS): Promise<FolderListing> {
  const roots: FolderRoot[] = [];
  if (io.platform === 'win32') {
    const drives = await Promise.all(
      DRIVE_LETTERS.map(async (letter): Promise<FolderRoot | null> => {
        const root = `${letter}:\\`;
        return (await isDirectoryAt(io, root))
          ? { kind: 'drive', name: `${letter}:`, path: root }
          : null;
      }),
    );
    for (const drive of drives) {
      if (drive !== null) roots.push(drive);
    }
  } else {
    roots.push({ kind: 'root', name: '/', path: '/' });
  }
  const home = await homeRoot(io);
  if (home !== null) roots.push(home);
  return { path: null, parent: null, roots, entries: [], truncated: false };
}

async function homeRoot(io: FolderFs): Promise<FolderRoot | null> {
  let home: string;
  try {
    home = await io.realpath(io.homedir());
  } catch {
    return null;
  }
  return { kind: 'home', name: pathApi(io.platform).basename(home) || home, path: home };
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) < 0x20) return true;
  }
  return false;
}

/**
 * The refusal code for a folder name, or `null` when the name is acceptable. The name is
 * trimmed first and every rule applies to the trimmed value, so surrounding spaces are
 * dropped rather than refused.
 */
export function validateFolderName(name: string): FolderErrorCode | null {
  const trimmed = name.trim();
  if (trimmed.length === 0) return 'folder_name_invalid';
  if (trimmed.length > FOLDER_NAME_MAX_LENGTH) return 'folder_name_too_long';
  if (FORBIDDEN_NAME_CHARACTERS.test(trimmed) || hasControlCharacter(trimmed)) {
    return 'folder_name_invalid';
  }
  if (trimmed === '.' || trimmed === '..' || trimmed.endsWith('.')) return 'folder_name_invalid';
  if (RESERVED_DEVICE_NAME.test(trimmed)) return 'folder_name_invalid';
  return null;
}

async function entryExists(io: FolderFs, target: string): Promise<boolean> {
  try {
    await io.lstat(target);
    return true;
  } catch (err) {
    if (systemErrorCode(err) === 'ENOENT') return false;
    throw refuse('folder_create_failed', err);
  }
}

/**
 * Create one folder directly inside a folder the user named, and return its canonical
 * path. The name is trimmed, validated, and created with a non-recursive `mkdir`, so a
 * missing parent is refused rather than built.
 */
export async function createFolder(
  parentInput: string,
  name: string,
  io: FolderFs = NODE_FOLDER_FS,
): Promise<string> {
  const code = validateFolderName(name);
  if (code !== null) throw refuse(code);
  const folderName = name.trim();
  const parent = await resolveFolderPath(parentInput, io);
  const child = pathApi(io.platform).join(parent, folderName);
  if (await entryExists(io, child)) throw refuse('folder_exists');
  try {
    await io.mkdir(child);
  } catch (err) {
    throw refuse(systemErrorCode(err) === 'EEXIST' ? 'folder_exists' : 'folder_create_failed', err);
  }
  try {
    return await io.realpath(child);
  } catch (err) {
    throw refuse('folder_create_failed', err);
  }
}

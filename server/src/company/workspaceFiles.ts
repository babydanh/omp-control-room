/**
 * Workspace file access for the Company file browser and diff viewer.
 *
 * Every request is workspace-relative. A path is resolved against the workspace
 * root and then checked twice: lexically, and again after `realpath` so a
 * symlink inside the workspace cannot reach a file outside it. A request that
 * escapes is rejected rather than silently clamped to the root, because a
 * clamped read would show the user a different file than the one they asked for.
 *
 * Content is returned in pages. Text is decoded as UTF-8 when the bytes look
 * like text and base64 otherwise, so a PNG previewed in the viewer is not
 * corrupted by a lossy decode.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { CompanyFileContent, CompanyFileEntry } from '../../../core/src/company.js';
import { CompanyError } from './companyError.js';
import {
  COMPANY_FILE_BINARY_SNIFF_BYTES,
  COMPANY_FILE_DEFAULT_PAGE_BYTES,
  COMPANY_FILE_IGNORED_NAMES,
  COMPANY_FILE_MAX_PAGE_BYTES,
  COMPANY_FILE_TEXT_MEDIA_TYPES,
} from './constants.js';

/**
 * Resolve a workspace-relative path, refusing anything that escapes the root.
 *
 * The root is realpath'd first: comparing a real target against a lexical root
 * rejects every read when the workspace itself is reached through a symlink
 * (macOS puts `os.tmpdir()` under `/var`, a symlink to `/private/var`), and
 * comparing lexical paths lets a symlink or junction inside the workspace
 * reach a file outside it.
 */
async function resolveInsideWorkspace(
  workspaceRoot: string,
  relativePath: string,
): Promise<string> {
  let root: string;
  try {
    root = await fs.promises.realpath(workspaceRoot);
  } catch (err) {
    throw new CompanyError('invalid_workspace', `Workspace unavailable: ${workspaceRoot}`, {
      cause: err,
    });
  }
  const target = path.resolve(root, relativePath);
  if (!isInside(root, target)) {
    throw new CompanyError('path_outside_workspace', `Path escapes the workspace: ${relativePath}`);
  }
  let real: string;
  try {
    real = await fs.promises.realpath(target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new CompanyError('file_not_found', `No such path: ${relativePath}`, { cause: err });
    }
    throw err;
  }
  if (!isInside(root, real)) {
    throw new CompanyError(
      'path_outside_workspace',
      `Path resolves outside the workspace: ${relativePath}`,
    );
  }
  return real;
}

/** True when `candidate` is the root itself or lives under it. */
function isInside(root: string, candidate: string): boolean {
  if (candidate === root) return true;
  const relative = path.relative(root, candidate);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/** Workspace-relative POSIX form, for the wire and for matching entries. */
function toRelative(workspaceRoot: string, absolutePath: string): string {
  const relative = path.relative(path.resolve(workspaceRoot), absolutePath);
  return relative.split(path.sep).join('/');
}

function mediaTypeFor(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  return COMPANY_FILE_TEXT_MEDIA_TYPES[extension] ?? 'application/octet-stream';
}

/** Bytes containing a NUL are treated as binary rather than decoded. */
function looksBinary(buffer: Buffer): boolean {
  const window = buffer.subarray(0, COMPANY_FILE_BINARY_SNIFF_BYTES);
  return window.includes(0);
}

export async function listWorkspaceFiles(
  workspaceRoot: string,
  relativePath: string,
): Promise<CompanyFileEntry[]> {
  const directory = await resolveInsideWorkspace(workspaceRoot, relativePath);
  const stats = await fs.promises.stat(directory);
  if (!stats.isDirectory()) {
    throw new CompanyError('not_a_directory', `Not a directory: ${relativePath}`);
  }
  const dirEntries = await fs.promises.readdir(directory, { withFileTypes: true });
  const entries: CompanyFileEntry[] = [];
  for (const entry of dirEntries) {
    if (COMPANY_FILE_IGNORED_NAMES.has(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    const isDirectory = entry.isDirectory();
    let sizeBytes: number | undefined;
    let modifiedAt: string | undefined;
    if (isDirectory) {
      // Symlinked directories are listed but never traversed; resolving them
      // here would follow a link out of the workspace.
      try {
        const target = await fs.promises.stat(absolute);
        modifiedAt = target.mtime.toISOString();
      } catch {
        continue;
      }
    } else {
      try {
        const target = await fs.promises.stat(absolute);
        sizeBytes = target.size;
        modifiedAt = target.mtime.toISOString();
      } catch {
        continue;
      }
    }
    entries.push({
      name: entry.name,
      path: toRelative(workspaceRoot, absolute),
      kind: isDirectory ? 'directory' : 'file',
      ...(sizeBytes === undefined ? {} : { sizeBytes }),
      ...(modifiedAt === undefined ? {} : { modifiedAt }),
    });
  }
  entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  return entries;
}

export async function readWorkspaceFile(
  workspaceRoot: string,
  relativePath: string,
  offset: number,
  limit: number = COMPANY_FILE_DEFAULT_PAGE_BYTES,
): Promise<CompanyFileContent> {
  const file = await resolveInsideWorkspace(workspaceRoot, relativePath);
  const stats = await fs.promises.stat(file);
  if (!stats.isFile()) {
    throw new CompanyError('not_a_file', `Not a file: ${relativePath}`);
  }
  const pageSize = Math.min(
    Math.max(1, Math.floor(limit) || COMPANY_FILE_DEFAULT_PAGE_BYTES),
    COMPANY_FILE_MAX_PAGE_BYTES,
  );
  const safeOffset = Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0;
  const buffer = Buffer.alloc(pageSize);
  const handle = await fs.promises.open(file, 'r');
  let bytesRead: number;
  try {
    ({ bytesRead } = await handle.read(buffer, 0, pageSize, safeOffset));
  } finally {
    await handle.close();
  }
  const slice = buffer.subarray(0, bytesRead);
  const truncated = safeOffset + bytesRead < stats.size;
  const mediaType = mediaTypeFor(file);
  const binary = looksBinary(slice) || mediaType === 'application/octet-stream';
  return {
    path: toRelative(workspaceRoot, file),
    totalBytes: stats.size,
    offset: safeOffset,
    encoding: binary ? 'base64' : 'utf8',
    ...(binary ? { dataBase64: slice.toString('base64') } : { text: slice.toString('utf-8') }),
    mediaType,
    truncated,
  };
}

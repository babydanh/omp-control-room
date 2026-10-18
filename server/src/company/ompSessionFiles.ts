/**
 * The OMP session files one working folder owns, and the rules that keep every
 * read or delete of them inside a known directory.
 *
 * omp keeps one directory per working folder under its sessions root. The name
 * is derived from the canonical folder path; {@link ompSessionDirName} mirrors
 * omp's `getDefaultSessionDirName` read-only, so looking a folder up never
 * creates, migrates or moves a directory. Every path that comes from a client
 * is resolved and proven to sit inside a root by realpath before it is used,
 * so a `..` segment or a symlink cannot reach past the root.
 */
import * as fs from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import type { OmpSessionEntry } from '../../../core/src/messages.js';
import { CompanyError } from './companyError.js';

/** Most entries one listing returns; the newest come first. */
export const OMP_SESSION_LIST_LIMIT = 200;

const SESSION_FILE_EXTENSION = '.jsonl';
/** Bytes read from the head of a session file; the title sits in its first lines. */
const HEAD_BYTES = 8 * 1024;
const TITLE_MAX_CHARS = 200;

type Environment = Readonly<Record<string, string | undefined>>;

/**
 * Root of omp's session tree. Mirrors omp's agent directory: `PI_CODING_AGENT_DIR`
 * when set, else `<home>/<PI_CONFIG_DIR or .omp>/agent`. Profile overrides
 * (`PI_PROFILE`) are not mirrored; a profile-scoped install lists the default root.
 */
export function ompSessionsRoot(
  env: Environment = process.env,
  home: string = os.homedir(),
): string {
  const override = env['PI_CODING_AGENT_DIR'];
  const agentDir =
    override !== undefined && override !== ''
      ? override
      : path.join(home, env['PI_CONFIG_DIR'] ?? '.omp', 'agent');
  return path.join(agentDir, 'sessions');
}

/** Canonical path omp compares folders by: resolved, then realpath when the folder exists. */
function canonicalPath(input: string): string {
  const resolved = path.resolve(input);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

/** Whether a `path.relative` result stays at or inside its base (omp's rule, verbatim). */
function isRelativeWithin(relative: string): boolean {
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function encodeRelativeDirName(prefix: string, relative: string): string {
  const encoded = relative.replace(/[/\\:]/g, '-');
  if (encoded === '') return prefix;
  return prefix.endsWith('-') ? `${prefix}${encoded}` : `${prefix}-${encoded}`;
}

/**
 * The directory name omp gives `cwd`. The temp root is checked first, then home,
 * then the absolute fallback, matching omp's scope order.
 */
export function ompSessionDirName(
  cwd: string,
  tempRoot: string = os.tmpdir(),
  home: string = os.homedir(),
): string {
  const canonicalCwd = canonicalPath(cwd);
  const tempRelative = path.relative(canonicalPath(tempRoot), canonicalCwd);
  if (isRelativeWithin(tempRelative)) return encodeRelativeDirName('-tmp', tempRelative);
  const homeRelative = path.relative(canonicalPath(home), canonicalCwd);
  if (isRelativeWithin(homeRelative)) return encodeRelativeDirName('-', homeRelative);
  return `--${canonicalCwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
}

/** The directory omp uses for `folder`'s sessions, read-only. */
export function ompSessionDirForFolder(folder: string, root: string = ompSessionsRoot()): string {
  return path.join(root, ompSessionDirName(folder));
}

/** Key for comparing two session file paths: resolved, and case-folded on Windows. */
export function comparableOmpPath(file: string): string {
  const resolved = path.resolve(file);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

async function realpathOrUndefined(file: string): Promise<string | undefined> {
  try {
    return await fs.promises.realpath(file);
  } catch {
    return undefined;
  }
}

/** Whether `child` is strictly inside `parent`, both already canonical. */
function isStrictlyInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative !== '' && isRelativeWithin(relative);
}

/** The `title` of one session-file head line, when it carries one. */
function titleOfLine(line: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || !('type' in parsed)) return undefined;
  if (parsed.type !== 'title' && parsed.type !== 'session') return undefined;
  if (!('title' in parsed) || typeof parsed.title !== 'string') return undefined;
  const title = parsed.title.trim();
  return title === '' ? undefined : title.slice(0, TITLE_MAX_CHARS);
}

/**
 * The human title of one session file, read from its head only. omp writes it as
 * a `title` line or in the `session` header. A file that cannot be read has none.
 */
export async function readOmpSessionTitle(file: string): Promise<string | undefined> {
  let handle: FileHandle | undefined;
  try {
    handle = await fs.promises.open(file, 'r');
    const buffer = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0);
    const [first = '', second = ''] = buffer.subarray(0, bytesRead).toString('utf8').split('\n', 2);
    return titleOfLine(first) ?? titleOfLine(second);
  } catch {
    return undefined;
  } finally {
    await handle?.close();
  }
}

/**
 * List one folder's session files, newest first, capped at
 * {@link OMP_SESSION_LIST_LIMIT}. `boardSessionByFile` maps comparable paths to
 * the board session already holding that file. A missing directory lists nothing.
 */
export async function listOmpSessionFiles(
  dir: string,
  boardSessionByFile: ReadonlyMap<string, string>,
): Promise<OmpSessionEntry[]> {
  let names: string[];
  try {
    names = await fs.promises.readdir(dir);
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
  const stats = await Promise.all(
    names
      .filter((name) => name.endsWith(SESSION_FILE_EXTENSION))
      .map(async (name) => {
        const file = path.join(dir, name);
        try {
          const stat = await fs.promises.stat(file);
          return stat.isFile() ? { file, stat } : undefined;
        } catch {
          return undefined;
        }
      }),
  );
  const newest = stats
    .filter((entry): entry is { file: string; stat: fs.Stats } => entry !== undefined)
    .sort((left, right) => right.stat.mtimeMs - left.stat.mtimeMs)
    .slice(0, OMP_SESSION_LIST_LIMIT);
  return Promise.all(
    newest.map(async ({ file, stat }) => {
      const title = await readOmpSessionTitle(file);
      const boardSessionId = boardSessionByFile.get(comparableOmpPath(file));
      return {
        file,
        ...(title === undefined ? {} : { title }),
        updatedAt: stat.mtime.toISOString(),
        sizeBytes: stat.size,
        ...(boardSessionId === undefined ? {} : { boardSessionId }),
      };
    }),
  );
}

/**
 * Prove `file` is an existing `.jsonl` file inside `dir` and return its resolved
 * path. The check runs on realpaths, so a symlink or `..` that leaves `dir` is
 * refused. Failures are `CompanyError`s a client can read.
 */
export async function assertOmpSessionFileIn(file: string, dir: string): Promise<string> {
  if (!path.isAbsolute(file) || !file.toLowerCase().endsWith(SESSION_FILE_EXTENSION)) {
    throw new CompanyError(
      'omp_session_invalid',
      'Phiên OMP phải là đường dẫn tuyệt đối tới một file .jsonl.',
    );
  }
  const resolved = path.resolve(file);
  const realFile = await realpathOrUndefined(resolved);
  const realDir = await realpathOrUndefined(dir);
  // A file that does not exist has no links to follow, so its lexical path decides.
  const location = realFile ?? resolved;
  if (realDir === undefined || !isStrictlyInside(location, realDir)) {
    throw new CompanyError(
      'omp_session_outside_folder',
      'Phiên OMP này không nằm trong thư mục phiên của workspace hiện tại.',
    );
  }
  if (realFile === undefined || !(await fs.promises.stat(realFile)).isFile()) {
    throw new CompanyError('omp_session_missing', 'Không tìm thấy file phiên OMP đó.');
  }
  return resolved;
}

/**
 * Delete one session file, but only when it resolves inside one of `roots`. A
 * file outside every root, or one that is not a `.jsonl`, is left alone and the
 * call reports `false`: a path read from a record is never trusted blindly.
 */
export async function removeSessionFileWithin(
  file: string,
  roots: readonly string[],
): Promise<boolean> {
  if (!file.toLowerCase().endsWith(SESSION_FILE_EXTENSION)) return false;
  const resolved = path.resolve(file);
  const realFile = await realpathOrUndefined(resolved);
  if (realFile === undefined) return false;
  for (const root of roots) {
    const realRoot = await realpathOrUndefined(root);
    if (realRoot !== undefined && isStrictlyInside(realFile, realRoot)) {
      await fs.promises.unlink(resolved);
      return true;
    }
  }
  return false;
}

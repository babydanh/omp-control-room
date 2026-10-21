/**
 * folderScope: which open Company folder a path sits in. Herdr agents, sleeping
 * panes and ledger checkouts carry the canonical path of the deepest open folder
 * that contains their cwd, so the board can show one folder without comparing
 * spellings itself. Junctions and symlinks resolve through `realpath.native`; a
 * path that no longer exists keeps its lexical spelling.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';

import { CompanyError } from './companyError.js';

/** Resolves a path to its real location, following symlinks and Windows junctions. */
export type RealpathNative = (target: string) => Promise<string>;

type PathApi = typeof path.win32 | typeof path.posix;

export interface FolderScopeOptions {
  /** Production uses `fs.realpath.native`; tests pass a fake that models junctions. */
  readonly realpath?: RealpathNative;
  /** Path rules. Windows rules on win32 (`\` and `/` are one separator), POSIX elsewhere. */
  readonly pathApi?: PathApi;
  /** Whether two spellings differing only in case name one path. Defaults to true on win32. */
  readonly caseInsensitive?: boolean;
}

const nativeRealpath: RealpathNative = promisify(fs.realpath.native);

export class FolderScope {
  private readonly realpath: RealpathNative;
  private readonly pathApi: PathApi;
  private readonly caseInsensitive: boolean;
  /** Canonical open folders, as last set. A lookup reads the list it started with. */
  private folders: readonly string[] = [];
  /** Canonical path per input spelling. Cleared whenever the folder list changes. */
  private readonly canonicals = new Map<string, Promise<string>>();
  /** Counts folder list changes, so an older list cannot overwrite a newer one. */
  private generation = 0;

  constructor(options: FolderScopeOptions = {}) {
    this.realpath = options.realpath ?? nativeRealpath;
    this.pathApi = options.pathApi ?? (process.platform === 'win32' ? path.win32 : path.posix);
    this.caseInsensitive = options.caseInsensitive ?? process.platform === 'win32';
  }

  /**
   * Replaces the open folder list and forgets every canonical path learned so far, so a
   * junction that changed since the last list is read again.
   */
  async setFolders(workspacePaths: readonly string[]): Promise<void> {
    const generation = ++this.generation;
    this.canonicals.clear();
    const canonical = await Promise.all(
      workspacePaths.map((workspacePath) => this.canonicalOf(workspacePath)),
    );
    if (generation === this.generation) this.folders = [...new Set(canonical)];
  }

  /**
   * Canonical path of the deepest open folder that contains `target`, or undefined when it lies
   * outside every open folder. A folder contains itself. Never rejects.
   */
  async folderOf(target: string): Promise<string | undefined> {
    const folders = this.folders;
    const targetKey = this.keyOf(await this.canonicalOf(target));
    let deepest: string | undefined;
    for (const folder of folders) {
      if (!this.contains(this.keyOf(folder), targetKey)) continue;
      if (deepest === undefined || folder.length > deepest.length) deepest = folder;
    }
    return deepest;
  }

  /** The real path when the target exists, else its tidied lexical spelling. Never rejects. */
  private canonicalOf(target: string): Promise<string> {
    const key = this.keyOf(target);
    let canonical = this.canonicals.get(key);
    if (canonical === undefined) {
      canonical = this.realpath(target).then(
        (resolved) => this.tidy(resolved),
        () => this.tidy(target),
      );
      this.canonicals.set(key, canonical);
    }
    return canonical;
  }

  /** Separators normalised and no trailing separator; a root keeps its own. */
  private tidy(target: string): string {
    const normalized = this.pathApi.normalize(target);
    const root = this.pathApi.parse(normalized).root;
    return normalized.length > root.length && normalized.endsWith(this.pathApi.sep)
      ? normalized.slice(0, -1)
      : normalized;
  }

  /** Identity of a path: tidied, and lower-cased where the platform ignores case. */
  private keyOf(target: string): string {
    const tidied = this.tidy(target);
    return this.caseInsensitive ? tidied.toLowerCase() : tidied;
  }

  /** Whether `targetKey` is `folderKey` or lies under it. The separator check keeps `Project2` out of `Project`. */
  private contains(folderKey: string, targetKey: string): boolean {
    if (targetKey === folderKey) return true;
    const prefix = folderKey.endsWith(this.pathApi.sep) ? folderKey : folderKey + this.pathApi.sep;
    return targetKey.startsWith(prefix);
  }
}

/** The JS realpath. omp derives its session directory names from it, so cwd canonical forms must match. */
const jsRealpath: RealpathNative = fs.promises.realpath;

const CWD_INVALID_TEXT = 'Thư mục làm việc phải là một thư mục có thật trên máy này.';
const CWD_OUTSIDE_TEXT =
  'Thư mục làm việc phải là thư mục của workspace này hoặc nằm bên trong nó.';

async function realpathOrUndefined(
  target: string,
  realpath: RealpathNative,
): Promise<string | undefined> {
  try {
    return await realpath(target);
  } catch {
    return undefined;
  }
}

/** Whether `target` is `root` or lies under it. Both paths are canonical. */
function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  if (relative === '') return true;
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/**
 * Whether `target` belongs to the folder: under the root, or under `<root>.worktrees`, the sibling
 * directory git-wt makes a repo's worktrees in. A folder that is itself a repo keeps its worktrees
 * there, outside the root. Both paths are canonical.
 */
export function inFolder(root: string, target: string): boolean {
  return isWithin(root, target) || isWithin(`${root.replace(/[\\/]+$/, '')}.worktrees`, target);
}

/**
 * The canonical form of a working directory a folder session may run in: an existing directory
 * that is the folder root or lies inside it. Refused with `cwd_invalid` when it is missing or not
 * a directory, and with `cwd_outside_folder` when it lies outside the folder. Containment is
 * checked on realpaths, so a junction that leads out of the folder is refused too.
 */
export async function resolveFolderCwd(
  cwd: string,
  folderRoot: string,
  realpath: RealpathNative = jsRealpath,
): Promise<string> {
  const canonical = await realpathOrUndefined(cwd, realpath);
  if (canonical === undefined) throw new CompanyError('cwd_invalid', CWD_INVALID_TEXT);
  const root = (await realpathOrUndefined(folderRoot, realpath)) ?? path.resolve(folderRoot);
  if (!inFolder(root, canonical)) throw new CompanyError('cwd_outside_folder', CWD_OUTSIDE_TEXT);
  const isDirectory = await fs.promises.stat(canonical).then(
    (stat) => stat.isDirectory(),
    () => false,
  );
  if (!isDirectory) throw new CompanyError('cwd_invalid', CWD_INVALID_TEXT);
  return canonical;
}

/**
 * Canonical path of `target` when it is the folder root or lies inside it, else undefined. A path
 * that does not exist keeps its lexical spelling, so a session whose worktree was removed still
 * maps to its folder. Never rejects.
 */
export async function canonicalWithinFolder(
  target: string,
  folderRoot: string,
  realpath: RealpathNative = jsRealpath,
): Promise<string | undefined> {
  const root = (await realpathOrUndefined(folderRoot, realpath)) ?? path.resolve(folderRoot);
  const canonical = (await realpathOrUndefined(target, realpath)) ?? path.resolve(target);
  return inFolder(root, canonical) ? canonical : undefined;
}

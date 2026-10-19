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

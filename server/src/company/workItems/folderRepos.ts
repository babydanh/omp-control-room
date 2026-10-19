/**
 * Finds the git repositories and worktrees under a company folder.
 *
 * A repo is any directory with a `.git` entry: a directory for a normal clone, a file
 * for a linked worktree. The scan is breadth-first and bounded by depth. It reads
 * directory names and `.git` entries only, never repo contents.
 *
 * Disk access goes through an injected RepoScanSource, so tests can run on an
 * in-memory tree.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/** The directory probes the scan needs. Every method resolves; none is expected to throw. */
export interface RepoScanSource {
  /** Absolute child directory paths of `dir`; empty when `dir` cannot be read. */
  listDirectories(dir: string): Promise<readonly string[]>;
  /** True when `dir` has a `.git` entry, as a directory or as a file. */
  hasGitEntry(dir: string): Promise<boolean>;
  /** The real path of `candidate`, or its resolved path when the real path cannot be read. */
  canonical(candidate: string): Promise<string>;
}

/** Scans the real disk. Symbolic-linked directories are not followed. */
export const nodeRepoScanSource: RepoScanSource = {
  async listDirectories(dir) {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(dir, entry.name));
    } catch {
      return [];
    }
  },
  async hasGitEntry(dir) {
    try {
      await fs.stat(path.join(dir, '.git'));
      return true;
    } catch {
      return false;
    }
  },
  async canonical(candidate) {
    try {
      return await fs.realpath(candidate);
    } catch {
      return path.resolve(candidate);
    }
  },
};

const DEFAULT_MAX_DEPTH = 3;
const MAX_REPOS = 200;
/** Dot-directory that holds linked worktree checkouts, so it is scanned like any other. */
const WORKTREES_DIR = '.worktrees';
/** Dependency tree that never holds a repo the folder should list. */
const SKIPPED_DIR = 'node_modules';

export interface ListFolderReposOptions {
  /** How many directory levels below the folder root the scan descends. Defaults to 3. */
  maxDepth?: number;
}

/**
 * Lists the repos and worktrees under `folderRoot`, as canonical paths, sorted ascending.
 * The folder root counts when it is a repo. The scan keeps descending into repos so their
 * `.worktrees` checkouts are found. It skips `node_modules` and dot-directories other than
 * `.worktrees`. At most 200 paths are returned.
 */
export async function listFolderRepos(
  folderRoot: string,
  source: RepoScanSource = nodeRepoScanSource,
  options: ListFolderReposOptions = {},
): Promise<string[]> {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const repos = new Set<string>();
  let level: readonly string[] = [folderRoot];

  for (let depth = 0; depth <= maxDepth && level.length > 0; depth += 1) {
    const next: string[] = [];
    for (const dir of level) {
      if (await source.hasGitEntry(dir)) {
        repos.add(await source.canonical(dir));
      }
      if (depth < maxDepth) {
        for (const child of await source.listDirectories(dir)) {
          if (isScannedDirectory(child)) next.push(child);
        }
      }
    }
    level = next;
  }

  return [...repos].sort().slice(0, MAX_REPOS);
}

function isScannedDirectory(dir: string): boolean {
  const name = path.basename(dir);
  if (name === SKIPPED_DIR) return false;
  return !name.startsWith('.') || name === WORKTREES_DIR;
}

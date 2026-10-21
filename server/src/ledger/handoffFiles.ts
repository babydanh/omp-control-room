/**
 * Handoff files: the note an agent leaves on a branch for whoever picks the work up next.
 * One per piece of work, at `openspec/changes/<id>/handoff.md` when the work has an OpenSpec
 * change, otherwise `HANDOFF.md` at the worktree root. Archived changes are finished work.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/** Bytes read from each file; a handoff note is a page or two. */
export const HANDOFF_MAX_BYTES = 65_536;

export interface HandoffFile {
  /** Relative to the worktree, with forward slashes. */
  readonly path: string;
  readonly modifiedAt: Date;
  readonly text: string;
  /** The file is longer than `HANDOFF_MAX_BYTES`. */
  readonly truncated: boolean;
}

/** Every handoff file of `worktree`, root `HANDOFF.md` first. Unreadable files are skipped. */
export async function readHandoffFiles(worktree: string): Promise<HandoffFile[]> {
  const changes = path.join(worktree, 'openspec', 'changes');
  const entries = await fs.readdir(changes, { withFileTypes: true }).catch(() => []);
  const candidates = [
    path.join(worktree, 'HANDOFF.md'),
    ...entries
      .filter((entry) => entry.isDirectory() && entry.name !== 'archive')
      .map((entry) => path.join(changes, entry.name, 'handoff.md')),
  ];
  const files = await Promise.all(candidates.map((file) => readOne(worktree, file)));
  return files.filter((file): file is HandoffFile => file !== null);
}

async function readOne(worktree: string, file: string): Promise<HandoffFile | null> {
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(file, 'r');
  } catch {
    return null;
  }
  try {
    const stat = await handle.stat();
    const buffer = Buffer.alloc(Math.min(stat.size, HANDOFF_MAX_BYTES));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return {
      path: path.relative(worktree, file).replaceAll(path.sep, '/'),
      modifiedAt: stat.mtime,
      text: buffer.subarray(0, bytesRead).toString('utf8'),
      truncated: stat.size > HANDOFF_MAX_BYTES,
    };
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}

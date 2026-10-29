import type { Dirent } from 'node:fs';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import type { LedgerOpenSpecChange, LedgerOpenSpecFileName } from '../../../core/src/messages.js';

const MAX_OPEN_SPEC_FILE_BYTES = 256 * 1024;
const CHANGE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const OPEN_SPEC_FILES: Record<LedgerOpenSpecFileName, true> = {
  'proposal.md': true,
  'tasks.md': true,
  'handoff.md': true,
};

export interface OpenSpecWorktreeSource {
  readonly repo: string;
  readonly repoName: string;
  readonly worktree: string;
  readonly worktreeName: string;
  readonly branch: string | null;
}

export interface OpenSpecTaskProgress {
  readonly completed: number;
  readonly total: number;
  readonly percent: number | null;
}

export async function listOpenSpecChanges(
  worktrees: readonly OpenSpecWorktreeSource[],
): Promise<LedgerOpenSpecChange[]> {
  const unique = new Map<string, OpenSpecWorktreeSource>();
  for (const worktree of worktrees) {
    if (worktree.worktree === '') continue;
    const absolutePath = resolve(worktree.worktree);
    const key = process.platform === 'win32' ? absolutePath.toLocaleLowerCase('en-US') : absolutePath;
    if (!unique.has(key)) unique.set(key, { ...worktree, worktree: absolutePath });
  }

  const changes: LedgerOpenSpecChange[] = [];
  for (const worktree of unique.values()) {
    const openSpecDirectory = join(worktree.worktree, 'openspec');
    const changesDirectory = join(openSpecDirectory, 'changes');
    if (
      !(await isDirectory(worktree.worktree)) ||
      !(await isDirectory(openSpecDirectory)) ||
      !(await isDirectory(changesDirectory))
    ) continue;
    let entries: Dirent[];
    try {
      entries = await readdir(changesDirectory, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isDirectory() || !CHANGE_ID_PATTERN.test(entry.name)) continue;
      const changeDirectory = join(changesDirectory, entry.name);
      const [proposal, tasks, handoff] = await Promise.all([
        readMarkdownFile(join(changeDirectory, 'proposal.md')),
        readMarkdownFile(join(changeDirectory, 'tasks.md')),
        readMarkdownFile(join(changeDirectory, 'handoff.md')),
      ]);
      const progress = parseOpenSpecTasks(tasks ?? '');
      changes.push({
        repo: worktree.repo,
        repoName: worktree.repoName,
        worktree: worktree.worktree,
        worktreeName: worktree.worktreeName,
        branch: worktree.branch,
        id: entry.name,
        summary: proposal === null ? '—' : proposalSummary(proposal),
        completedTasks: progress.completed,
        totalTasks: progress.total,
        progressPercent: progress.percent,
        hasProposal: proposal !== null,
        hasTasks: tasks !== null,
        hasHandoff: handoff !== null,
      });
    }
  }
  return changes;
}

export function parseOpenSpecTasks(contents: string): OpenSpecTaskProgress {
  let inFence = false;
  let fenceCharacter = '';
  let fenceLength = 0;
  let completed = 0;
  let total = 0;
  for (const line of contents.split(/\r?\n/)) {
    const fence = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence !== null) {
      const marker = fence[1][0];
      if (!inFence) {
        inFence = true;
        fenceCharacter = marker;
        fenceLength = fence[1].length;
      } else if (marker === fenceCharacter && fence[1].length >= fenceLength && fence[2].trim() === '') {
        inFence = false;
        fenceCharacter = '';
        fenceLength = 0;
      }
      continue;
    }
    if (inFence) continue;
    const task = /^\s*[-*+]\s+\[([ xX])\](?:\s|$)/.exec(line);
    if (task === null) continue;
    total += 1;
    if (task[1].toLowerCase() === 'x') completed += 1;
  }
  return {
    completed,
    total,
    percent: total === 0 ? null : Math.round((completed / total) * 100),
  };
}

export async function readOpenSpecFile(
  worktree: string,
  changeId: string,
  file: string,
): Promise<string | null> {
  if (!CHANGE_ID_PATTERN.test(changeId) || !isOpenSpecFileName(file)) return null;
  const openSpecDirectory = join(worktree, 'openspec');
  const changesDirectory = join(openSpecDirectory, 'changes');
  if (
    !(await isDirectory(worktree)) ||
    !(await isDirectory(openSpecDirectory)) ||
    !(await isDirectory(changesDirectory))
  ) return null;
  const changeDirectory = join(changesDirectory, changeId);
  if (!(await isDirectory(changeDirectory))) return null;
  return readMarkdownFile(join(changeDirectory, file));
}


export function isOpenSpecFileName(value: unknown): value is LedgerOpenSpecFileName {
  return typeof value === 'string' && Object.hasOwn(OPEN_SPEC_FILES, value);
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function readMarkdownFile(path: string): Promise<string | null> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.size > MAX_OPEN_SPEC_FILE_BYTES) return null;
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

function proposalSummary(proposal: string): string {
  const lines = proposal.split(/\r?\n/);
  const summaryHeading = lines.findIndex((line) => /^##\s+(summary|why|overview)\b/i.test(line.trim()));
  let start = summaryHeading >= 0 ? summaryHeading + 1 : 0;
  while (start < lines.length && (lines[start].trim() === '' || /^#{1,6}\s/.test(lines[start].trim()))) {
    start += 1;
  }
  const paragraph: string[] = [];
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (line === '' || /^#{1,6}\s/.test(line)) {
      if (paragraph.length > 0) break;
      continue;
    }
    paragraph.push(line.replace(/^[-*+]\s+/, ''));
  }
  const summary = paragraph.join(' ').replace(/\s+/g, ' ').trim();
  if (summary.length <= 240) return summary || '—';
  return `${summary.slice(0, 237).trimEnd()}…`;
}

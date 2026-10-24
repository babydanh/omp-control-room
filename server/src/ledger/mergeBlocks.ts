import * as fs from 'node:fs';
import * as path from 'node:path';

import type { LedgerMergeBlock } from '../../../core/src/messages.js';
import { LEDGER_GIT_MAX_BYTES, LEDGER_GIT_TIMEOUT_MS } from './constants.js';
import type { GitRunner } from './git.js';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const CONFLICT_FILE = /^conflict-.+-(\d{8}-\d{6})\.md$/;
interface CacheEntry {
  readonly directory: string;
  readonly mtimeMs: number | null;
  readonly blocks: readonly LedgerMergeBlock[];
}

export class MergeBlockCache {
  private readonly cache = new Map<string, CacheEntry>();
  /** A repo's common git dir never moves: asked once, not on every ledger tick. */
  private readonly commonDirs = new Map<string, string | null>();

  async read(git: GitRunner, repo: string, nowMs: number): Promise<readonly LedgerMergeBlock[]> {
    const key = repo.toLowerCase();
    let commonDir = this.commonDirs.get(key);
    if (commonDir === undefined) {
      const commonDirResult = await git.run(
        repo,
        ['rev-parse', '--git-common-dir'],
        { timeoutMs: LEDGER_GIT_TIMEOUT_MS, okCodes: [0], maxBytes: LEDGER_GIT_MAX_BYTES },
      );
      commonDir =
        commonDirResult.ok && commonDirResult.stdout.trim() !== ''
          ? path.resolve(repo, commonDirResult.stdout.trim())
          : fallbackCommonDir(repo);
      // Only a git answer is kept; after a failed call the next tick asks again.
      if (commonDirResult.ok) this.commonDirs.set(key, commonDir);
    }
    if (commonDir === null) return [];
    const directory = path.join(commonDir, 'merge-lane');
    let mtimeMs: number | null = null;
    try {
      mtimeMs = fs.statSync(directory).mtimeMs;
    } catch {
      // No merge briefs have been written for this repository.
    }
    const cached = this.cache.get(key);
    if (cached !== undefined && cached.directory === directory && cached.mtimeMs === mtimeMs) {
      return cached.blocks.filter((block) => {
        const timestamp = Date.parse(block.at);
        return nowMs - timestamp <= SEVEN_DAYS_MS && timestamp <= nowMs;
      });
    }

    const blocks = mtimeMs === null ? [] : readBriefs(directory, repo, nowMs);
    this.cache.set(key, { directory, mtimeMs, blocks });
    return blocks;
  }
}

function readBriefs(directory: string, repo: string, nowMs: number): LedgerMergeBlock[] {
  let names: string[];
  try {
    names = fs.readdirSync(directory).filter((name) => CONFLICT_FILE.test(name));
  } catch {
    return [];
  }

  const newest = new Map<string, LedgerMergeBlock>();
  for (const name of names) {
    const match = CONFLICT_FILE.exec(name);
    if (match === null) continue;
    const at = timestampOf(match[1]);
    if (at === null || nowMs - Date.parse(at) > SEVEN_DAYS_MS || Date.parse(at) > nowMs) continue;
    const briefPath = path.join(directory, name);
    let content: string;
    try {
      content = fs.readFileSync(briefPath, 'utf8');
    } catch {
      continue;
    }
    const branchMatch = /^# Xung dot khi rebase `([^`]+)` len /m.exec(content);
    if (branchMatch === null) continue;
    const files: string[] = [];
    for (const line of content.split(/\r?\n/)) {
      if (line.startsWith('## Cach go')) break;
      const fileMatch = /^## (.+)$/.exec(line);
      if (fileMatch !== null && fileMatch[1] !== 'Cach go') files.push(fileMatch[1]);
    }
    const branch = branchMatch[1];
    const previous = newest.get(branch);
    if (previous === undefined || previous.at < at) {
      newest.set(branch, { repo, branch, at, briefPath, files });
    }
  }
  return [...newest.values()].sort((a, b) => a.branch.localeCompare(b.branch));
}

function timestampOf(value: string): string | null {
  const year = value.slice(0, 4);
  const month = value.slice(4, 6);
  const day = value.slice(6, 8);
  const hour = value.slice(9, 11);
  const minute = value.slice(11, 13);
  const second = value.slice(13, 15);
  const local = new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
  if (
    local.getFullYear() !== Number(year) ||
    local.getMonth() !== Number(month) - 1 ||
    local.getDate() !== Number(day) ||
    local.getHours() !== Number(hour) ||
    local.getMinutes() !== Number(minute) ||
    local.getSeconds() !== Number(second)
  ) return null;
  return local.toISOString();
}
function fallbackCommonDir(repo: string): string | null {
  const gitDirectory = path.join(repo, '.git');
  try {
    return fs.statSync(gitDirectory).isDirectory() ? gitDirectory : null;
  } catch {
    return null;
  }
}

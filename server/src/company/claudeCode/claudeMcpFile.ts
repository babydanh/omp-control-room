/**
 * The temporary file a worker run's `--mcp-config` points at. The config can carry secrets, so it
 * lives in a file rather than in argv, where any local process listing would show it. One file per
 * run, readable by this user only on POSIX.
 *
 * Nothing here logs the content or the path.
 */

import { randomUUID } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { isRecord } from '../typeGuards.js';

/** Start of every run's config file name, so a stray file is easy to recognise. */
export const CLAUDE_MCP_FILE_PREFIX = 'pixel-agents-claude-mcp-';

/**
 * A new path in the OS temp directory for one run's config. The name carries the run id, with any
 * character outside `[A-Za-z0-9_-]` replaced, and a random part so two runs never share a name.
 * Pure: it touches nothing on disk.
 */
export function newClaudeMcpConfigPath(runId: string): string {
  const safeId = runId.replace(/[^A-Za-z0-9_-]/g, '_');
  return join(tmpdir(), `${CLAUDE_MCP_FILE_PREFIX}${safeId}-${randomUUID()}.json`);
}

/**
 * Creates the config file at `path` with the run's JSON. The exclusive flag refuses an existing
 * file, so a name is never overwritten, and mode 0600 keeps it to this user on POSIX. Throws when
 * the file cannot be created; a caller then removes whatever was left.
 */
export function writeClaudeMcpConfigFile(path: string, json: string): void {
  writeFileSync(path, json, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
}

/**
 * Removes a run's config file. A file already gone is not an error. Any other failure is logged by
 * error code only, never by path or content, and does not throw: ending a run must not fail on it.
 */
export function removeClaudeMcpConfigFile(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch (error) {
    const code = isRecord(error) && typeof error.code === 'string' ? error.code : 'unknown';
    console.warn(`[company] could not remove a temporary MCP config file (${code})`);
  }
}

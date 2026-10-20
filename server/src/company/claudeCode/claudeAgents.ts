/**
 * The Claude Code subagent names a folder can use: the agent files under the user's and the
 * folder's `.claude/agents`. Read from disk, best effort: a missing directory contributes none.
 *
 * A name is the agent file's base name. Claude Code reads the agent's `name` field, which is
 * normally the same; a file whose `name` differs is not matched, and the item then runs with the
 * role line in its prompt instead of `--agent`.
 */

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

/** Where the agent files may be: the user's home and the folder root. */
export interface ClaudeAgentSources {
  readonly homeDir: string;
  readonly folderRoot: string;
}

const AGENT_FILE_SUFFIX = '.md';

/** Base names of the `.md` files in one directory. A missing or unreadable directory gives none. */
async function agentNamesIn(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(AGENT_FILE_SUFFIX))
      .map((entry) => entry.name.slice(0, -AGENT_FILE_SUFFIX.length));
  } catch {
    return [];
  }
}

/** The Claude Code subagent names visible to a folder: sorted, without repeats. */
export async function loadClaudeAgentNames(sources: ClaudeAgentSources): Promise<string[]> {
  const found = await Promise.all([
    agentNamesIn(join(sources.homeDir, '.claude', 'agents')),
    agentNamesIn(join(sources.folderRoot, '.claude', 'agents')),
  ]);
  return [...new Set(found.flat())].sort();
}

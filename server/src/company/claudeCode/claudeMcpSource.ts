/**
 * Reads the user's Claude config for the MCP servers a squad may hand a worker run. The file is
 * parsed again only when its size or modification time changes, so a snapshot that lists names
 * does not parse it each time. A missing or unreadable file defines no server.
 *
 * Nothing here logs. A parse error can quote the file's text, so it is dropped unread.
 */

import { readFileSync, statSync } from 'node:fs';

import { CLAUDE_MCP_NAMES_MAX, claudeMcpConfigJson, claudeMcpServerNames } from './claudeMcp.js';

/** What a squad asks of the user's Claude config for worker runs. */
export interface ClaudeMcpSource {
  /** The server names the config defines for these project paths and the top level, sorted and capped. */
  names(projectPaths: readonly string[]): string[];
  /** The `--mcp-config` JSON for a worker run in `projectPath` that loads these servers and no others. */
  configFor(projectPath: string, names: readonly string[]): string;
}

export interface ClaudeMcpSourceOptions {
  /** The config file, `.claude.json` in the user's home folder. */
  readonly configPath: string;
}

export function createClaudeMcpSource(options: ClaudeMcpSourceOptions): ClaudeMcpSource {
  let held: { readonly stamp: string; readonly config: unknown } | undefined;

  /** The config as it is on disk now: undefined when the file is missing or is not JSON. */
  function config(): unknown {
    let stamp: string;
    try {
      const stat = statSync(options.configPath);
      stamp = `${stat.size}:${stat.mtimeMs}`;
    } catch {
      held = undefined;
      return undefined;
    }
    if (held?.stamp === stamp) return held.config;
    const parsed = parseConfig(options.configPath);
    held = { stamp, config: parsed };
    return parsed;
  }

  return {
    names: (projectPaths) =>
      claudeMcpServerNames(config(), projectPaths).slice(0, CLAUDE_MCP_NAMES_MAX),
    configFor: (projectPath, names) => claudeMcpConfigJson(config(), projectPath, names),
  };
}

function parseConfig(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    return undefined;
  }
}

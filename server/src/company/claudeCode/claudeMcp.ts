/**
 * The MCP servers a Claude Code worker run may load. The user's Claude config (`~/.claude.json`)
 * defines them at the top level and per project. The squad lists the names; a run's config file
 * carries the chosen entries copied verbatim, and no other server.
 *
 * An entry that writes a credential inline is never listed or copied: it has `headers`, or an `env`
 * variable whose name looks like a credential. A `headersHelper` command fetches its headers when the
 * run starts, so it is kept.
 *
 * Pure: no I/O. An entry is read only to copy it. Nothing here logs or returns an entry for display.
 */

import { isRecord } from '../typeGuards.js';

/** Longest server name the squad keeps, in characters. A name is a key of the user's config. */
export const CLAUDE_MCP_NAME_MAX_CHARS = 64;

/** Most names the squad lists for one folder. */
export const CLAUDE_MCP_NAMES_MAX = 200;

/** Environment variable names that look like a credential, matched anywhere in the name, any case. */
const CREDENTIAL_ENV_NAME = /TOKEN|KEY|SECRET|PASSWORD|PAT|AUTH|CREDENTIAL/i;

/** An argument that names or carries a credential: a credential-like flag or a known token prefix. */
const CREDENTIAL_ARG = /token|secret|password|passwd|api[-_]?key|auth|bearer|ghp_|gho_|github_pat_|sk-/i;

/** Whether a URL carries a credential inline: user info before the host, or any query string. */
function urlHasCredential(url: unknown): boolean {
  if (typeof url !== 'string') return false;
  return url.includes('?') || /^[a-z][a-z0-9+.-]*:\/\/[^/]*@/i.test(url);
}

/** Whether a value is a server name the squad keeps: a non-empty string up to the length limit. */
export function isClaudeMcpServerName(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length >= 1 && value.length <= CLAUDE_MCP_NAME_MAX_CHARS
  );
}

/**
 * Whether a server entry may be listed and copied. An object with `headers` is refused, since its
 * header values sit in the config. So is one whose `env` has a credential-like name, whose `url`
 * has user info or a query string, or whose `args` look like they carry a credential. A value
 * that is not an object is refused.
 */
export function isShareableEntry(entry: unknown): boolean {
  if (!isRecord(entry)) return false;
  if (Object.hasOwn(entry, 'headers')) return false;
  if (urlHasCredential(entry.url)) return false;
  if (Array.isArray(entry.args) && entry.args.some((a) => typeof a === 'string' && CREDENTIAL_ARG.test(a))) {
    return false;
  }
  if (!isRecord(entry.env)) return true;
  return !Object.keys(entry.env).some((name) => CREDENTIAL_ENV_NAME.test(name));
}

/** The `mcpServers` table of an object, or none when it has no such table. */
function serversOf(owner: unknown): Record<string, unknown> {
  if (!isRecord(owner) || !isRecord(owner.mcpServers)) return {};
  return owner.mcpServers;
}

/**
 * A project path in the form the config keys it by: forward slashes, no trailing slash, and case
 * folded on Windows, whose paths do not depend on case.
 */
function projectKey(path: string): string {
  const slashed = path.replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? slashed.toLowerCase() : slashed;
}

/** The config's per-project entries, keyed by their normalized project path. */
function projectIndex(config: unknown): Map<string, Record<string, unknown>> {
  const index = new Map<string, Record<string, unknown>>();
  if (!isRecord(config) || !isRecord(config.projects)) return index;
  for (const [path, entry] of Object.entries(config.projects)) {
    const key = projectKey(path);
    if (!index.has(key)) index.set(key, serversOf(entry));
  }
  return index;
}

/**
 * The servers a run in `projectPath` sees: the top level, with each name replaced by the project's
 * own entry when it has one, since a project's entry overrides the user's.
 */
function visibleServers(config: unknown, projectPath: string): Record<string, unknown> {
  const project = projectIndex(config).get(projectKey(projectPath)) ?? {};
  return { ...serversOf(config), ...project };
}

/**
 * The server names a run in these project paths can load, sorted. A name counts only when the entry
 * a run would load is shareable. Names the squad cannot keep are left out.
 */
export function claudeMcpServerNames(config: unknown, projectPaths: readonly string[]): string[] {
  const views =
    projectPaths.length === 0
      ? [serversOf(config)]
      : projectPaths.map((path) => visibleServers(config, path));
  const names = new Set<string>();
  for (const view of views) {
    for (const [name, entry] of Object.entries(view)) {
      if (isShareableEntry(entry)) names.add(name);
    }
  }
  return [...names].filter(isClaudeMcpServerName).sort();
}

/**
 * The `--mcp-config` JSON for a worker run in `projectPath`. Each chosen name is copied verbatim from
 * the entry the run would load, the project's own else the top level's, and only when that entry is
 * shareable. A chosen name the config does not define, or whose entry carries a credential, is left
 * out. The JSON carries no other server, so `--strict-mcp-config` loads exactly these.
 */
export function claudeMcpConfigJson(
  config: unknown,
  projectPath: string,
  names: readonly string[],
): string {
  const visible = visibleServers(config, projectPath);
  const chosen: [string, unknown][] = [];
  for (const name of new Set(names)) {
    if (Object.hasOwn(visible, name) && isShareableEntry(visible[name])) {
      chosen.push([name, visible[name]]);
    }
  }
  return JSON.stringify({ mcpServers: Object.fromEntries(chosen) });
}

import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { LibraryMcpServer } from '../../../core/src/messages.js';
import { LibraryUserError } from './libraryError.js';

const MCP_CHECK_TIMEOUT_MS = 60_000;
const MCP_CHECK_MAX_BUFFER = 1024 * 1024;
const MCP_FILE_ERROR = 'Không đọc được tệp cấu hình MCP.';
const MCP_CHECK_ERROR = 'Không thể kiểm tra kết nối MCP bằng Claude.';

const latestStatuses = new Map<string, LibraryMcpServer['status']>();
const latestReasons = new Map<string, string>();
const latestSourceReasons = new Map<string, string>();

export type ToolName = LibraryMcpServer['tools'][number];
export type McpCandidate = { readonly name: string; readonly tools: readonly ToolName[]; readonly transport: LibraryMcpServer['transport']; readonly commandName?: string; readonly endpoint?: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function commandBasename(command: string): string {
  return path.posix.basename(command.replaceAll('\\', '/'));
}

function safeEndpoint(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return undefined;
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return undefined;
  }
}

function candidate(name: string, value: unknown, tool: ToolName): McpCandidate | undefined {
  if (!isRecord(value)) return undefined;
  const command = typeof value.command === 'string' ? value.command : undefined;
  const endpoint = safeEndpoint(value.url);
  const type = typeof value.type === 'string' ? value.type.toLowerCase() : '';
  const transport: LibraryMcpServer['transport'] = command
    ? 'stdio'
    : type === 'sse' || type === 'http-sse' || (typeof value.url === 'string' && /\/sse(?:[?#]|$)/i.test(value.url))
      ? 'sse'
      : 'http';
  if (!command && !endpoint) return undefined;
  return {
    name,
    tools: [tool],
    transport,
    ...(command ? { commandName: commandBasename(command) } : {}),
    ...(endpoint ? { endpoint } : {}),
  };
}

/** Converts untrusted MCP config into the deliberately narrow public model. */
export function parseMcpServers(value: unknown, tool: ToolName): McpCandidate[] {
  if (!isRecord(value)) return [];
  const servers = isRecord(value.mcpServers) ? value.mcpServers : value;
  return Object.entries(servers).flatMap(([name, config]) => {
    const item = candidate(name, config, tool);
    return item ? [item] : [];
  });
}

/** Parses a source file before applying the public-field allowlist. */
export function parseMcpJson(source: string, tool: ToolName): McpCandidate[] {
  return parseMcpServers(JSON.parse(source) as unknown, tool);
}

/** Parses only the status marker and name; raw CLI output must never leave this module. */
export function parseClaudeMcpList(output: string): Map<string, LibraryMcpServer['status']> {
  const statuses = new Map<string, LibraryMcpServer['status']>();
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*(.+?):\s*.*-\s*(√\s*Connected|✗.*|!\s*Needs authentication.*)\s*$/i.exec(line);
    if (!match) continue;
    const marker = match[2];
    statuses.set(match[1].trim(), marker.startsWith('√') ? 'connected' : 'error');
  }
  return statuses;
}

async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(file, 'utf8')) as unknown;
}

async function addFileSource(
  file: string,
  tool: ToolName,
  results: McpCandidate[],
  sourceLabel: string,
): Promise<void> {
  try {
    results.push(...parseMcpJson(await fs.readFile(file, 'utf8'), tool));
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return;
    latestSourceReasons.set(sourceLabel, MCP_FILE_ERROR);
    console.warn(`${MCP_FILE_ERROR} (${sourceLabel})`);
  }
}

async function enabledClaudePluginConfigs(home: string): Promise<string[]> {
  const settingsFile = path.join(home, '.claude', 'settings.json');
  let settings: unknown;
  try {
    settings = await readJson(settingsFile);
  } catch {
    return [];
  }
  if (!isRecord(settings) || !isRecord(settings.enabledPlugins)) return [];
  const cache = path.join(home, '.claude', 'plugins', 'cache');
  const configs: string[] = [];
  let marketplaces: string[];
  try {
    marketplaces = await fs.readdir(cache);
  } catch {
    return [];
  }
  for (const [pluginId, enabled] of Object.entries(settings.enabledPlugins)) {
    if (enabled !== true) continue;
    const pluginName = pluginId.split('@')[0];
    for (const marketplace of marketplaces) {
      const pluginRoot = path.join(cache, marketplace, pluginName);
      let versions: string[];
      try {
        versions = await fs.readdir(pluginRoot);
      } catch {
        continue;
      }
      for (const version of versions) {
        configs.push(path.join(pluginRoot, version, '.mcp.json'));
      }
    }
  }
  return configs;
}

export function mergeMcpCandidates(candidates: readonly McpCandidate[]): LibraryMcpServer[] {
  const merged = new Map<string, LibraryMcpServer>();
  for (const item of candidates) {
    const prior = merged.get(item.name);
    const tools = prior ? [...new Set([...prior.tools, ...item.tools])] : [...item.tools];
    const commandName = prior?.commandName ?? item.commandName;
    const endpoint = prior?.endpoint ?? item.endpoint;
    merged.set(item.name, {
      name: item.name,
      tools,
      transport: prior?.transport ?? item.transport,
      status: latestStatuses.get(item.name) ?? 'unchecked',
      ...(commandName ? { commandName } : {}),
      ...(endpoint ? { endpoint } : {}),
    });
  }
  return [...merged.values()];
}

export async function readMcpServers(refresh: boolean): Promise<LibraryMcpServer[]> {
  void refresh;
  latestSourceReasons.clear();
  const home = os.homedir();
  const candidates: McpCandidate[] = [];
  await addFileSource(path.join(home, '.omp', 'agent', 'mcp.json'), 'omp', candidates, '~/.omp/agent/mcp.json');
  const claudeFile = path.join(home, '.claude.json');
  try {
    const claude = await readJson(claudeFile);
    if (!isRecord(claude)) throw new Error('invalid');
    candidates.push(...parseMcpServers(claude.mcpServers, 'claude'));
    if (isRecord(claude.projects)) {
      for (const [projectPath, project] of Object.entries(claude.projects)) {
        if (!isRecord(project)) continue;
        const shortName = path.basename(projectPath) || projectPath;
        candidates.push(...parseMcpServers(project.mcpServers, 'claude').map((item) => ({
          ...item,
          name: `${item.name} (${shortName})`,
        })));
      }
    }
  } catch (error) {
    if (!(isRecord(error) && error.code === 'ENOENT')) {
      latestSourceReasons.set('~/.claude.json', MCP_FILE_ERROR);
      console.warn(`${MCP_FILE_ERROR} (~/.claude.json)`);
    }
  }
  for (const pluginFile of await enabledClaudePluginConfigs(home)) {
    await addFileSource(pluginFile, 'claude', candidates, 'Claude plugin .mcp.json');
  }
  await addFileSource(path.join(home, '.gemini', 'config', 'mcp_config.json'), 'agy', candidates, '~/.gemini/config/mcp_config.json');
  return mergeMcpCandidates(candidates);
}

export function mcpSourceReason(): string | undefined {
  if (latestSourceReasons.size === 0) return undefined;
  return `Đã bỏ qua cấu hình MCP không hợp lệ: ${[...latestSourceReasons.keys()].join(', ')}.`;
}

export async function checkMcpConnection(name: string): Promise<void> {
  const servers = await readMcpServers(false);
  const selected = servers.find((server) => server.name === name);
  if (!selected) throw new LibraryUserError('Không tìm thấy máy chủ MCP cần kiểm tra.');
  const claudeServers = servers.filter((server) => server.tools.includes('claude'));
  const run = await new Promise<{ error: Error | null; stdout: string; stderr: string }>((resolve) => {
    execFile('claude', ['mcp', 'list'], {
      windowsHide: true,
      timeout: MCP_CHECK_TIMEOUT_MS,
      maxBuffer: MCP_CHECK_MAX_BUFFER,
      encoding: 'utf8',
    }, (error, stdout, stderr) => resolve({
      error,
      stdout: typeof stdout === 'string' ? stdout : '',
      stderr: typeof stderr === 'string' ? stderr : '',
    }));
  });
  if (run.error) {
    for (const server of claudeServers) {
      latestStatuses.set(server.name, 'error');
      latestReasons.set(server.name, MCP_CHECK_ERROR);
    }
    throw new LibraryUserError(MCP_CHECK_ERROR);
  }
  const statuses = parseClaudeMcpList(run.stdout);
  for (const server of claudeServers) {
    const status = statuses.get(server.name);
    if (status) {
      latestStatuses.set(server.name, status);
      latestReasons.delete(server.name);
    } else {
      latestStatuses.set(server.name, 'unchecked');
      latestReasons.set(server.name, 'Claude không trả trạng thái cho máy chủ MCP này.');
    }
  }
  if (!claudeServers.some((server) => server.name === name)) {
    latestStatuses.set(name, 'unchecked');
    latestReasons.set(name, 'Chỉ có ở omp hoặc agy; chưa thể kiểm tra bằng Claude.');
  }
}

/**
 * agentInfoView: an agent's info (folders, model, tools, MCP servers, skills, usage)
 * as the Thông tin tab shows it, as pure data.
 *
 * Every grouping, ordering, and "what is unknown" line the tab prints is decided
 * here, so the rules are tested without a DOM. A section the source did not report
 * says so; it is never hidden.
 */

import type {
  AgentInfo,
  AgentSkillInfo,
  AgentToolInfo,
  AgentToolUsage,
} from '../../../core/src/company.js';
import { formatLogTime } from './sessionLogView.js';

/** Where an agent's info came from, in words a user can read. */
export const INFO_SOURCE_LABEL: Readonly<Record<AgentInfo['collectedFrom'], string>> = {
  live: 'phiên đang chạy',
  transcript: 'nhật ký phiên',
  herdr: 'herdr',
};

const UNKNOWN_MCP_SERVER = 'không rõ máy chủ';

/** How many of the most-used tools the usage section draws. */
export const USAGE_BAR_LIMIT = 10;

const MCP_TOOL_PREFIX = 'mcp__';

/**
 * The MCP server of each MCP tool, read from all of the agent's MCP tool names
 * together. OMP names a tool `mcp__<server>_<tool>` with the server sanitised
 * to underscores, and neither the live session nor a transcript reports the
 * server itself, so "first underscore" turned `botkeep_cloud` into `botkeep`.
 * Tools that share their first word share a server, and the server is the
 * longest word prefix they all have while each still keeps a tool name. A
 * server with a single tool keeps the name the source guessed.
 */
export function inferMcpServers(tools: readonly AgentToolInfo[]): Map<string, string> {
  const byFirstWord = new Map<string, { name: string; words: string[] }[]>();
  for (const tool of tools) {
    if (tool.source !== 'mcp' || !tool.name.startsWith(MCP_TOOL_PREFIX)) continue;
    const words = tool.name.slice(MCP_TOOL_PREFIX.length).split('_');
    const first = words[0] ?? '';
    byFirstWord.set(first, [...(byFirstWord.get(first) ?? []), { name: tool.name, words }]);
  }
  const servers = new Map<string, string>();
  for (const members of byFirstWord.values()) {
    if (members.length < 2) continue;
    const shortest = Math.min(...members.map((member) => member.words.length));
    let shared = 0;
    while (
      shared < shortest - 1 &&
      members.every((member) => member.words[shared] === members[0]?.words[shared])
    ) {
      shared += 1;
    }
    const server = members[0]?.words.slice(0, Math.max(shared, 1)).join('_') ?? '';
    for (const member of members) servers.set(member.name, server);
  }
  return servers;
}

function serverOf(tool: AgentToolInfo, inferred: Map<string, string>): string {
  return inferred.get(tool.name) || tool.mcpServer || UNKNOWN_MCP_SERVER;
}

/** Orders names the way a person reads them: "tool2" before "tool10". */
function compareNames(a: string, b: string): number {
  return a.localeCompare(b, 'en', { numeric: true });
}

/** "Lấy từ phiên đang chạy lúc 10:21:03": where and when the info was read. */
export function collectedLine(info: AgentInfo): string {
  return `Lấy từ ${INFO_SOURCE_LABEL[info.collectedFrom]} lúc ${formatLogTime(info.collectedAt)}`;
}

/** The folder the agent works in: its current cwd, else the folder it launched in. */
export function workingFolder(info: AgentInfo): string | null {
  return info.cwd || info.launchCwd || null;
}

/** "model · thinking", with each part named as unknown when the source did not report it. */
export function modelLine(info: AgentInfo): string {
  const model = info.model ?? 'chưa rõ';
  return info.thinking ? `${model} · ${info.thinking}` : model;
}

export interface ToolGroup {
  /** Stable key: the source, or `mcp:<server>` for one MCP server. */
  key: string;
  label: string;
  /** Active tools first, then by name. */
  tools: AgentToolInfo[];
  activeCount: number;
}

function toolGroup(key: string, label: string, tools: AgentToolInfo[]): ToolGroup {
  const sorted = [...tools].sort(
    (a, b) => Number(b.active) - Number(a.active) || compareNames(a.name, b.name),
  );
  return { key, label, tools: sorted, activeCount: sorted.filter((tool) => tool.active).length };
}

/**
 * Tools grouped by where they come from, in reading order: Builtin, Extension, one
 * group per MCP server, SDK, then anything else. Empty groups are dropped.
 */
export function groupToolsBySource(tools: readonly AgentToolInfo[]): ToolGroup[] {
  const builtin: AgentToolInfo[] = [];
  const extension: AgentToolInfo[] = [];
  const sdk: AgentToolInfo[] = [];
  const other: AgentToolInfo[] = [];
  const mcp = new Map<string, AgentToolInfo[]>();
  const inferred = inferMcpServers(tools);
  for (const tool of tools) {
    switch (tool.source) {
      case 'builtin':
        builtin.push(tool);
        break;
      case 'extension':
        extension.push(tool);
        break;
      case 'sdk':
        sdk.push(tool);
        break;
      case 'mcp': {
        const server = serverOf(tool, inferred);
        mcp.set(server, [...(mcp.get(server) ?? []), tool]);
        break;
      }
      default:
        other.push(tool);
    }
  }
  const mcpGroups = [...mcp.keys()]
    .sort(compareNames)
    .map((server) => toolGroup(`mcp:${server}`, `MCP · ${server}`, mcp.get(server) ?? []));
  const groups = [
    toolGroup('builtin', 'Builtin', builtin),
    toolGroup('extension', 'Extension', extension),
    ...mcpGroups,
    toolGroup('sdk', 'SDK', sdk),
    toolGroup('other', 'Khác', other),
  ];
  return groups.filter((group) => group.tools.length > 0);
}

/** How often each tool name was used, summed over the usage records. */
function usageCounts(usage: readonly AgentToolUsage[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const entry of usage) counts.set(entry.name, (counts.get(entry.name) ?? 0) + entry.count);
  return counts;
}

export interface McpServerView {
  name: string;
  toolCount: number;
  activeCount: number;
  /** Calls to this server's tools, summed; 0 means the agent never used it. */
  usageCount: number;
  used: boolean;
}

/**
 * The MCP servers the tools come from, with their tool counts and whether the agent
 * used them. Used servers come first, the most used at the top.
 */
export function mcpServerViews(
  tools: readonly AgentToolInfo[],
  usage: readonly AgentToolUsage[],
): McpServerView[] {
  const counts = usageCounts(usage);
  const servers = new Map<string, McpServerView>();
  const inferred = inferMcpServers(tools);
  for (const tool of tools) {
    if (tool.source !== 'mcp') continue;
    const name = serverOf(tool, inferred);
    const view = servers.get(name) ?? {
      name,
      toolCount: 0,
      activeCount: 0,
      usageCount: 0,
      used: false,
    };
    view.toolCount += 1;
    if (tool.active) view.activeCount += 1;
    view.usageCount += counts.get(tool.name) ?? 0;
    servers.set(name, view);
  }
  return [...servers.values()]
    .map((view) => ({ ...view, used: view.usageCount > 0 }))
    .sort(
      (a, b) =>
        Number(b.used) - Number(a.used) ||
        b.usageCount - a.usageCount ||
        compareNames(a.name, b.name),
    );
}

/** Skills the agent used come first, then the rest; each half in name order. */
export function sortSkills(skills: readonly AgentSkillInfo[]): AgentSkillInfo[] {
  return [...skills].sort(
    (a, b) => Number(b.used) - Number(a.used) || compareNames(a.name, b.name),
  );
}

export interface UsageBar {
  name: string;
  count: number;
  /** 0 to 1 against the most used tool, so the top tool's bar is full. */
  share: number;
}

/** The most-used tools, most used first. Entries with no uses are not drawn. */
export function usageBars(usage: readonly AgentToolUsage[], limit = USAGE_BAR_LIMIT): UsageBar[] {
  const ranked = usage
    .filter((entry) => entry.count > 0)
    .sort((a, b) => b.count - a.count || compareNames(a.name, b.name))
    .slice(0, limit);
  const top = ranked[0]?.count ?? 0;
  return ranked.map((entry) => ({
    name: entry.name,
    count: entry.count,
    share: entry.count / top,
  }));
}

/** Whether a name passes a filter box: case-insensitive, and a blank filter passes all. */
export function matchesFilter(name: string, filter: string): boolean {
  const needle = filter.trim().toLowerCase();
  return needle.length === 0 || name.toLowerCase().includes(needle);
}

function notReported(info: AgentInfo, what: string): string {
  return `Chưa rõ ${what}: ${INFO_SOURCE_LABEL[info.collectedFrom]} không báo cáo mục này.`;
}

/** What the tools section says when it has nothing to list. Null when it has tools. */
export function toolsGap(info: AgentInfo): string | null {
  if (info.tools === undefined) return notReported(info, 'danh sách tool');
  return info.tools.length === 0 ? 'Phiên này không báo cáo tool nào.' : null;
}

/** What the MCP section says when it has no servers to list. Null when it has some. */
export function mcpGap(info: AgentInfo): string | null {
  if (info.tools === undefined) return notReported(info, 'máy chủ MCP');
  const hasMcp = info.tools.some((tool) => tool.source === 'mcp');
  return hasMcp ? null : 'Không có máy chủ MCP nào được báo cáo.';
}

/** What the skills section says when it has nothing to list. Null when it has skills. */
export function skillsGap(info: AgentInfo): string | null {
  if (info.skills === undefined) return notReported(info, 'skill');
  return info.skills.length === 0 ? 'Không có skill nào được nạp.' : null;
}

/** What the usage section says when it has no counts to draw. Null when it has some. */
export function usageGap(info: AgentInfo): string | null {
  if (info.toolUsage === undefined) return notReported(info, 'số lần dùng tool');
  return info.toolUsage.length === 0 ? 'Chưa dùng tool nào.' : null;
}

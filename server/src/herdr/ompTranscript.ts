import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { AgentSkillInfo, AgentToolInfo, AgentToolUsage } from '../../../core/src/messages.js';
import { jsonField } from './jsonField.js';

/** Bytes read from the start of a transcript: the session header and early settings. */
export const OMP_HEAD_BYTES = 64 * 1024;
/** Bytes read from the end of a transcript: the recent part that usage counts cover. */
export const OMP_TAIL_BYTES = 4 * 1024 * 1024;
export const OMP_TOOL_USAGE_LIMIT = 50;

const LINE_FEED = 0x0a;
const MCP_PREFIX = 'mcp__';
const SKILL_PREFIX = 'skill://';

/** What an omp session transcript says about its agent, from a bounded read. */
export interface OmpTranscriptSummary {
  readonly sessionFile: string;
  /** Working directory recorded in the session header. */
  readonly sessionCwd?: string;
  /** `provider/model` of the most recent model in use. */
  readonly model?: string;
  /** Most recent thinking level, as omp names it (for example `high`). */
  readonly thinking?: string;
  /** Tools declared to the model, including deferred ones, as of the latest request. */
  readonly declaredTools: readonly string[];
  /** Tools active on the latest request. */
  readonly activeTools: readonly string[];
  /** Tool calls in the counted window, most used first, at most {@link OMP_TOOL_USAGE_LIMIT}. */
  readonly toolUsage: readonly AgentToolUsage[];
  /** Skills loaded with a `read` of `skill://<name>` in the counted window, first use first. */
  readonly skillsRead: readonly string[];
  /** True when the transcript was longer than head + tail; usage then covers only the tail. */
  readonly truncated: boolean;
}

/** The board-facing fields a transcript supplies to an `AgentInfo`. */
export interface OmpAgentFields {
  readonly model?: string;
  readonly thinking?: string;
  readonly sessionFile: string;
  readonly tools: AgentToolInfo[];
  readonly skills: AgentSkillInfo[];
  readonly toolUsage: AgentToolUsage[];
}

/** Working state while scanning entries; only the fields the summary needs are kept. */
interface ScanState {
  sessionCwd?: string;
  model?: string;
  thinking?: string;
  controls?: { readonly declared: readonly string[]; readonly active: readonly string[] };
  readonly counts: Map<string, number>;
  readonly skills: Set<string>;
}

/**
 * Reads an omp session transcript without loading all of it. Files up to head + tail
 * bytes are read whole. Longer files contribute their first {@link OMP_HEAD_BYTES} for the
 * session header and earliest settings, and their last {@link OMP_TAIL_BYTES} for usage.
 * Only complete lines are used, and a half-written last line (omp still running) is skipped.
 */
export async function readOmpTranscript(sessionFile: string): Promise<OmpTranscriptSummary> {
  if (!path.isAbsolute(sessionFile) || path.extname(sessionFile).toLowerCase() !== '.jsonl') {
    throw new Error('Đường dẫn transcript omp không hợp lệ.');
  }
  const handle = await fs.open(sessionFile, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('Transcript omp không phải là tệp.');
    const state: ScanState = { counts: new Map(), skills: new Set() };
    if (stat.size <= OMP_HEAD_BYTES + OMP_TAIL_BYTES) {
      scanLines(await readRange(handle, 0, stat.size), state, true);
      return summarize(sessionFile, state, false);
    }
    scanLines(dropPartialLastLine(await readRange(handle, 0, OMP_HEAD_BYTES)), state, false);
    const tailStart = stat.size - OMP_TAIL_BYTES;
    const tail = await readRange(handle, tailStart, OMP_TAIL_BYTES);
    scanLines(dropPartialFirstLine(tail), state, true);
    return summarize(sessionFile, state, true);
  } finally {
    await handle.close();
  }
}

/** Board fields for a summary: model, thinking, tools with MCP servers, skills, and usage counts. */
export function ompAgentFields(summary: OmpTranscriptSummary): OmpAgentFields {
  const active = new Set(summary.activeTools);
  const names = new Set([
    ...summary.declaredTools,
    ...summary.activeTools,
    ...summary.toolUsage.map((usage) => usage.name),
  ]);
  const tools = [...names].sort().map((name) => toolInfo(name, active.has(name)));
  return {
    ...(summary.model === undefined ? {} : { model: summary.model }),
    ...(summary.thinking === undefined ? {} : { thinking: summary.thinking }),
    sessionFile: summary.sessionFile,
    tools,
    skills: summary.skillsRead.map((name) => ({ name, used: true })),
    toolUsage: [...summary.toolUsage],
  };
}

/**
 * Splits an MCP tool name `mcp__<server>_<tool>` the way omp itself does: the server name
 * ends at the first underscore after the prefix. Returns `undefined` for other names.
 */
export function parseMcpToolName(
  name: string,
): { readonly server: string; readonly tool: string } | undefined {
  if (!name.startsWith(MCP_PREFIX)) return undefined;
  const rest = name.slice(MCP_PREFIX.length);
  const cut = rest.indexOf('_');
  if (cut <= 0) return undefined;
  return { server: rest.slice(0, cut), tool: rest.slice(cut + 1) };
}

function toolInfo(name: string, active: boolean): AgentToolInfo {
  const mcp = parseMcpToolName(name);
  if (mcp !== undefined) return { name, source: 'mcp', mcpServer: mcp.server, active };
  // The transcript marks MCP tools by name only, so every other tool is reported as built-in.
  return { name, source: 'builtin', active };
}

async function readRange(handle: fs.FileHandle, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  let filled = 0;
  while (filled < length) {
    const { bytesRead } = await handle.read(buffer, filled, length - filled, position + filled);
    if (bytesRead === 0) break;
    filled += bytesRead;
  }
  return buffer.subarray(0, filled);
}

/** Keeps the bytes up to the last line feed; a trailing fragment cannot be parsed. */
function dropPartialLastLine(chunk: Buffer): Buffer {
  const last = chunk.lastIndexOf(LINE_FEED);
  return last === -1 ? chunk.subarray(0, 0) : chunk.subarray(0, last);
}

/** Keeps the bytes after the first line feed; a leading fragment is the tail of an earlier line. */
function dropPartialFirstLine(chunk: Buffer): Buffer {
  const first = chunk.indexOf(LINE_FEED);
  return first === -1 ? chunk.subarray(0, 0) : chunk.subarray(first + 1);
}

function scanLines(chunk: Buffer, state: ScanState, countUsage: boolean): void {
  let start = 0;
  for (let end = chunk.indexOf(LINE_FEED); end !== -1; end = chunk.indexOf(LINE_FEED, start)) {
    scanLine(chunk.toString('utf8', start, end), state, countUsage);
    start = end + 1;
  }
  if (start < chunk.length) scanLine(chunk.toString('utf8', start), state, countUsage);
}

function scanLine(line: string, state: ScanState, countUsage: boolean): void {
  if (line.trim() === '') return;
  let entry: unknown;
  try {
    entry = JSON.parse(line);
  } catch {
    // A half-written line from a running omp; the next read will see it complete.
    return;
  }
  switch (jsonField(entry, 'type')) {
    case 'session': {
      const cwd = jsonField(entry, 'cwd');
      if (state.sessionCwd === undefined && isNonEmptyString(cwd)) state.sessionCwd = cwd;
      return;
    }
    case 'model_change': {
      const model = jsonField(entry, 'model');
      if (isNonEmptyString(model)) state.model = model;
      return;
    }
    case 'thinking_level_change': {
      const thinking = jsonField(entry, 'thinkingLevel');
      if (isNonEmptyString(thinking)) state.thinking = thinking;
      return;
    }
    case 'message':
      scanMessage(jsonField(entry, 'message'), state, countUsage);
      return;
    default:
      return;
  }
}

function scanMessage(message: unknown, state: ScanState, countUsage: boolean): void {
  if (jsonField(message, 'role') !== 'assistant') return;
  const model = jsonField(message, 'model');
  if (isNonEmptyString(model)) {
    state.model = modelLabel(jsonField(message, 'provider'), model);
  }
  const tools = jsonField(jsonField(message, 'requestControls'), 'tools');
  if (tools !== undefined && tools !== null) {
    state.controls = {
      declared: [
        ...stringList(jsonField(tools, 'declared')),
        ...stringList(jsonField(tools, 'deferred')),
      ],
      active: stringList(jsonField(tools, 'active')),
    };
  }
  const content: unknown = jsonField(message, 'content');
  if (!countUsage || !Array.isArray(content)) return;
  for (const block of content as readonly unknown[]) {
    if (jsonField(block, 'type') !== 'toolCall') continue;
    const name = jsonField(block, 'name');
    if (!isNonEmptyString(name)) continue;
    state.counts.set(name, (state.counts.get(name) ?? 0) + 1);
    const skill = name === 'read' ? skillNameOf(jsonField(block, 'arguments')) : undefined;
    if (skill !== undefined) state.skills.add(skill);
  }
}

function summarize(
  sessionFile: string,
  state: ScanState,
  truncated: boolean,
): OmpTranscriptSummary {
  const toolUsage = [...state.counts]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .slice(0, OMP_TOOL_USAGE_LIMIT);
  return {
    sessionFile,
    ...(state.sessionCwd === undefined ? {} : { sessionCwd: state.sessionCwd }),
    ...(state.model === undefined ? {} : { model: state.model }),
    ...(state.thinking === undefined ? {} : { thinking: state.thinking }),
    declaredTools: state.controls?.declared ?? [],
    activeTools: state.controls?.active ?? [],
    toolUsage,
    skillsRead: [...state.skills],
    truncated,
  };
}

/** Joins the provider and model the way `model_change` entries spell them: `provider/model`. */
function modelLabel(provider: unknown, model: string): string {
  if (model.includes('/') || !isNonEmptyString(provider)) return model;
  return `${provider}/${model}`;
}

/** `read` of `skill://<name>` or `skill://<name>/<file>` names the skill; anything else is not a skill. */
function skillNameOf(args: unknown): string | undefined {
  const target = jsonField(args, 'path');
  if (typeof target !== 'string' || !target.startsWith(SKILL_PREFIX)) return undefined;
  const name = target.slice(SKILL_PREFIX.length).split('/')[0];
  return name === undefined || name === '' ? undefined : name;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const names: string[] = [];
  for (const item of value as readonly unknown[]) {
    if (typeof item === 'string') names.push(item);
  }
  return names;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

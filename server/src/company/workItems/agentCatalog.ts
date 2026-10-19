/**
 * The omp subagent catalog: the agents a squad work item may name.
 *
 * Agents come from four layers, highest precedence first: project agents in the
 * folder root, project agents in each repo (in the order given), user agents under
 * the home directory, then the agents bundled with omp. The first occurrence of a
 * name wins, so a higher layer shadows a lower one.
 *
 * The parsing and layering rules are pure. Disk access goes through an injected
 * AgentFileSource, so tests can run on an in-memory tree.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { OmpAgentInfo } from '../../../../core/src/messages.js';

/** Agents shipped with omp. Descriptions mirror the frontmatter of omp's bundled agent files. */
export const BUNDLED_AGENTS: readonly OmpAgentInfo[] = [
  {
    name: 'task',
    description: 'Worker agent: delegated tasks.',
    readOnly: false,
    source: 'bundled',
  },
  {
    name: 'scout',
    description:
      'MUST be used for exploratory codebase research, rapid code analysis, and broad pattern searches. Fast read-only scout returning compressed context for handoff.',
    readOnly: true,
    source: 'bundled',
  },
  {
    name: 'reviewer',
    description: 'Code review specialist for quality/security analysis',
    readOnly: true,
    source: 'bundled',
  },
  {
    name: 'security-reviewer',
    description:
      'Read-only security specialist for evidence-backed repository vulnerability discovery',
    readOnly: true,
    source: 'bundled',
  },
  {
    name: 'sonic',
    description: 'Low-reasoning agent for strictly mechanical updates or data collection only',
    readOnly: false,
    source: 'bundled',
  },
];

/** Where the catalog reads agent files from. Every method resolves; none is expected to throw. */
export interface AgentFileSource {
  /** Absolute paths of the `*.md` files directly inside `dir`; empty when `dir` is missing. */
  listMarkdown(dir: string): Promise<readonly string[]>;
  /** The full text of one file. Rejects when the file cannot be read. */
  read(file: string): Promise<string>;
}

/** Reads agent files from the real disk. A missing or unreadable directory lists as empty. */
export const nodeAgentFileSource: AgentFileSource = {
  async listMarkdown(dir) {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      return entries
        .filter(
          (entry) => (entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith('.md'),
        )
        .map((entry) => path.join(dir, entry.name));
    } catch {
      return [];
    }
  },
  read(file) {
    return fs.readFile(file, 'utf8');
  },
};

export interface ParsedAgentFile {
  /** The frontmatter `name`, when set and non-empty. */
  name?: string;
  /** The frontmatter `description`; empty when absent. */
  description: string;
  /** The frontmatter `tools` list; undefined when none is declared. */
  tools?: readonly string[];
}

const FRONTMATTER_FENCE = '---';
/** A top-level `key: value` line. Indented lines are nested keys, not top-level ones. */
const TOP_LEVEL_KEY = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/;
/** One YAML block-list item, `- value`, indented or not. */
const LIST_ITEM = /^\s*-(?:\s+(.*))?$/;

/**
 * Reads the YAML frontmatter of an agent file: the block between leading `---` lines.
 * Only `name`, `description`, and `tools` matter. `tools` may be an inline comma list
 * or a YAML block list. A file without a closed frontmatter block yields no name and an
 * empty description.
 */
export function parseAgentFile(text: string): ParsedAgentFile {
  const lines = text
    .replace(/^\uFEFF/, '')
    .split('\n')
    .map((line) => line.trimEnd());
  const close = lines.findIndex((line, index) => index > 0 && line === FRONTMATTER_FENCE);
  if (lines[0] !== FRONTMATTER_FENCE || close < 0) {
    return { description: '' };
  }

  let name: string | undefined;
  let description = '';
  const tools: string[] = [];
  let inToolsBlock = false;

  for (const line of lines.slice(1, close)) {
    if (line === '') continue;
    if (inToolsBlock) {
      const item = LIST_ITEM.exec(line);
      if (item) {
        const value = unquote(item[1] ?? '');
        if (value !== '') tools.push(value);
        continue;
      }
      inToolsBlock = false;
    }

    const field = TOP_LEVEL_KEY.exec(line);
    if (!field) continue;
    const key = field[1] ?? '';
    const raw = field[2] ?? '';
    if (key === 'name') {
      const value = unquote(raw);
      if (value !== '') name = value;
    } else if (key === 'description') {
      description = unquote(raw);
    } else if (key === 'tools') {
      inToolsBlock = raw.trim() === '';
      tools.push(...splitInlineList(raw));
    }
  }

  return { name, description, tools: tools.length > 0 ? tools : undefined };
}

/** Removes one pair of matching quotes around a trimmed value. */
function unquote(raw: string): string {
  const value = raw.trim();
  const first = value.charAt(0);
  if (value.length >= 2 && (first === '"' || first === "'") && value.endsWith(first)) {
    return value.slice(1, -1);
  }
  return value;
}

/** Splits an inline list such as `read, grep` or `[read, grep]` into its items. */
function splitInlineList(raw: string): string[] {
  const inner = raw.trim().replace(/^\[(.*)\]$/, '$1');
  return inner
    .split(',')
    .map((item) => unquote(item))
    .filter((item) => item !== '');
}

const AGENT_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** True when `name` is a usable agent name: letters, digits, `-`, `_`, at most 64 characters. */
export function isValidAgentName(name: string): boolean {
  return AGENT_NAME.test(name);
}

/** Agents that are read-only by name, whatever tools they declare. */
const READ_ONLY_AGENT_NAMES: Record<string, true> = {
  scout: true,
  reviewer: true,
  'security-reviewer': true,
};
/** Tools that can change files or run commands. An agent declaring none of them is read-only. */
const MUTATING_TOOLS: readonly string[] = ['edit', 'write', 'bash'];

/**
 * Whether an agent is read-only. Known read-only names always are. Otherwise an agent
 * that declares tools, none of them mutating, is read-only. An agent that declares no
 * tools is not.
 */
export function agentIsReadOnly(name: string, tools: readonly string[] | undefined): boolean {
  if (READ_ONLY_AGENT_NAMES[name] === true) return true;
  return tools !== undefined && !tools.some((tool) => MUTATING_TOOLS.includes(tool));
}

/** Where the catalog looks for agents, in precedence order: `dir` holds `*.md` agent files. */
interface AgentLayer {
  readonly dir: string;
  readonly source: OmpAgentInfo['source'];
}

export interface AgentCatalogOptions {
  /** The user's home directory; user agents live under `<homeDir>/.omp/agent/agents`. */
  homeDir: string;
  /** The company folder root; its agents live under `<folderRoot>/.omp/agents`. */
  folderRoot: string;
  /** Git repos and worktrees under the folder root, in precedence order. */
  repos: readonly string[];
  /** Where agent files are read from. Defaults to the real disk. */
  files?: AgentFileSource;
}

/**
 * Loads every agent the folder can use, one entry per name, sorted by name.
 * Project layers come first (folder root, then each repo), then user agents, then the
 * bundled agents. Invalid names are skipped. Files that cannot be listed or read are
 * skipped without failing the load.
 */
export async function loadAgentCatalog(
  options: AgentCatalogOptions,
): Promise<readonly OmpAgentInfo[]> {
  const files = options.files ?? nodeAgentFileSource;
  const byName = new Map<string, OmpAgentInfo>();

  for (const layer of agentLayers(options)) {
    for (const agent of await readLayer(files, layer)) {
      if (!byName.has(agent.name)) byName.set(agent.name, agent);
    }
  }
  for (const agent of BUNDLED_AGENTS) {
    if (!byName.has(agent.name)) byName.set(agent.name, { ...agent });
  }

  return [...byName.values()].sort((a, b) => compareText(a.name, b.name));
}

/** The agent with exactly this name, if the catalog has one. */
export function findAgent(
  catalog: readonly OmpAgentInfo[],
  name: string,
): OmpAgentInfo | undefined {
  return catalog.find((agent) => agent.name === name);
}

function agentLayers(options: AgentCatalogOptions): AgentLayer[] {
  // A Set drops repeats, including a repo that is the folder root itself.
  const projectDirs = new Set(
    [options.folderRoot, ...options.repos].map((root) => path.join(root, '.omp', 'agents')),
  );
  const layers: AgentLayer[] = [...projectDirs].map(
    (dir): AgentLayer => ({ dir, source: 'project' }),
  );
  layers.push({ dir: path.join(options.homeDir, '.omp', 'agent', 'agents'), source: 'user' });
  return layers;
}

/** The valid agents one layer defines, in file-name order. A repeated name stays in the list. */
async function readLayer(files: AgentFileSource, layer: AgentLayer): Promise<OmpAgentInfo[]> {
  const listed = await listSafely(files, layer.dir);
  const ordered = [...listed].sort((a, b) => compareText(path.basename(a), path.basename(b)));

  const agents: OmpAgentInfo[] = [];
  for (const file of ordered) {
    const text = await readSafely(files, file);
    if (text === undefined) continue;
    const parsed = parseAgentFile(text);
    const name = parsed.name ?? path.basename(file, '.md');
    if (!isValidAgentName(name)) continue;
    agents.push({
      name,
      description: parsed.description,
      readOnly: agentIsReadOnly(name, parsed.tools),
      source: layer.source,
    });
  }
  return agents;
}

async function listSafely(files: AgentFileSource, dir: string): Promise<readonly string[]> {
  try {
    return await files.listMarkdown(dir);
  } catch {
    return [];
  }
}

async function readSafely(files: AgentFileSource, file: string): Promise<string | undefined> {
  try {
    return await files.read(file);
  } catch {
    return undefined;
  }
}

function compareText(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

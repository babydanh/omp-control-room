import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { LibrarySkill } from '../../../core/src/messages.js';
import { LibraryUserError } from './libraryError.js';

const PREVIEW_LIMIT_BYTES = 64 * 1024;
const TOOL_ORDER = ['omp', 'claude', 'agy'] as const;
type SkillTool = (typeof TOOL_ORDER)[number];
type ClaudeMode = 'on' | 'name-only' | 'user-invocable-only' | 'off';

interface SkillSource {
  name: string;
  description: string;
  tool: SkillTool;
  path: string;
  sizeBytes: number;
  plugin?: string;
}

let cachedSkills: LibrarySkill[] | undefined;
let skillPaths = new Map<string, string>();

function stableId(name: string): string {
  return createHash('sha256').update(name.trim().toLocaleLowerCase()).digest('hex').slice(0, 24);
}

function parseFrontmatter(content: string): { name?: string; description: string } {
  const match = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\s|$)/);
  if (!match) return { description: '' };
  let name: string | undefined;
  let description = '';
  let descriptionStyle: 'literal' | 'fold' | undefined;
  let readingDescription = false;
  let quoted: string | undefined;
  const descriptionLines: string[] = [];
  for (const line of match[1].split(/\r?\n/)) {
    const field = line.match(/^([A-Za-z][\w-]*):(?:\s*(.*))?$/);
    if (field) {
      if (readingDescription) break;
      if (field[1] === 'name') {
        name = (field[2] ?? '').trim().replace(/^(['"])(.*)\1$/, '$2');
      } else if (field[1] === 'description') {
        readingDescription = true;
        const value = (field[2] ?? '').trim();
        if (value === '|' || value === '|-' || value === '|+') descriptionStyle = 'literal';
        else if (value === '>' || value === '>- ' || value === '>-') descriptionStyle = 'fold';
        else if (value.startsWith('"') || value.startsWith("'")) {
          quoted = value[0];
          description = value.slice(1, value.endsWith(quoted) ? -1 : undefined);
          if (value.endsWith(quoted) && value.length > 1) quoted = undefined;
        } else description = value;
      }
      continue;
    }
    if (!readingDescription) continue;
    const continuation = line.match(/^\s+(\S.*)?$/);
    if (descriptionStyle) {
      if (continuation) descriptionLines.push(continuation[1] ?? '');
      continue;
    }
    if (quoted) {
      const part = (continuation?.[1] ?? line.trim()).replace(/["']$/, '');
      description += `${description ? ' ' : ''}${part}`;
      if (line.trimEnd().endsWith(quoted)) quoted = undefined;
    }
  }
  if (descriptionStyle) {
    description = descriptionStyle === 'fold'
      ? descriptionLines.join(' ').trim()
      : descriptionLines.join('\n').trim();
  }
  return { name: name?.trim() || undefined, description: description.trim() };
}

async function listSkillFiles(root: string, tool: SkillTool, plugin?: string): Promise<SkillSource[]> {
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: SkillSource[] = [];
  for (const entry of entries) {
    const skillPath = path.join(root, entry.name, 'SKILL.md');
    try {
      const stat = await fs.stat(skillPath);
      if (!stat.isFile()) continue;
      const metadata = parseFrontmatter(await fs.readFile(skillPath, 'utf8'));
      found.push({
        name: metadata.name ?? entry.name,
        description: metadata.description,
        tool,
        path: skillPath,
        sizeBytes: stat.size,
        plugin,
      });
    } catch {
      // Ignore an unreadable skill and continue scanning other sources.
    }
  }
  return found;
}

async function readJson(filePath: string): Promise<Record<string, unknown>> {
  try {
    const value: unknown = JSON.parse(await fs.readFile(filePath, 'utf8'));
    return value && typeof value === 'object' ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function modeForSkill(overrides: Record<string, unknown>, name: string, plugin?: string): ClaudeMode {
  for (const key of plugin ? [`${plugin}:${name}`, name] : [name]) {
    const value = overrides[key];
    const mode = typeof value === 'string'
      ? value
      : value && typeof value === 'object'
        ? (value as Record<string, unknown>).mode ?? (value as Record<string, unknown>).type
        : undefined;
    if (mode === 'name-only' || mode === 'user-invocable-only' || mode === 'off' || mode === 'on') return mode;
  }
  return 'on';
}

function installedPluginVersions(installed: Record<string, unknown>, pluginKey: string): string[] | undefined {
  const plugins = installed.plugins && typeof installed.plugins === 'object'
    ? installed.plugins as Record<string, unknown>
    : installed;
  const entries = plugins[pluginKey];
  if (!Array.isArray(entries)) return undefined;
  return entries.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const record = entry as Record<string, unknown>;
    if (typeof record.version === 'string') return [record.version];
    if (typeof record.installPath === 'string') return [path.basename(record.installPath)];
    return [];
  });
}

let latestSkillsSourceReason: string | undefined;

export function skillsSourceReason(): string | undefined {
  return latestSkillsSourceReason;
}

export async function scanSkills(homeDir: string): Promise<{ skills: LibrarySkill[]; paths: Map<string, string> }> {
  const claudeDir = path.join(homeDir, '.claude');
  const sourceRoots = [
    path.join(homeDir, '.omp', 'agent', 'skills'),
    path.join(claudeDir, 'skills'),
    path.join(homeDir, '.gemini', 'antigravity-cli', 'skills'),
    path.join(homeDir, '.gemini', 'config', 'skills'),
  ];
  const availableRoots = await Promise.all(sourceRoots.map(async (root) => {
    try {
      await fs.access(root);
      return true;
    } catch {
      return false;
    }
  }));
  const sourceIssues: string[] = availableRoots.some(Boolean)
    ? []
    : ['Không tìm thấy thư mục skill của omp, Claude hoặc agy.'];
  try {
    const settingsContent = await fs.readFile(path.join(claudeDir, 'settings.json'), 'utf8');
    JSON.parse(settingsContent);
  } catch (error) {
    if (error instanceof SyntaxError) sourceIssues.push('Tệp cấu hình Claude không đọc được.');
  }
  const settings = await readJson(path.join(claudeDir, 'settings.json'));
  const enabled = settings.enabledPlugins && typeof settings.enabledPlugins === 'object'
    ? settings.enabledPlugins as Record<string, unknown>
    : {};
  const overrides = settings.skillOverrides && typeof settings.skillOverrides === 'object'
    ? settings.skillOverrides as Record<string, unknown>
    : {};
  const installed = await readJson(path.join(claudeDir, 'plugins', 'installed_plugins.json'));
  const sources: SkillSource[] = [
    ...await listSkillFiles(sourceRoots[0], 'omp'),
    ...await listSkillFiles(sourceRoots[1], 'claude'),
    ...await listSkillFiles(sourceRoots[2], 'agy'),
    ...await listSkillFiles(sourceRoots[3], 'agy'),
  ];

  const cacheRoot = path.join(claudeDir, 'plugins', 'cache');
  for (const [pluginKey, enabledValue] of Object.entries(enabled)) {
    if (enabledValue !== true) continue;
    const [plugin, marketplace] = pluginKey.split('@');
    if (!plugin || !marketplace) continue;
    const pluginRoot = path.join(cacheRoot, marketplace, plugin);
    let versions = installedPluginVersions(installed, pluginKey);
    if (versions === undefined) {
      try {
        versions = (await fs.readdir(pluginRoot, { withFileTypes: true }))
          .filter((entry) => entry.isDirectory()).map((entry) => entry.name);
      } catch {
        versions = [];
      }
    }
    for (const version of versions) {
      sources.push(...await listSkillFiles(path.join(pluginRoot, version, 'skills'), 'claude', plugin));
    }
  }
  latestSkillsSourceReason = sourceIssues.length ? sourceIssues.join(' ') : undefined;

  const grouped = new Map<string, SkillSource[]>();
  for (const source of sources) {
    const key = source.name.trim().toLocaleLowerCase();
    const group = grouped.get(key);
    if (group) group.push(source);
    else grouped.set(key, [source]);
  }
  const paths = new Map<string, string>();
  const skills: LibrarySkill[] = [];
  for (const group of grouped.values()) {
    const id = stableId(group[0].name);
    const tools = [...new Set(group.map((source) => source.tool))].sort(
      (left, right) => TOOL_ORDER.indexOf(left) - TOOL_ORDER.indexOf(right),
    );
    const claudeSource = group.find((source) => source.tool === 'claude');
    const pluginSource = group.find((source) => source.plugin !== undefined);
    const preferred = group.find((source) => source.tool === 'omp') ?? claudeSource ?? group[0];
    const skill: LibrarySkill = {
      id,
      name: preferred.name,
      description: preferred.description,
      tools,
      claudeMode: claudeSource ? modeForSkill(overrides, preferred.name, pluginSource?.plugin) : 'on',
      sizeBytes: preferred.sizeBytes,
      ...(pluginSource?.plugin ? { plugin: pluginSource.plugin } : {}),
      
    };
    skills.push(skill);
    paths.set(id, preferred.path);
  }
  skills.sort((left, right) => left.name.localeCompare(right.name));
  return { skills, paths };
}

export async function readSkills(refresh: boolean): Promise<LibrarySkill[]> {
  if (cachedSkills && !refresh) return cachedSkills;
  const result = await scanSkills(os.homedir());
  cachedSkills = result.skills;
  skillPaths = result.paths;
  return cachedSkills;
}

export async function previewSkillFromIndex(
  id: string,
  paths: ReadonlyMap<string, string>,
): Promise<{ content: string; truncated: boolean }> {
  const skillPath = paths.get(id);
  if (!skillPath) throw new LibraryUserError('Không tìm thấy skill để xem trước.');
  const content = await fs.readFile(skillPath);
  const truncated = content.byteLength > PREVIEW_LIMIT_BYTES;
  return { content: content.subarray(0, PREVIEW_LIMIT_BYTES).toString('utf8'), truncated };
}

export async function previewSkill(id: string): Promise<{ content: string; truncated: boolean }> {
  return previewSkillFromIndex(id, skillPaths);
}

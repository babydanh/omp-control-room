import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { LibrarySkill } from '../../../core/src/messages.js';
import { mutateClaudeSettings } from '../providers/hook/claude/claudeHookInstaller.js';
import { LibraryUserError } from './libraryError.js';

const PREVIEW_LIMIT_BYTES = 64 * 1024;
const TOOL_ORDER = ['omp', 'claude', 'agents', 'agy'] as const;
type SkillTool = (typeof TOOL_ORDER)[number];
type ClaudeMode = 'on' | 'name-only' | 'user-invocable-only' | 'off';

interface SkillSource {
  name: string;
  description: string;
  tool: SkillTool;
  path: string;
  location: string;
  sizeBytes: number;
  contentHash: string;
  lineCount: number;
  sourceId: string;
  kind?: 'claude-ai-sync';
  plugin?: string;
}

function isIgnoredSkill(patterns: readonly string[], source: SkillSource): boolean {
  if (source.tool !== 'omp' && source.tool !== 'agents') return false;
  const names = source.tool === 'agents'
    ? [source.name, `agents/${source.name}`]
    : [source.name];
  return patterns.some((pattern) => {
    const regex = new RegExp(`^${pattern.split('').map((character) => {
      if (character === '*') return '.*';
      if (character === '?') return '.';
      return character.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
    }).join('')}$`, 'i');
    return names.some((name) => regex.test(name));
  });
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

async function listSkillFiles(
  root: string,
  tool: SkillTool,
  location: string,
  plugin?: string,
  kind?: SkillSource['kind'],
): Promise<SkillSource[]> {
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
      const content = await fs.readFile(skillPath, 'utf8');
      const metadata = parseFrontmatter(content);
      const source: SkillSource = {
        name: metadata.name ?? entry.name,
        description: metadata.description,
        tool,
        path: skillPath,
        location,
        sizeBytes: stat.size,
        contentHash: createHash('sha256').update(content).digest('hex'),
        lineCount: content.length === 0 ? 0 : content.split(/\r?\n/).length - (/\r?\n$/.test(content) ? 1 : 0),
        sourceId: '',
        plugin,
        kind,
      };
      source.sourceId = createHash('sha256').update(`${tool}\0${skillPath}`).digest('hex').slice(0, 24);
      found.push(source);
    } catch {
      // Ignore an unreadable skill and continue scanning other sources.
    }
  }
  return found;
}

async function listSyncedClaudeSkillFiles(root: string): Promise<SkillSource[]> {
  let accounts;
  try {
    accounts = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: SkillSource[] = [];
  for (const account of accounts) {
    if (!account.isDirectory()) continue;
    found.push(...await listSkillFiles(path.join(root, account.name), 'claude', 'Claude.ai sync', undefined, 'claude-ai-sync'));
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

async function readIgnoredSkillPatterns(filePath: string): Promise<string[]> {
  let content: string;
  try {
    content = await fs.readFile(filePath, 'utf8');
  } catch {
    return [];
  }
  const lines = content.split(/\r?\n/);
  let inSkills = false;
  let inIgnoredSkills = false;
  const patterns: string[] = [];
  for (const line of lines) {
    if (/^skills:\s*(?:#.*)?$/.test(line)) {
      inSkills = true;
      inIgnoredSkills = false;
      continue;
    }
    if (inSkills && /^  ignoredSkills:\s*(?:#.*)?$/.test(line)) {
      inIgnoredSkills = true;
      continue;
    }
    const inline = line.match(/^  ignoredSkills:\s*\[(.*)\]\s*(?:#.*)?$/);
    if (inSkills && inline) {
      patterns.push(...(inline[1] ?? '').split(',').map((value) => value.trim().replace(/^(["'])(.*)\1$/, '$2')).filter(Boolean));
      inIgnoredSkills = false;
      continue;
    }
    if (inIgnoredSkills && /^\s{4,}-\s*/.test(line)) {
      const value = line.replace(/^\s+-\s*/, '').replace(/\s+#.*$/, '').trim();
      const unquoted = value.replace(/^(["'])(.*)\1$/, '$2');
      if (unquoted) patterns.push(unquoted);
      continue;
    }
    if (inSkills && line.trim() && !/^\s/.test(line)) inSkills = false;
    if (inIgnoredSkills && (/^\S/.test(line) || /^  [^\s-]/.test(line))) inIgnoredSkills = false;
  }
  return patterns;
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
    path.join(homeDir, '.agents', 'skills'),
    path.join(homeDir, '.agent', 'skills'),
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
    : ['Không tìm thấy thư mục skill của omp, Claude, agents hoặc agy.'];
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
  const ignoredPatterns = await readIgnoredSkillPatterns(path.join(homeDir, '.omp', 'agent', 'config.yml'));
  const sources: SkillSource[] = [
    ...await listSkillFiles(sourceRoots[0], 'omp', '.omp/agent/skills'),
    ...await listSkillFiles(sourceRoots[1], 'claude', '.claude/skills'),
    ...await listSkillFiles(sourceRoots[2], 'agents', '.agents/skills'),
    ...await listSkillFiles(sourceRoots[3], 'agents', '.agent/skills'),
    ...await listSkillFiles(sourceRoots[4], 'agy', '.gemini/antigravity-cli/skills'),
    ...await listSkillFiles(sourceRoots[5], 'agy', '.gemini/config/skills'),
    ...await listSyncedClaudeSkillFiles(path.join(claudeDir, 'skills', 'synced')),
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
      sources.push(...await listSkillFiles(path.join(pluginRoot, version, 'skills'), 'claude', `Claude plugin:${plugin}`, plugin));
    }
  }
  latestSkillsSourceReason = sourceIssues.length ? sourceIssues.join(' ') : undefined;

  const grouped = new Map<string, SkillSource[]>();
  for (const source of sources) {
    const name = source.name.trim().toLocaleLowerCase();
    const key = source.plugin ? `plugin:${source.plugin.toLocaleLowerCase()}:${name}` : name;
    const group = grouped.get(key);
    if (group) group.push(source);
    else grouped.set(key, [source]);
  }
  const paths = new Map<string, string>();
  const skills: LibrarySkill[] = [];
  for (const group of grouped.values()) {
    const plugin = group.find((source) => source.plugin !== undefined)?.plugin;
    const id = stableId(plugin ? `plugin:${plugin}:${group[0].name}` : group[0].name);
    const ordered = [...group].sort((left, right) => TOOL_ORDER.indexOf(left.tool) - TOOL_ORDER.indexOf(right.tool));
    const activeSources = ordered.filter((source) => !isIgnoredSkill(ignoredPatterns, source));
    const tools = [...new Set(activeSources.map((source) => source.tool === 'agents' ? 'omp' : source.tool))].sort(
      (left, right) => TOOL_ORDER.indexOf(left) - TOOL_ORDER.indexOf(right),
    );
    const ignoredTools = [...new Set(ordered
      .filter((source) => isIgnoredSkill(ignoredPatterns, source))
      .map((source) => source.tool === 'agents' ? 'omp' : source.tool)
      .filter((tool) => !tools.includes(tool)))];
    const claudeSource = activeSources.find((source) => source.tool === 'claude');
    const preferred = activeSources[0] ?? ordered[0];
    const differentContent = new Set(group.map((source) => source.contentHash)).size > 1;
    const skill: LibrarySkill = {
      id,
      name: preferred.name,
      description: preferred.description,
      tools,
      claudeMode: claudeSource ? modeForSkill(overrides, preferred.name, plugin) : 'on',
      sizeBytes: preferred.sizeBytes,
      preferredSource: activeSources[0]?.tool,
      preferredSourceId: preferred.sourceId,
      sources: ordered.map((source) => ({
        id: source.sourceId,
        tool: source.tool,
        location: source.location,
        contentHash: source.contentHash,
        lineCount: source.lineCount,
        ignored: isIgnoredSkill(ignoredPatterns, source),
        ...(source.kind ? { kind: source.kind } : {}),
      })),
      ignoredTools,
      hasContentDifferences: differentContent,
      ...(plugin ? { plugin } : {}),
    };
    skills.push(skill);
    paths.set(id, preferred.path);
    for (const source of ordered) paths.set(`${id}:${source.sourceId}`, source.path);
  }
  skills.sort((left, right) => left.name.localeCompare(right.name) || (left.plugin ?? '').localeCompare(right.plugin ?? ''));
  return { skills, paths };
}

export async function readSkills(refresh: boolean): Promise<LibrarySkill[]> {
  if (cachedSkills && !refresh) return cachedSkills;
  const result = await scanSkills(os.homedir());
  cachedSkills = result.skills;
  skillPaths = result.paths;
  return cachedSkills;
}

const SKILL_DIR_NAME = /^(?!\.{1,2}$)[\w.-]{1,128}$/;

/**
 * Writes `skillOverrides[name] = mode` in ~/.claude/settings.json for skills of ~/.claude/skills.
 * Only skills still fully loaded (no entry, or `on`) change, so a deliberate `off` or
 * `user-invocable-only` is never loosened. Returns the names that changed.
 */
export async function setClaudeSkillMode(
  homeDir: string,
  names: readonly string[],
  mode: 'name-only',
): Promise<string[]> {
  const installed: string[] = [];
  for (const name of new Set(names)) {
    if (!SKILL_DIR_NAME.test(name)) continue;
    try {
      await fs.access(path.join(homeDir, '.claude', 'skills', name, 'SKILL.md'));
      installed.push(name);
    } catch {
      // Not a user skill of Claude (plugin skill, removed, or omp-only): nothing to override.
    }
  }
  if (installed.length === 0) throw new LibraryUserError('Không có skill nào trong ~/.claude/skills khớp tên đã chọn.');
  let changed: string[] = [];
  await mutateClaudeSettings((settings) => {
    const current = settings.skillOverrides;
    if (current !== undefined && (!current || typeof current !== 'object' || Array.isArray(current))) {
      throw new LibraryUserError('Không thể cập nhật vì skillOverrides trong settings.json không hợp lệ.');
    }
    const overrides = (current ?? {}) as Record<string, unknown>;
    changed = installed.filter((name) => modeForSkill(overrides, name) === 'on');
    if (changed.length === 0) return false;
    for (const name of changed) overrides[name] = mode;
    settings.skillOverrides = overrides;
    return true;
  }, homeDir);
  cachedSkills = undefined;
  return changed;
}

export async function previewSkillFromIndex(
  id: string,
  paths: ReadonlyMap<string, string>,
  sourceId?: string,
): Promise<{ content: string; truncated: boolean }> {
  const skillPath = sourceId ? paths.get(`${id}:${sourceId}`) : paths.get(id);
  if (!skillPath) throw new LibraryUserError('Không tìm thấy skill để xem trước.');
  const content = await fs.readFile(skillPath);
  const truncated = content.byteLength > PREVIEW_LIMIT_BYTES;
  return { content: content.subarray(0, PREVIEW_LIMIT_BYTES).toString('utf8'), truncated };
}

export async function previewSkill(id: string, sourceId?: string): Promise<{ content: string; truncated: boolean }> {
  return previewSkillFromIndex(id, skillPaths, sourceId);
}

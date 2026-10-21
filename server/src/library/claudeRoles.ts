import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import type { LibraryClaudeRole, LibraryClaudeRoleSet } from '../../../core/src/messages.js';
import { mutateClaudeSettings } from '../providers/hook/claude/claudeHookInstaller.js';
import { LibraryUserError } from './libraryError.js';

const BUILT_INS = [
  { name: 'Explore', description: 'Khám phá mã nguồn, chỉ đọc.' },
  { name: 'Plan', description: 'Lập kế hoạch, chỉ đọc.' },
  { name: 'general-purpose', description: 'Thực hiện các tác vụ tổng quát, có thể sửa tệp.' },
] as const;
const VALID_MODELS: Record<string, true> = { opus: true, sonnet: true, haiku: true, fable: true, inherit: true };
const VALID_EFFORTS: Record<string, true> = { low: true, medium: true, high: true, xhigh: true, max: true };

type Frontmatter = { end: number; fields: Map<string, string>; body: string };
type RoleCandidate = LibraryClaudeRole & { filePath?: string };

function frontmatter(content: string): Frontmatter | null {
  const match = content.match(/^---(\r?\n)([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match || match.index === undefined) return null;
  const fields = new Map<string, string>();
  const lines = match[2].split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const field = lines[index].match(/^([A-Za-z][\w-]*):(?:\s*(.*))?$/);
    if (!field) continue;
    const values = [field[2] ?? ''];
    if (!field[2]?.trim() && (field[1] === 'tools' || field[1] === 'disallowedTools')) {
      for (let next = index + 1; next < lines.length && /^\s+-\s*/.test(lines[next]); next++) {
        values.push(lines[next].replace(/^\s+-\s*/, ''));
        index = next;
      }
    }
    fields.set(field[1], values.join(',').trim().replace(/^(['"])(.*)\1$/, '$2'));
  }
  const end = match.index + match[0].length;
  return { end, fields, body: content.slice(end) };
}

function values(field: string | undefined): string[] {
  if (!field) return [];
  const trimmed = field.trim().replace(/^\[|\]$/g, '');
  return trimmed.split(',').map((value) => value.trim().replace(/^(['"])(.*)\1$/, '$2')).filter(Boolean);
}

function roleFromContent(content: string, source: 'user' | 'plugin', filePath?: string, plugin?: string): RoleCandidate | null {
  const parsed = frontmatter(content);
  if (!parsed) return null;
  const name = parsed.fields.get('name')?.trim();
  if (!name) return null;
  const tools = values(parsed.fields.get('tools'));
  const disallowed = values(parsed.fields.get('disallowedTools'));
  const canWrite = !disallowed.some((tool) => ['Write', 'Edit', 'MultiEdit'].includes(tool)) &&
    (tools.length === 0 || tools.some((tool) => ['Write', 'Edit', 'MultiEdit'].includes(tool)));
  return {
    id: source === 'plugin' ? `plugin:${plugin}:${name}` : `user:${name}`,
    name: source === 'plugin' ? `${plugin}:${name}` : name,
    source,
    ...(plugin ? { plugin } : {}),
    description: parsed.fields.get('description') ?? '',
    model: parsed.fields.get('model') ?? 'inherit',
    effort: parsed.fields.get('effort') ?? null,
    writesFiles: canWrite,
    editable: source === 'user',
    enabled: true,
    ...(filePath ? { filePath } : {}),
  };
}

async function readJson(filePath: string): Promise<Record<string, unknown>> {
  try {
    const value: unknown = JSON.parse(await fs.readFile(filePath, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function enabledFromSettings(settings: Record<string, unknown>, roleName: string): boolean {
  const permissions = settings.permissions && typeof settings.permissions === 'object' && !Array.isArray(settings.permissions)
    ? settings.permissions as Record<string, unknown>
    : {};
  const deny = Array.isArray(permissions.deny) ? permissions.deny : [];
  return !deny.includes(`Agent(${roleName})`);
}

function latestVersion(left: string, right: string): number {
  const a = left.split(/[.-]/).map((part) => /^\d+$/.test(part) ? Number(part) : part);
  const b = right.split(/[.-]/).map((part) => /^\d+$/.test(part) ? Number(part) : part);
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const av = a[index] ?? 0;
    const bv = b[index] ?? 0;
    if (av === bv) continue;
    if (typeof av === 'number' && typeof bv === 'number') return av - bv;
    return String(av).localeCompare(String(bv));
  }
  return 0;
}

async function roleFiles(directory: string): Promise<string[]> {
  try {
    return (await fs.readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
      .map((entry) => path.join(directory, entry.name));
  } catch {
    return [];
  }
}

export async function scanClaudeRoles(homeDir: string): Promise<LibraryClaudeRole[]> {
  const claudeDir = path.join(homeDir, '.claude');
  const settings = await readJson(path.join(claudeDir, 'settings.json'));
  const roles: RoleCandidate[] = BUILT_INS.map((role) => ({
    id: `builtin:${role.name}`, name: role.name, source: 'builtin', description: role.description,
    model: 'inherit', effort: null, writesFiles: role.name === 'general-purpose', editable: false,
    enabled: enabledFromSettings(settings, role.name),
  }));
  for (const filePath of await roleFiles(path.join(claudeDir, 'agents'))) {
    const role = roleFromContent(await fs.readFile(filePath, 'utf8'), 'user', filePath);
    if (role) role.enabled = enabledFromSettings(settings, role.name), roles.push(role);
  }

  const enabledPlugins = settings.enabledPlugins && typeof settings.enabledPlugins === 'object' && !Array.isArray(settings.enabledPlugins)
    ? settings.enabledPlugins as Record<string, unknown> : {};
  const installed = await readJson(path.join(claudeDir, 'plugins', 'installed_plugins.json'));
  const installedPlugins = installed.plugins && typeof installed.plugins === 'object' && !Array.isArray(installed.plugins)
    ? installed.plugins as Record<string, unknown> : installed;
  const cacheRoot = path.join(claudeDir, 'plugins', 'cache');
  for (const [pluginKey, isEnabled] of Object.entries(enabledPlugins)) {
    if (isEnabled !== true) continue;
    const [plugin, marketplace] = pluginKey.split('@');
    if (!plugin || !marketplace) continue;
    const pluginRoot = path.join(cacheRoot, marketplace, plugin);
    const entry = installedPlugins[pluginKey];
    let versions: string[];
    if (Array.isArray(entry)) {
      versions = entry.flatMap((item) => {
        if (!item || typeof item !== 'object') return [];
        const record = item as Record<string, unknown>;
        if (typeof record.version === 'string') return [record.version];
        if (typeof record.installPath === 'string') return [path.basename(record.installPath)];
        return [];
      });
    } else {
      try { versions = (await fs.readdir(pluginRoot, { withFileTypes: true })).filter((item) => item.isDirectory()).map((item) => item.name); }
      catch { versions = []; }
    }
    const version = versions.sort(latestVersion).at(-1);
    if (!version) continue;
    for (const filePath of await roleFiles(path.join(pluginRoot, version, 'agents'))) {
      const role = roleFromContent(await fs.readFile(filePath, 'utf8'), 'plugin', filePath, plugin);
      if (role) role.enabled = enabledFromSettings(settings, role.name), roles.push(role);
    }
  }
  return roles;
}

export async function setClaudeRole(homeDir: string, request: LibraryClaudeRoleSet): Promise<void> {
  const { name } = request;
  if (!name || name.includes('..') || name.includes('/') || name.includes('\\')) throw new LibraryUserError('Không tìm thấy role.');
  const agentsDir = path.resolve(homeDir, '.claude', 'agents');
  const matches: { filePath: string; content: string; parsed: Frontmatter }[] = [];
  for (const filePath of await roleFiles(agentsDir)) {
    const content = await fs.readFile(filePath, 'utf8');
    const parsed = frontmatter(content);
    if (parsed?.fields.get('name') === name) matches.push({ filePath, content, parsed });
  }
  const role = (await scanClaudeRoles(homeDir)).find((candidate) => candidate.name === name);
  if (!role) throw new LibraryUserError('Không tìm thấy role.');
  if (request.model !== undefined || request.effort !== undefined) {
    if (role.source !== 'user' || matches.length !== 1) {
      throw new LibraryUserError('Role này không sửa được model (role có sẵn hoặc của plugin).');
    }
    if (request.model !== undefined && !(VALID_MODELS[request.model] === true || /^claude-[a-z0-9][a-z0-9.-]{0,60}$/.test(request.model))) {
      throw new LibraryUserError('Model không hợp lệ.');
    }
    if (request.effort !== undefined && request.effort !== null && VALID_EFFORTS[request.effort] !== true) {
      throw new LibraryUserError('Effort không hợp lệ.');
    }
    let updated = matches[0].content;
    if (request.model !== undefined) updated = replaceFrontmatterField(updated, 'model', request.model);
    if (request.effort !== undefined) updated = replaceFrontmatterField(updated, 'effort', request.effort ?? undefined);
    const tmpPath = `${matches[0].filePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      await fs.writeFile(tmpPath, updated);
      await fs.rename(tmpPath, matches[0].filePath);
    } catch (error) {
      await fs.rm(tmpPath, { force: true }).catch(() => undefined);
      throw error;
    }
  } else if (matches.length > 1) {
    throw new LibraryUserError('Không tìm thấy role.');
  }
  if (request.enabled !== undefined) {
    await mutateClaudeSettings((settings) => {
      if (settings.permissions !== undefined && (!settings.permissions || typeof settings.permissions !== 'object' || Array.isArray(settings.permissions))) {
        throw new LibraryUserError('Không thể cập nhật quyền role vì mục permissions trong settings.json không hợp lệ.');
      }
      const permissions = settings.permissions === undefined
        ? (settings.permissions = {}) as Record<string, unknown>
        : settings.permissions as Record<string, unknown>;
      if (permissions.deny !== undefined && !Array.isArray(permissions.deny)) {
        throw new LibraryUserError('Không thể cập nhật quyền role vì permissions.deny trong settings.json không hợp lệ.');
      }
      const deny = Array.isArray(permissions.deny) ? permissions.deny as unknown[] : (permissions.deny = []) as unknown[];
      const entry = `Agent(${name})`;
      const filtered = deny.filter((item) => item !== entry);
      if (!request.enabled) filtered.push(entry);
      if (filtered.length === deny.length && filtered.every((item, index) => item === deny[index])) return false;
      permissions.deny = filtered;
      return true;
    }, homeDir);
  }
}

function replaceFrontmatterField(content: string, key: string, value: string | undefined): string {
  const match = content.match(/^---(\r?\n)([\s\S]*?)\r?\n---(?=\r?\n|$)/);
  if (!match) throw new LibraryUserError('Không tìm thấy frontmatter của role.');
  const whole = match[0];
  const closingLength = 3;
  const bodyStart = 3 + match[1].length;
  const bodyEnd = whole.length - closingLength;
  const body = whole.slice(bodyStart, bodyEnd);
  const fieldLine = new RegExp(`^${key}:[^\\r\\n]*(?:\\r?\\n|$)`, 'm');
  if (fieldLine.test(body)) {
    const line = fieldLine.exec(body)?.[0] ?? '';
    const lineEnding = line.match(/\r?\n$/)?.[0] ?? '';
    const updatedBody = value === undefined ? body.replace(fieldLine, '') : body.replace(fieldLine, `${key}: ${value}${lineEnding}`);
    return content.slice(0, bodyStart) + updatedBody + content.slice(bodyEnd);
  }
  if (value === undefined) return content;
  const modelLine = /^model:[^\r\n]*(\r?\n|$)/m.exec(body);
  const lineEnding = match[1];
  const insertion = `${key}: ${value}${lineEnding}`;
  const offset = modelLine && modelLine.index !== undefined ? modelLine.index + modelLine[0].length : body.length;
  const separator = offset === body.length && body.length > 0 && !body.endsWith('\n') ? lineEnding : '';
  const updatedBody = body.slice(0, offset) + separator + insertion + body.slice(offset);
  return content.slice(0, bodyStart) + updatedBody + content.slice(bodyEnd);
}

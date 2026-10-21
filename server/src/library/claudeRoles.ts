import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import type { LibraryClaudeRole, LibraryClaudeRoleSet } from '../../../core/src/messages.js';
import { mutateClaudeSettings } from '../providers/hook/claude/claudeHookInstaller.js';
import { LibraryUserError } from './libraryError.js';

const BUILT_INS = [
  {
    name: 'Explore',
    description: 'Khám phá mã nguồn, chỉ đọc.',
    overrideDescription: 'Fast read-only agent for searching and understanding a codebase. Use to find files, search code, and answer questions about how code works without changing it.',
    color: 'cyan',
  },
  {
    name: 'Plan',
    description: 'Lập kế hoạch, chỉ đọc.',
    overrideDescription: 'Read-only research agent used in plan mode. Use to gather codebase context before presenting a plan.',
    color: 'blue',
  },
  {
    name: 'general-purpose',
    description: 'Thực hiện các tác vụ tổng quát, có thể sửa tệp.',
    overrideDescription: 'General-purpose agent for complex multi-step tasks that need both research and code changes. Use when a task does not fit a more specialized agent.',
    color: 'green',
  },
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
    overridden: false,
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
  const userRoles: RoleCandidate[] = [];
  for (const filePath of await roleFiles(path.join(claudeDir, 'agents'))) {
    const role = roleFromContent(await fs.readFile(filePath, 'utf8'), 'user', filePath);
    if (role) role.enabled = enabledFromSettings(settings, role.name), userRoles.push(role);
  }
  const builtinOverrides = new Map<string, RoleCandidate>();
  for (const role of userRoles) {
    if (BUILT_INS.some((builtin) => builtin.name === role.name)) builtinOverrides.set(role.name, role);
  }
  const roles: RoleCandidate[] = BUILT_INS.map((builtin) => {
    const override = builtinOverrides.get(builtin.name);
    return {
      id: `builtin:${builtin.name}`,
      name: builtin.name,
      source: 'builtin',
      description: builtin.description,
      model: override?.model ?? 'inherit',
      effort: override?.effort ?? null,
      writesFiles: builtin.name === 'general-purpose',
      editable: true,
      enabled: enabledFromSettings(settings, builtin.name),
      overridden: override !== undefined,
    };
  });
  roles.push(...userRoles.filter((role) => !BUILT_INS.some((builtin) => builtin.name === role.name)));

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
  const builtin = BUILT_INS.find((candidate) => candidate.name === name);
  const role = (await scanClaudeRoles(homeDir)).find((candidate) => candidate.name === name);
  if (!builtin && !role) throw new LibraryUserError('Không tìm thấy role.');

  if (request.reset === true) {
    if (!builtin) throw new LibraryUserError('Chỉ có thể khôi phục role có sẵn của Claude.');
    if (matches.length > 1) throw new LibraryUserError('Không thể khôi phục vì có nhiều tệp ghi đè role này.');
    if (matches.length === 1) {
      const firstBodyLine = matches[0].parsed.body.replace(/^\r?\n/, '').split(/\r?\n/, 1)[0];
      if (firstBodyLine !== BUILTIN_OVERRIDE_MARKER) {
        throw new LibraryUserError('Không thể xoá bản ghi đè do người dùng tạo.');
      }
      await fs.unlink(matches[0].filePath);
    } else {
      try {
        await fs.lstat(path.join(agentsDir, `${builtin.name}.md`));
        throw new LibraryUserError('Không thể xoá bản ghi đè do người dùng tạo.');
      } catch (error) {
        if (error instanceof LibraryUserError || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    return;
  }

  if (request.model !== undefined || request.effort !== undefined) {
    if (request.model !== undefined && !(VALID_MODELS[request.model] === true || /^claude-[a-z0-9][a-z0-9.-]{0,60}$/.test(request.model))) {
      throw new LibraryUserError('Model không hợp lệ.');
    }
    if (request.effort !== undefined && request.effort !== null && VALID_EFFORTS[request.effort] !== true) {
      throw new LibraryUserError('Effort không hợp lệ.');
    }
    if (builtin) {
      if (matches.length > 1) throw new LibraryUserError('Không thể sửa vì có nhiều tệp ghi đè role này.');
      let updated = matches[0]?.content ?? builtinOverrideContent(builtin);
      if (request.model !== undefined) updated = replaceFrontmatterField(updated, 'model', request.model);
      if (request.effort !== undefined) updated = replaceFrontmatterField(updated, 'effort', request.effort ?? undefined);
      const filePath = matches[0]?.filePath ?? path.join(agentsDir, `${builtin.name}.md`);
      if (matches.length === 0) {
        try {
          await fs.lstat(filePath);
          throw new LibraryUserError('Không thể ghi đè vì tệp đã tồn tại nhưng không phải role Claude.');
        } catch (error) {
          if (error instanceof LibraryUserError || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
      await writeAtomically(filePath, updated);
    } else {
      if (role?.source !== 'user' || matches.length !== 1) {
        throw new LibraryUserError('Role này không sửa được model (role có sẵn hoặc của plugin).');
      }
      let updated = matches[0].content;
      if (request.model !== undefined) updated = replaceFrontmatterField(updated, 'model', request.model);
      if (request.effort !== undefined) updated = replaceFrontmatterField(updated, 'effort', request.effort ?? undefined);
      await writeAtomically(matches[0].filePath, updated);
    }
  } else if (!builtin && matches.length > 1) {
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

const BUILTIN_OVERRIDE_MARKER = '<!-- board-override: role có sẵn, Agent Board tạo; xoá file này = dùng lại bản gốc của Claude -->';

function builtinOverrideContent(
  builtin: (typeof BUILT_INS)[number],
): string {
  const lines = [
    '---',
    `name: ${builtin.name}`,
    `description: ${builtin.overrideDescription}`,
  ];
  if (builtin.name !== 'general-purpose') lines.push('tools: Read, Grep, Glob, Bash', 'disallowedTools: Write, Edit', 'omitClaudeMd: true');
  lines.push('model: inherit', `color: ${builtin.color}`, '---', BUILTIN_OVERRIDE_MARKER);
  if (builtin.name === 'Explore') {
    lines.push(
      'You are a fast, read-only agent for exploring and understanding a codebase.',
      'Search efficiently and inspect only files relevant to the question.',
      'Never create, edit, or delete files.',
      'Return a concise summary with file paths and line numbers; do not paste whole files.',
    );
  } else if (builtin.name === 'Plan') {
    lines.push(
      'You are a read-only research agent working in plan mode.',
      'Gather the codebase context needed to make a practical implementation plan.',
      'Never create, edit, or delete files.',
      'Return a concise summary with file paths and line numbers; do not paste whole files.',
    );
  } else {
    lines.push(
      'You are a general-purpose agent for complex multi-step research and implementation.',
      'Complete the assigned work rather than stopping after analysis.',
      'Read relevant files before making focused changes.',
      'Report which files you changed and how you verified the result.',
    );
  }
  return `${lines.join('\n')}\n`;
}

async function writeAtomically(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(tempPath, content);
    await fs.rename(tempPath, filePath);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
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

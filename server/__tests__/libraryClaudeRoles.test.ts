import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { scanClaudeRoles, setClaudeRole } from '../src/library/claudeRoles.js';

const tempDirs: string[] = [];

async function fixture(): Promise<string> {
  const home = await mkdtemp(path.join(os.tmpdir(), 'library-claude-roles-'));
  tempDirs.push(home);
  return home;
}

async function addRole(home: string, filename: string, content: string): Promise<void> {
  const directory = path.join(home, '.claude', 'agents');
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, filename), content);
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('Claude roles', () => {
  it('scans built-in, user, and latest enabled plugin roles and skips files without frontmatter', async () => {
    const home = await fixture();
    await addRole(home, 'writer.md', '---\nname: writer\ndescription: Writes code\ntools: [Read, Write]\n---\nBody\n');
    await addRole(home, 'NGUON.md', 'Không phải role');
    for (const version of ['1.0.0', '2.0.0']) {
      const dir = path.join(home, '.claude', 'plugins', 'cache', 'market', 'plugin', version, 'agents');
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, 'reviewer.md'), `---\nname: reviewer\ndescription: ${version}\n---\n`);
    }
    await mkdir(path.join(home, '.claude'), { recursive: true });
    await writeFile(path.join(home, '.claude', 'settings.json'), JSON.stringify({
      enabledPlugins: { 'plugin@market': true },
      permissions: { deny: ['Agent(writer)'] },
    }));
    await writeFile(path.join(home, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({
      plugins: { 'plugin@market': [{ version: '2.0.0' }] },
    }));

    const roles = await scanClaudeRoles(home);
    expect(roles.filter((role) => role.source === 'builtin').map((role) => role.name)).toEqual(['Explore', 'Plan', 'general-purpose']);
    expect(roles.find((role) => role.name === 'writer')).toMatchObject({ source: 'user', writesFiles: true, enabled: false });
    expect(roles.find((role) => role.name === 'plugin:reviewer')).toMatchObject({ source: 'plugin', description: '2.0.0', plugin: 'plugin' });
    expect(roles.some((role) => role.name === 'NGUON')).toBe(false);
  });

  it('updates model and effort while preserving frontmatter body bytes, including CRLF', async () => {
    const home = await fixture();
    const content = Buffer.from('---\r\nname: writer\r\ndescription: test\r\nmodel: sonnet\r\neffort: low\r\n---\r\nbody\r\nbytes\0');
    await addRole(home, 'writer.md', content.toString());
    await setClaudeRole(home, { type: 'libraryClaudeRoleSet', requestId: 'one', name: 'writer', model: 'opus', effort: 'high' });
    const updated = await readFile(path.join(home, '.claude', 'agents', 'writer.md'));
    expect(updated.subarray(updated.indexOf(Buffer.from('body\r\nbytes\0')))).toEqual(content.subarray(content.indexOf(Buffer.from('body\r\nbytes\0'))));
    expect(updated.toString()).toContain('model: opus\r\neffort: high\r\n');
  });

  it('removes effort when null', async () => {
    const home = await fixture();
    await addRole(home, 'writer.md', '---\nname: writer\neffort: low\n---\nbody\n');
    await setClaudeRole(home, { type: 'libraryClaudeRoleSet', requestId: 'one', name: 'writer', effort: null });
    expect(await readFile(path.join(home, '.claude', 'agents', 'writer.md'), 'utf8')).toBe('---\nname: writer\n---\nbody\n');
  });

  it('rejects invalid models, unknown and traversal names', async () => {
    const home = await fixture();
    await addRole(home, 'writer.md', '---\nname: writer\n---\n');
    await expect(setClaudeRole(home, { type: 'libraryClaudeRoleSet', requestId: '1', name: 'writer', model: 'bogus' })).rejects.toThrow('Model không hợp lệ.');
    await expect(setClaudeRole(home, { type: 'libraryClaudeRoleSet', requestId: '2', name: 'missing', model: 'opus' })).rejects.toThrow('Không tìm thấy role.');
    await expect(setClaudeRole(home, { type: 'libraryClaudeRoleSet', requestId: '3', name: '..', model: 'opus' })).rejects.toThrow('Không tìm thấy role.');
  });

  it('disables and enables a role without dropping other settings or deny entries', async () => {
    const home = await fixture();
    await addRole(home, 'writer.md', '---\nname: writer\n---\n');
    const settingsPath = path.join(home, '.claude', 'settings.json');
    const original = { theme: 'dark', permissions: { deny: ['Bash', 'Agent(other)'] }, enabledPlugins: { 'p@m': true } };
    await writeFile(settingsPath, JSON.stringify(original));
    await setClaudeRole(home, { type: 'libraryClaudeRoleSet', requestId: '1', name: 'writer', enabled: false });
    await setClaudeRole(home, { type: 'libraryClaudeRoleSet', requestId: '2', name: 'writer', enabled: true });
    expect(JSON.parse(await readFile(settingsPath, 'utf8'))).toEqual(original);
  });
  it('does not replace a documentation file named after a built-in role', async () => {
    const home = await fixture();
    await addRole(home, 'Explore.md', 'This is documentation, not a Claude role.\\n');
    await expect(setClaudeRole(home, { type: 'libraryClaudeRoleSet', requestId: '1', name: 'Explore', model: 'opus' }))
      .rejects.toThrow('đã tồn tại');
    expect(await readFile(path.join(home, '.claude', 'agents', 'Explore.md'), 'utf8')).toBe('This is documentation, not a Claude role.\\n');
  });
  it('creates an Explore override with official role metadata and avoids duplicating it as a user role', async () => {
    const home = await fixture();
    await setClaudeRole(home, { type: 'libraryClaudeRoleSet', requestId: '1', name: 'Explore', model: 'sonnet', effort: 'high' });
    const filePath = path.join(home, '.claude', 'agents', 'Explore.md');
    const content = await readFile(filePath, 'utf8');
    expect(content).toContain('description: Fast read-only agent for searching and understanding a codebase. Use to find files, search code, and answer questions about how code works without changing it.');
    expect(content).toContain('tools: Read, Grep, Glob, Bash');
    expect(content).toContain('disallowedTools: Write, Edit');
    expect(content).toContain('omitClaudeMd: true');
    expect(content).toContain('color: cyan');
    expect(content.split('---')[2].trimStart()).toMatch(/^<!-- board-override: role có sẵn, Agent Board tạo;/);
    const frontmatter = content.split('---')[1];
    const keys = [...frontmatter.matchAll(/^([A-Za-z][\w]*):/gm)].map((match) => match[1]);
    expect(keys.every((key) => ['name', 'description', 'tools', 'disallowedTools', 'omitClaudeMd', 'model', 'effort', 'color'].includes(key))).toBe(true);
    const roles = await scanClaudeRoles(home);
    expect(roles.find((role) => role.name === 'Explore')).toMatchObject({ source: 'builtin', editable: true, overridden: true, model: 'sonnet', effort: 'high' });
    expect(roles.filter((role) => role.name === 'Explore')).toHaveLength(1);
  });

  it('updates an existing built-in override and resets only board-owned overrides', async () => {
    const home = await fixture();
    await setClaudeRole(home, { type: 'libraryClaudeRoleSet', requestId: '1', name: 'Explore', model: 'sonnet' });
    await setClaudeRole(home, { type: 'libraryClaudeRoleSet', requestId: '2', name: 'Explore', effort: 'xhigh' });
    expect((await scanClaudeRoles(home)).find((role) => role.name === 'Explore')).toMatchObject({ overridden: true, model: 'sonnet', effort: 'xhigh' });
    await setClaudeRole(home, { type: 'libraryClaudeRoleSet', requestId: '3', name: 'Explore', reset: true } as Parameters<typeof setClaudeRole>[1]);
    await expect(readFile(path.join(home, '.claude', 'agents', 'Explore.md'))).rejects.toMatchObject({ code: 'ENOENT' });
    await addRole(home, 'Plan.md', '---\nname: Plan\n---\nTự viết\n');
    await expect(setClaudeRole(home, { type: 'libraryClaudeRoleSet', requestId: '4', name: 'Plan', reset: true } as Parameters<typeof setClaudeRole>[1])).rejects.toThrow('Không thể xoá bản ghi đè do người dùng tạo.');
  });

  it('creates a general-purpose override without a tools restriction', async () => {
    const home = await fixture();
    await setClaudeRole(home, { type: 'libraryClaudeRoleSet', requestId: '1', name: 'general-purpose', model: 'opus' });
    const content = await readFile(path.join(home, '.claude', 'agents', 'general-purpose.md'), 'utf8');
    expect(content).toContain('description: General-purpose agent for complex multi-step tasks that need both research and code changes. Use when a task does not fit a more specialized agent.');
    expect(content).toContain('color: green');
    expect(content).not.toMatch(/^tools:/m);
  });
});

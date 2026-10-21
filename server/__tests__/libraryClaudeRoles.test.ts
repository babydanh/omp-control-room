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

  it('rejects invalid models, unknown and traversal names, and built-in edits', async () => {
    const home = await fixture();
    await addRole(home, 'writer.md', '---\nname: writer\n---\n');
    await expect(setClaudeRole(home, { type: 'libraryClaudeRoleSet', requestId: '1', name: 'writer', model: 'bogus' })).rejects.toThrow('Model không hợp lệ.');
    await expect(setClaudeRole(home, { type: 'libraryClaudeRoleSet', requestId: '2', name: 'missing', model: 'opus' })).rejects.toThrow('Không tìm thấy role.');
    await expect(setClaudeRole(home, { type: 'libraryClaudeRoleSet', requestId: '3', name: '..', model: 'opus' })).rejects.toThrow('Không tìm thấy role.');
    await expect(setClaudeRole(home, { type: 'libraryClaudeRoleSet', requestId: '4', name: 'Explore', model: 'opus' })).rejects.toThrow('Role này không sửa được model');
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
});

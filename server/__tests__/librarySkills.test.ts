import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { previewSkillFromIndex, scanSkills } from '../src/library/skills.js';

const tempDirs: string[] = [];

async function fixture(): Promise<string> {
  const home = await mkdtemp(path.join(os.tmpdir(), 'library-skills-'));
  tempDirs.push(home);
  return home;
}

async function addSkill(root: string, folder: string, content: string): Promise<void> {
  const directory = path.join(root, folder);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'SKILL.md'), content);
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('scanSkills', () => {
  it('merges tools by skill name, reads Claude overrides and skips disabled plugins', async () => {
    const home = await fixture();
    await addSkill(path.join(home, '.omp', 'agent', 'skills'), 'shared', '---\nname: Shared\ndescription: OMP description\n---\n');
    await addSkill(path.join(home, '.claude', 'skills'), 'shared', '---\nname: Shared\ndescription: >\n  Claude description\n  continued\n---\n');
    await addSkill(path.join(home, '.gemini', 'antigravity-cli', 'skills'), 'shared', '---\nname: Shared\ndescription: "Quoted description"\n---\n');
    await addSkill(path.join(home, '.claude', 'plugins', 'cache', 'market', 'enabled', '1.0.0', 'skills'), 'only-plugin', '---\nname: only-plugin\ndescription: plugin\n---\n');
    await addSkill(path.join(home, '.claude', 'plugins', 'cache', 'market', 'disabled', '1.0.0', 'skills'), 'ignored-plugin', '---\nname: ignored-plugin\n---\n');
    await mkdir(path.join(home, '.claude', 'plugins'), { recursive: true });
    await writeFile(path.join(home, '.claude', 'settings.json'), JSON.stringify({
      enabledPlugins: { 'enabled@market': true, 'disabled@market': false },
      skillOverrides: { Shared: { mode: 'name-only' }, 'enabled:only-plugin': { mode: 'off' } },
    }));
    await writeFile(path.join(home, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({
      plugins: { 'enabled@market': [{ version: '1.0.0' }] },
    }));

    const { skills } = await scanSkills(home);
    const shared = skills.find((skill) => skill.name === 'Shared');
    expect(shared?.tools).toEqual(['omp', 'claude', 'agy']);
    expect(shared?.claudeMode).toBe('name-only');
    expect(shared?.description).toBe('OMP description');
    expect(skills.find((skill) => skill.name === 'only-plugin')).toMatchObject({ plugin: 'enabled', claudeMode: 'off' });
    expect(skills.some((skill) => skill.name === 'ignored-plugin')).toBe(false);
  });

  it('parses quoted multiline descriptions, unique-location filtering and stable opaque ids', async () => {
    const home = await fixture();
    await addSkill(path.join(home, '.claude', 'skills'), 'quoted', '---\nname: quoted\ndescription: "A quoted\n  multi-line description"\n---\n');
    await addSkill(path.join(home, '.gemini', 'config', 'skills'), 'agy-only', '---\nname: agy-only\ndescription: >\n  Folded\n  description\n---\n');
    const result = await scanSkills(home);
    expect(result.skills.find((skill) => skill.name === 'quoted')?.description).toBe('A quoted multi-line description');
    expect(result.skills.find((skill) => skill.name === 'agy-only')?.description).toBe('Folded description');
    expect(result.skills.filter((skill) => skill.tools.length === 1).map((skill) => skill.name)).toEqual(['agy-only', 'quoted']);
    for (const skill of result.skills) expect(skill.id).not.toContain(home);
  });

  it('rejects ids outside the index and truncates preview content to 64 KB', async () => {
    const home = await fixture();
    const largeFile = path.join(home, 'SKILL.md');
    await writeFile(largeFile, 'x'.repeat(70 * 1024));
    const index = new Map([['opaque-id', largeFile]]);
    await expect(previewSkillFromIndex(largeFile, index)).rejects.toThrow('Không tìm thấy skill');
    const preview = await previewSkillFromIndex('opaque-id', index);
    expect(preview.content).toHaveLength(64 * 1024);
    expect(preview.truncated).toBe(true);
  });
});

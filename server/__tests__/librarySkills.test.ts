import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { previewSkillFromIndex, scanSkills, setClaudeSkillMode } from '../src/library/skills.js';

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

  it('includes .agents skills and resolves collisions by omp, Claude, agents, then agy priority', async () => {
    const home = await fixture();
    await addSkill(path.join(home, '.omp', 'agent', 'skills'), 'shared', '---\nname: shared\ndescription: Native omp\n---\n');
    await addSkill(path.join(home, '.claude', 'skills'), 'shared', '---\nname: shared\ndescription: Claude\n---\n');
    await addSkill(path.join(home, '.agents', 'skills'), 'shared', '---\nname: shared\ndescription: agents\n---\n');
    await addSkill(path.join(home, '.gemini', 'config', 'skills'), 'shared', '---\nname: shared\ndescription: agy\n---\n');
    await addSkill(path.join(home, '.agents', 'skills'), 'agents-only', '---\nname: agents-only\ndescription: agents only\n---\n');

    const { skills } = await scanSkills(home);
    expect(skills.find((skill) => skill.name === 'shared')).toMatchObject({
      tools: ['omp', 'claude', 'agy'],
      preferredSource: 'omp',
    });
    expect(skills.find((skill) => skill.name === 'agents-only')).toMatchObject({
      tools: ['omp'],
      preferredSource: 'agents',
    });
  });

  it('marks omp ignoredSkills entries without counting them as loaded from omp', async () => {
    const home = await fixture();
    await addSkill(path.join(home, '.omp', 'agent', 'skills'), 'native', '---\nname: native\ndescription: Native\n---\n');
    await addSkill(path.join(home, '.agents', 'skills'), 'blocked', '---\nname: blocked\n---\n');
    await addSkill(path.join(home, '.omp', 'agent', 'skills'), 'shared', '---\nname: shared\ndescription: OMP\n---\n');
    await addSkill(path.join(home, '.agents', 'skills'), 'shared', '---\nname: shared\ndescription: agents\n---\n');
    await mkdir(path.join(home, '.omp', 'agent'), { recursive: true });
    await writeFile(path.join(home, '.omp', 'agent', 'config.yml'), [
      'skills:',
      '  ignoredSkills:',
      '    - agents/blocked',
      '    - agents/shared',
      '',
    ].join('\n'));

    const { skills } = await scanSkills(home);
    expect(skills.find((skill) => skill.name === 'blocked')).toMatchObject({
      tools: [],
      ignoredTools: ['omp'],
    });
    expect(skills.find((skill) => skill.name === 'shared')).toMatchObject({
      description: 'OMP',
      tools: ['omp'],
      ignoredTools: [],
      preferredSource: 'omp',
    });
    expect(skills.find((skill) => skill.name === 'shared')?.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ tool: 'agents', ignored: true }),
    ]));
    expect(skills.find((skill) => skill.name === 'native')).toMatchObject({ tools: ['omp'] });
  });

  it('exposes content differences and keeps Claude plugin skills namespaced from regular skills', async () => {
    const home = await fixture();
    await addSkill(path.join(home, '.claude', 'skills'), 'brainstorming', '---\nname: brainstorming\ndescription: regular\n---\nregular');
    await addSkill(path.join(home, '.agents', 'skills'), 'brainstorming', '---\nname: brainstorming\ndescription: agents variant\n---\nother');
    await addSkill(path.join(home, '.claude', 'plugins', 'cache', 'market', 'superpowers', '1.0.0', 'skills'), 'brainstorming', '---\nname: brainstorming\ndescription: plugin\n---\nplugin');
    await mkdir(path.join(home, '.claude', 'plugins'), { recursive: true });
    await writeFile(path.join(home, '.claude', 'settings.json'), JSON.stringify({
      enabledPlugins: { 'superpowers@market': true },
    }));
    await writeFile(path.join(home, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({
      plugins: { 'superpowers@market': [{ version: '1.0.0' }] },
    }));

    const result = await scanSkills(home);
    const regular = result.skills.find((skill) => skill.name === 'brainstorming');
    const plugin = result.skills.find((skill) => skill.name === 'brainstorming' && skill.plugin === 'superpowers');
    expect(regular).toMatchObject({
      hasContentDifferences: true,
      sources: expect.arrayContaining([
        expect.objectContaining({ tool: 'claude', contentHash: expect.any(String), lineCount: 5 }),
        expect.objectContaining({ tool: 'agents', contentHash: expect.any(String), lineCount: 5 }),
      ]),
    });
    expect(plugin).toMatchObject({ plugin: 'superpowers', sources: [{ tool: 'claude', contentHash: expect.any(String) }] });
    expect(regular?.sources?.[0]?.contentHash).not.toBe(plugin?.sources?.[0]?.contentHash);
    const agentsVersion = regular?.sources?.find((source) => source.tool === 'agents');
    await expect(previewSkillFromIndex(regular?.id ?? '', result.paths, agentsVersion?.id))
      .resolves.toMatchObject({ content: expect.stringContaining('other') });

  });
  it('discovers claude.ai synced skills below the synced UUID directory', async () => {
    const home = await fixture();
    await addSkill(path.join(home, '.claude', 'skills', 'synced'), path.join('account-id', 'docs'), '---\nname: docs\ndescription: Synced docs\n---\n');

    const { skills } = await scanSkills(home);
    expect(skills.find((skill) => skill.name === 'docs')).toMatchObject({
      tools: ['claude'],
      sources: [{ tool: 'claude', kind: 'claude-ai-sync' }],
    });
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

describe('setClaudeSkillMode', () => {
  async function claudeHome(overrides: Record<string, unknown>): Promise<string> {
    const home = await fixture();
    for (const name of ['idle', 'kept-off', 'already']) {
      await addSkill(path.join(home, '.claude', 'skills'), name, `---\nname: ${name}\n---\n`);
    }
    await writeFile(path.join(home, '.claude', 'settings.json'), JSON.stringify({ model: 'sonnet', skillOverrides: overrides }));
    return home;
  }

  async function settingsOf(home: string): Promise<Record<string, unknown>> {
    return JSON.parse(await readFile(path.join(home, '.claude', 'settings.json'), 'utf8')) as Record<string, unknown>;
  }

  it('turns fully loaded user skills to name-only, never loosens off, and keeps other settings', async () => {
    const home = await claudeHome({ 'kept-off': 'off', already: 'name-only' });
    const changed = await setClaudeSkillMode(home, ['idle', 'kept-off', 'already', 'plugin:skill', '../escape'], 'name-only');
    expect(changed).toEqual(['idle']);
    const settings = await settingsOf(home);
    expect(settings.model).toBe('sonnet');
    expect(settings.skillOverrides).toEqual({ 'kept-off': 'off', already: 'name-only', idle: 'name-only' });
  });

  it('refuses when no chosen name is a Claude user skill', async () => {
    const home = await claudeHome({});
    await expect(setClaudeSkillMode(home, ['missing', '..'], 'name-only')).rejects.toThrow('~/.claude/skills');
  });
});

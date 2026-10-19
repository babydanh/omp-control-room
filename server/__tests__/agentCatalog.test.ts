import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  type AgentFileSource,
  agentIsReadOnly,
  BUNDLED_AGENTS,
  findAgent,
  isValidAgentName,
  loadAgentCatalog,
  parseAgentFile,
} from '../src/company/workItems/agentCatalog.js';

const FOLDER = path.join(path.sep, 'work', 'folder');
const REPO_APP = path.join(FOLDER, 'app');
const REPO_LIB = path.join(FOLDER, 'lib');
const HOME = path.join(path.sep, 'home', 'dev');

const FOLDER_AGENTS = path.join(FOLDER, '.omp', 'agents');
const APP_AGENTS = path.join(REPO_APP, '.omp', 'agents');
const LIB_AGENTS = path.join(REPO_LIB, '.omp', 'agents');
const USER_AGENTS = path.join(HOME, '.omp', 'agent', 'agents');

/** Wraps lines in a frontmatter block, followed by a short body. */
function agentText(...lines: string[]): string {
  return ['---', ...lines, '---', 'Body text.'].join('\n');
}

/**
 * An in-memory agent file source. Each key is an absolute file path. A `null` value is a file
 * that is listed but cannot be read. A missing key is a missing file.
 */
function treeOf(entries: Record<string, string | null>): AgentFileSource {
  return {
    async listMarkdown(dir) {
      return Object.keys(entries).filter((file) => path.dirname(file) === dir);
    },
    async read(file) {
      const text = entries[file];
      if (typeof text !== 'string') {
        throw Object.assign(new Error(`EACCES: ${file}`), { code: 'EACCES' });
      }
      return text;
    },
  };
}

describe('parseAgentFile', () => {
  it('reads name and description, stripping one pair of matching quotes', () => {
    const parsed = parseAgentFile(
      agentText("name: 'reviewer'", 'description: "Code review: quality, security"'),
    );
    expect(parsed.name).toBe('reviewer');
    expect(parsed.description).toBe('Code review: quality, security');
    expect(parsed.tools).toBeUndefined();
  });

  it('reads an inline comma list of tools', () => {
    const parsed = parseAgentFile(agentText('description: Reader', 'tools: read, find, grep'));
    expect(parsed.tools).toEqual(['read', 'find', 'grep']);
  });

  it('reads a YAML block list of tools and stops at the next top-level key', () => {
    const parsed = parseAgentFile(agentText('tools:', '  - read', '- "bash"', 'model: @slow'));
    expect(parsed.tools).toEqual(['read', 'bash']);
  });

  it('leaves name undefined when the frontmatter has none', () => {
    const parsed = parseAgentFile(agentText('description: Plain helper'));
    expect(parsed.name).toBeUndefined();
    expect(parsed.description).toBe('Plain helper');
  });

  it('ignores nested keys, which are not top-level', () => {
    const parsed = parseAgentFile(
      agentText('output:', '  properties:', '    name: nested', 'description: top'),
    );
    expect(parsed.name).toBeUndefined();
    expect(parsed.description).toBe('top');
  });

  it('returns no name and an empty description without frontmatter', () => {
    expect(parseAgentFile('name: loose\nBody only.')).toEqual({ description: '' });
  });

  it('treats an unclosed frontmatter block as absent', () => {
    expect(parseAgentFile('---\nname: open\ndescription: never closed')).toEqual({
      description: '',
    });
  });
});

describe('isValidAgentName', () => {
  it('accepts names that start with a letter or digit and use letters, digits, - and _', () => {
    for (const name of ['task', 'security-reviewer', 'Agent_2', '9lives', 'a'.repeat(64)]) {
      expect(isValidAgentName(name)).toBe(true);
    }
  });

  it('rejects empty, punctuated, leading-punctuation, and over-long names', () => {
    for (const name of ['', '-lead', '_lead', 'has space', 'dot.name', 'a/b', 'a'.repeat(65)]) {
      expect(isValidAgentName(name)).toBe(false);
    }
  });
});

describe('agentIsReadOnly', () => {
  it('treats scout, reviewer and security-reviewer as read-only whatever their tools', () => {
    expect(agentIsReadOnly('scout', ['read', 'bash'])).toBe(true);
    expect(agentIsReadOnly('reviewer', undefined)).toBe(true);
    expect(agentIsReadOnly('security-reviewer', ['edit'])).toBe(true);
  });

  it('treats an agent whose tools include none of edit, write, bash as read-only', () => {
    expect(agentIsReadOnly('lookup', ['read', 'grep', 'lsp'])).toBe(true);
  });

  it('treats an agent whose tools include edit, write or bash as not read-only', () => {
    expect(agentIsReadOnly('builder', ['read', 'bash'])).toBe(false);
    expect(agentIsReadOnly('editor', ['edit'])).toBe(false);
    expect(agentIsReadOnly('writer', ['write', 'grep'])).toBe(false);
  });

  it('treats an agent that declares no tools as not read-only', () => {
    expect(agentIsReadOnly('plain', undefined)).toBe(false);
  });
});

describe('BUNDLED_AGENTS', () => {
  it('lists the five bundled agents with their read-only flags', () => {
    expect(
      BUNDLED_AGENTS.map(({ name, readOnly, source }) => ({ name, readOnly, source })),
    ).toEqual([
      { name: 'task', readOnly: false, source: 'bundled' },
      { name: 'scout', readOnly: true, source: 'bundled' },
      { name: 'reviewer', readOnly: true, source: 'bundled' },
      { name: 'security-reviewer', readOnly: true, source: 'bundled' },
      { name: 'sonic', readOnly: false, source: 'bundled' },
    ]);
  });
});

describe('loadAgentCatalog', () => {
  it('returns the bundled agents sorted by name when no agent files exist', async () => {
    const catalog = await loadAgentCatalog({
      homeDir: HOME,
      folderRoot: FOLDER,
      repos: [],
      files: treeOf({}),
    });
    expect(catalog.map((agent) => agent.name)).toEqual([
      'reviewer',
      'scout',
      'security-reviewer',
      'sonic',
      'task',
    ]);
    expect(catalog.every((agent) => agent.source === 'bundled')).toBe(true);
  });

  it('ranks folder root over repo over user over bundled', async () => {
    const files = treeOf({
      [path.join(FOLDER_AGENTS, 'helper.md')]: agentText('description: root helper'),
      [path.join(APP_AGENTS, 'helper.md')]: agentText('description: app helper'),
      [path.join(APP_AGENTS, 'app-only.md')]: agentText('description: app only'),
      [path.join(USER_AGENTS, 'helper.md')]: agentText('description: user helper'),
      [path.join(USER_AGENTS, 'task.md')]: agentText('description: user task'),
    });
    const catalog = await loadAgentCatalog({
      homeDir: HOME,
      folderRoot: FOLDER,
      repos: [REPO_APP],
      files,
    });

    expect(findAgent(catalog, 'helper')).toEqual({
      name: 'helper',
      description: 'root helper',
      readOnly: false,
      source: 'project',
    });
    expect(findAgent(catalog, 'app-only')).toEqual({
      name: 'app-only',
      description: 'app only',
      readOnly: false,
      source: 'project',
    });
    expect(findAgent(catalog, 'task')).toEqual({
      name: 'task',
      description: 'user task',
      readOnly: false,
      source: 'user',
    });
    expect(findAgent(catalog, 'sonic')).toMatchObject({ source: 'bundled' });
  });

  it('includes agents from every repo, and the first repo in the given order wins', async () => {
    const files = treeOf({
      [path.join(APP_AGENTS, 'shared.md')]: agentText('description: from app'),
      [path.join(LIB_AGENTS, 'shared.md')]: agentText('description: from lib'),
      [path.join(LIB_AGENTS, 'lib-only.md')]: agentText('description: lib only'),
    });

    const appFirst = await loadAgentCatalog({
      homeDir: HOME,
      folderRoot: FOLDER,
      repos: [REPO_APP, REPO_LIB],
      files,
    });
    expect(findAgent(appFirst, 'shared')).toMatchObject({
      description: 'from app',
      source: 'project',
    });
    expect(findAgent(appFirst, 'lib-only')).toMatchObject({
      description: 'lib only',
      source: 'project',
    });

    const libFirst = await loadAgentCatalog({
      homeDir: HOME,
      folderRoot: FOLDER,
      repos: [REPO_LIB, REPO_APP],
      files,
    });
    expect(findAgent(libFirst, 'shared')).toMatchObject({ description: 'from lib' });
  });

  it('applies the read-only rule to project and user agents', async () => {
    const files = treeOf({
      [path.join(USER_AGENTS, 'lookup.md')]: agentText('description: Lookup', 'tools: read, grep'),
      [path.join(USER_AGENTS, 'writer.md')]: agentText(
        'description: Writer',
        'tools:',
        '  - read',
        '  - edit',
      ),
      [path.join(FOLDER_AGENTS, 'builder.md')]: agentText(
        'description: Builder',
        'tools: read, bash',
      ),
      [path.join(FOLDER_AGENTS, 'scout.md')]: agentText(
        'description: Custom scout',
        'tools: read, bash',
      ),
    });
    const catalog = await loadAgentCatalog({
      homeDir: HOME,
      folderRoot: FOLDER,
      repos: [],
      files,
    });

    expect(findAgent(catalog, 'lookup')).toMatchObject({ readOnly: true, source: 'user' });
    expect(findAgent(catalog, 'writer')).toMatchObject({ readOnly: false, source: 'user' });
    expect(findAgent(catalog, 'builder')).toMatchObject({ readOnly: false, source: 'project' });
    expect(findAgent(catalog, 'scout')).toMatchObject({ readOnly: true, source: 'project' });
  });

  it('reads files in name order within a layer, and names come from frontmatter', async () => {
    const files = treeOf({
      [path.join(FOLDER_AGENTS, 'b-second.md')]: agentText('name: dup', 'description: from b'),
      [path.join(FOLDER_AGENTS, 'a-first.md')]: agentText('name: dup', 'description: from a'),
      [path.join(FOLDER_AGENTS, 'file-name.md')]: agentText(
        'name: renamed',
        'description: renamed agent',
      ),
    });
    const catalog = await loadAgentCatalog({
      homeDir: HOME,
      folderRoot: FOLDER,
      repos: [],
      files,
    });

    expect(findAgent(catalog, 'dup')).toMatchObject({ description: 'from a' });
    expect(findAgent(catalog, 'renamed')).toMatchObject({
      description: 'renamed agent',
      source: 'project',
    });
    expect(findAgent(catalog, 'file-name')).toBeUndefined();
  });

  it('skips agents whose name is invalid', async () => {
    const files = treeOf({
      [path.join(FOLDER_AGENTS, 'bad name.md')]: agentText('description: spaced'),
      [path.join(FOLDER_AGENTS, 'leading.md')]: agentText('name: "-leading"', 'description: dash'),
      [path.join(FOLDER_AGENTS, 'good_1.md')]: agentText('description: fine'),
    });
    const catalog = await loadAgentCatalog({
      homeDir: HOME,
      folderRoot: FOLDER,
      repos: [],
      files,
    });

    expect(catalog.map((agent) => agent.name)).toEqual([
      'good_1',
      'reviewer',
      'scout',
      'security-reviewer',
      'sonic',
      'task',
    ]);
  });

  it('skips unreadable files and missing directories without throwing', async () => {
    const files = treeOf({
      [path.join(FOLDER_AGENTS, 'helper.md')]: null,
      [path.join(FOLDER_AGENTS, 'ok.md')]: agentText('description: ok agent'),
      [path.join(USER_AGENTS, 'helper.md')]: agentText('description: user helper'),
    });

    const catalog = await loadAgentCatalog({
      homeDir: HOME,
      folderRoot: FOLDER,
      repos: [REPO_APP],
      files,
    });

    expect(findAgent(catalog, 'helper')).toMatchObject({
      description: 'user helper',
      source: 'user',
    });
    expect(findAgent(catalog, 'ok')).toMatchObject({ source: 'project' });
  });

  it('loads the other layers when one directory cannot be listed', async () => {
    const base = treeOf({
      [path.join(USER_AGENTS, 'helper.md')]: agentText('description: user helper'),
    });
    const files: AgentFileSource = {
      listMarkdown: async (dir) => {
        if (dir === FOLDER_AGENTS) throw new Error('EPERM');
        return base.listMarkdown(dir);
      },
      read: (file) => base.read(file),
    };

    const catalog = await loadAgentCatalog({
      homeDir: HOME,
      folderRoot: FOLDER,
      repos: [],
      files,
    });

    expect(findAgent(catalog, 'helper')).toMatchObject({ source: 'user' });
  });
});

describe('findAgent', () => {
  it('finds an agent by exact name', () => {
    expect(findAgent(BUNDLED_AGENTS, 'sonic')).toMatchObject({ name: 'sonic', readOnly: false });
  });

  it('returns undefined for an unknown name or one with different case', () => {
    expect(findAgent(BUNDLED_AGENTS, 'missing')).toBeUndefined();
    expect(findAgent(BUNDLED_AGENTS, 'Task')).toBeUndefined();
  });
});

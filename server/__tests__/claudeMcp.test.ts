import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';

import {
  CLAUDE_MCP_NAMES_MAX,
  claudeMcpConfigJson,
  claudeMcpServerNames,
  isClaudeMcpServerName,
  isShareableEntry,
} from '../src/company/claudeCode/claudeMcp.js';
import { createClaudeMcpSource } from '../src/company/claudeCode/claudeMcpSource.js';

const SECRET = 'sk-test-SECRET-123';
const PROJECT = 'V:/repo/app';
const NO_SERVERS = '{"mcpServers":{}}';

/** A `.claude.json`-shaped config: servers at the top level and one project's own entries. */
const CONFIG = {
  mcpServers: {
    github: { type: 'stdio', command: 'gh-mcp', env: { RAYON_NUM_THREADS: '4' } },
    docs: { type: 'http', url: 'https://docs.example' },
  },
  projects: {
    'V:/repo/app': {
      mcpServers: {
        local: { type: 'stdio', command: 'local-mcp' },
        github: { type: 'stdio', command: 'project-gh', env: { RAYON_NUM_THREADS: '8' } },
      },
    },
    'V:/other': { mcpServers: { elsewhere: { command: 'other-mcp' } } },
  },
};

const CONSOLE_METHODS = ['log', 'info', 'warn', 'error', 'debug'] as const;

/** Spies every console method, silenced, so a test can assert that nothing reached the console. */
function spyConsole(): MockInstance[] {
  return CONSOLE_METHODS.map((method) =>
    vi.spyOn(console, method).mockImplementation(() => undefined),
  );
}

describe('isClaudeMcpServerName', () => {
  it('accepts a string of 1 to 64 characters and refuses anything else', () => {
    expect(isClaudeMcpServerName('github')).toBe(true);
    expect(isClaudeMcpServerName('x'.repeat(64))).toBe(true);
    expect(isClaudeMcpServerName('')).toBe(false);
    expect(isClaudeMcpServerName('x'.repeat(65))).toBe(false);
    expect(isClaudeMcpServerName(42)).toBe(false);
  });
});

describe('claudeMcpServerNames', () => {
  it('lists the top-level servers and the project entry for the path, sorted', () => {
    expect(claudeMcpServerNames(CONFIG, [PROJECT])).toEqual(['docs', 'github', 'local']);
  });

  it('lists no project entry for a path the config does not key', () => {
    expect(claudeMcpServerNames(CONFIG, ['V:/elsewhere'])).toEqual(['docs', 'github']);
  });

  it('matches a project path written with backslashes or a trailing slash', () => {
    expect(claudeMcpServerNames(CONFIG, ['V:\\repo\\app\\'])).toContain('local');
  });

  it.runIf(process.platform === 'win32')('matches a Windows path regardless of case', () => {
    expect(claudeMcpServerNames(CONFIG, ['v:/REPO/app'])).toContain('local');
  });

  it('lists nothing when the config is missing or its tables are not objects', () => {
    expect(claudeMcpServerNames(undefined, [PROJECT])).toEqual([]);
    expect(claudeMcpServerNames({ mcpServers: 'x', projects: [] }, [PROJECT])).toEqual([]);
  });

  it('leaves out a name the squad cannot keep', () => {
    const config = { mcpServers: { ['x'.repeat(65)]: { command: 'long' }, ok: { command: 'a' } } };
    expect(claudeMcpServerNames(config, [])).toEqual(['ok']);
  });
});

describe('claudeMcpConfigJson', () => {
  it('copies each chosen entry verbatim, a project entry winning over the top level', () => {
    expect(JSON.parse(claudeMcpConfigJson(CONFIG, PROJECT, ['github', 'docs']))).toEqual({
      mcpServers: {
        github: CONFIG.projects['V:/repo/app'].mcpServers.github,
        docs: CONFIG.mcpServers.docs,
      },
    });
  });

  it('loads only the chosen names, never a server the squad did not choose', () => {
    const json = claudeMcpConfigJson(CONFIG, PROJECT, ['docs']);
    expect(json).toContain('https://docs.example');
    expect(json).not.toContain('gh-mcp');
    expect(json).not.toContain('local-mcp');
  });

  it('drops a chosen name the config does not define, and an empty choice is no server', () => {
    expect(claudeMcpConfigJson(CONFIG, PROJECT, ['missing', 'constructor'])).toBe(NO_SERVERS);
    expect(claudeMcpConfigJson(CONFIG, PROJECT, [])).toBe(NO_SERVERS);
    expect(claudeMcpConfigJson(undefined, PROJECT, ['docs'])).toBe(NO_SERVERS);
  });
});

describe('credential entries are never listed or copied', () => {
  it('refuses a github server whose env holds a personal access token', () => {
    const config = {
      mcpServers: {
        github: {
          type: 'stdio',
          command: 'gh-mcp',
          env: { GITHUB_PERSONAL_ACCESS_TOKEN: SECRET },
        },
      },
    };
    expect(claudeMcpServerNames(config, [])).toEqual([]);
    expect(claudeMcpConfigJson(config, PROJECT, ['github'])).toBe(NO_SERVERS);
  });

  it.each([
    'api_key',
    'CLIENT_SECRET',
    'DB_PASSWORD',
    'GH_PAT',
    'AUTH_HEADER',
    'MY_CREDENTIALS',
  ])('refuses a server whose env names a credential: %s', (name) => {
    const config = { mcpServers: { svc: { command: 'svc-mcp', env: { [name]: SECRET } } } };
    expect(claudeMcpServerNames(config, [])).toEqual([]);
    expect(claudeMcpConfigJson(config, PROJECT, ['svc'])).toBe(NO_SERVERS);
  });

  it('refuses a server whose headers are written inline', () => {
    const config = {
      mcpServers: {
        api: {
          type: 'http',
          url: 'https://api.example',
          headers: { Authorization: `Bearer ${SECRET}` },
        },
      },
    };
    expect(claudeMcpServerNames(config, [])).toEqual([]);
    expect(claudeMcpConfigJson(config, PROJECT, ['api'])).toBe(NO_SERVERS);
  });

  it('keeps a server whose headers come from headersHelper, and one with a numeric env', () => {
    const helper = { type: 'http', url: 'https://h.example', headersHelper: 'get-headers' };
    const threads = { command: 'rayon-mcp', env: { RAYON_NUM_THREADS: '4' } };
    const config = { mcpServers: { helper, threads } };
    expect(claudeMcpServerNames(config, [])).toEqual(['helper', 'threads']);
    expect(JSON.parse(claudeMcpConfigJson(config, PROJECT, ['helper', 'threads']))).toEqual({
      mcpServers: { helper, threads },
    });
  });

  it('refuses a project entry with a credential even when the top level is clean', () => {
    const config = {
      mcpServers: { github: { type: 'stdio', command: 'gh-mcp' } },
      projects: {
        [PROJECT]: {
          mcpServers: {
            github: {
              type: 'stdio',
              command: 'project-gh',
              env: { GITHUB_PERSONAL_ACCESS_TOKEN: SECRET },
            },
          },
        },
      },
    };
    expect(claudeMcpServerNames(config, [PROJECT])).toEqual([]);
    expect(claudeMcpConfigJson(config, PROJECT, ['github'])).toBe(NO_SERVERS);
    expect(claudeMcpServerNames(config, ['V:/elsewhere'])).toEqual(['github']);
  });

  it('refuses an entry that is not an object', () => {
    expect(isShareableEntry('gh-mcp')).toBe(false);
    expect(isShareableEntry(null)).toBe(false);
    expect(isShareableEntry({ command: 'x' })).toBe(true);
  });
});

describe('MCP config handling never logs', () => {
  let spies: MockInstance[];

  beforeEach(() => {
    spies = spyConsole();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('writes nothing to the console while it refuses entries with a secret', () => {
    const config = {
      mcpServers: {
        github: {
          type: 'stdio',
          command: 'gh-mcp',
          env: { GITHUB_PERSONAL_ACCESS_TOKEN: SECRET },
        },
        docs: { type: 'http', url: 'https://docs.example', headers: { Authorization: SECRET } },
      },
    };
    const names = claudeMcpServerNames(config, [PROJECT]);
    const json = claudeMcpConfigJson(config, PROJECT, ['github', 'docs']);
    expect(names).toEqual([]);
    expect(json).toBe(NO_SERVERS);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});

describe('createClaudeMcpSource', () => {
  let dir: string;
  let path: string;
  let spies: MockInstance[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'claude-mcp-'));
    path = join(dir, '.claude.json');
    spies = spyConsole();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('reads the names and the chosen entries from the config file', () => {
    writeFileSync(path, JSON.stringify(CONFIG));
    const source = createClaudeMcpSource({ configPath: path });
    expect(source.names([PROJECT])).toEqual(['docs', 'github', 'local']);
    expect(JSON.parse(source.configFor(PROJECT, ['docs']))).toEqual({
      mcpServers: { docs: CONFIG.mcpServers.docs },
    });
  });

  it('defines no server when the file is missing or is not JSON, and logs nothing', () => {
    const missing = createClaudeMcpSource({ configPath: join(dir, 'missing.json') });
    expect(missing.names([PROJECT])).toEqual([]);
    expect(missing.configFor(PROJECT, ['github'])).toBe(NO_SERVERS);

    writeFileSync(path, `{"mcpServers":{"github":{"env":{"TOKEN":"${SECRET}"}}}`);
    const broken = createClaudeMcpSource({ configPath: path });
    expect(broken.names([PROJECT])).toEqual([]);
    expect(broken.configFor(PROJECT, ['github'])).toBe(NO_SERVERS);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it('reads the file again when it changes', () => {
    writeFileSync(path, JSON.stringify({ mcpServers: { a: { command: 'a' } } }));
    const source = createClaudeMcpSource({ configPath: path });
    expect(source.names([])).toEqual(['a']);
    writeFileSync(path, JSON.stringify({ mcpServers: { bb: { command: 'b' } } }));
    expect(source.names([])).toEqual(['bb']);
  });

  it('lists at most the maximum number of names', () => {
    const servers = Object.fromEntries(
      Array.from({ length: CLAUDE_MCP_NAMES_MAX + 20 }, (_, index) => [
        `server-${index}`,
        { command: 'x' },
      ]),
    );
    writeFileSync(path, JSON.stringify({ mcpServers: servers }));
    expect(createClaudeMcpSource({ configPath: path }).names([])).toHaveLength(
      CLAUDE_MCP_NAMES_MAX,
    );
  });
});

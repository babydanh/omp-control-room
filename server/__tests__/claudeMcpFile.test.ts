import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';

import {
  CLAUDE_MCP_FILE_PREFIX,
  newClaudeMcpConfigPath,
  removeClaudeMcpConfigFile,
  writeClaudeMcpConfigFile,
} from '../src/company/claudeCode/claudeMcpFile.js';

const JSON_TEXT = '{"mcpServers":{"docs":{"type":"http","url":"https://docs.example"}}}';

describe('newClaudeMcpConfigPath', () => {
  it('names a file in the temp dir after the run, and never gives two calls one name', () => {
    const first = newClaudeMcpConfigPath('run-1');
    const second = newClaudeMcpConfigPath('run-1');
    expect(first.startsWith(tmpdir())).toBe(true);
    expect(first).toContain(`${CLAUDE_MCP_FILE_PREFIX}run-1-`);
    expect(first.endsWith('.json')).toBe(true);
    expect(second).not.toBe(first);
  });

  it('replaces any character outside the safe set in the run id', () => {
    const name = newClaudeMcpConfigPath('a/b c..d').split(/[\\/]/).pop() ?? '';
    expect(name).toMatch(/^pixel-agents-claude-mcp-a_b_c__d-/);
  });
});

describe('writeClaudeMcpConfigFile and removeClaudeMcpConfigFile', () => {
  const made: string[] = [];
  let warn: MockInstance;

  /** A fresh path in the temp dir, recorded so the cleanup removes it even when a test fails. */
  function fresh(): string {
    const path = newClaudeMcpConfigPath('run-files');
    made.push(path);
    return path;
  }

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    for (const path of made.splice(0)) rmSync(path, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('writes the JSON exactly as given', () => {
    const path = fresh();
    writeClaudeMcpConfigFile(path, JSON_TEXT);
    expect(readFileSync(path, 'utf8')).toBe(JSON_TEXT);
  });

  it('refuses to overwrite an existing file, so the first content stays', () => {
    const path = fresh();
    writeClaudeMcpConfigFile(path, JSON_TEXT);
    expect(() => writeClaudeMcpConfigFile(path, '{}')).toThrow();
    expect(readFileSync(path, 'utf8')).toBe(JSON_TEXT);
  });

  it.runIf(process.platform !== 'win32')('creates the file readable by this user only', () => {
    const path = fresh();
    writeClaudeMcpConfigFile(path, JSON_TEXT);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('removes the file, and a file already gone is not an error', () => {
    const path = fresh();
    writeClaudeMcpConfigFile(path, JSON_TEXT);
    removeClaudeMcpConfigFile(path);
    expect(existsSync(path)).toBe(false);
    expect(() => removeClaudeMcpConfigFile(path)).not.toThrow();
    expect(warn).not.toHaveBeenCalled();
  });

  it('logs only the error code when a removal fails, never the path or the content', () => {
    const path = fresh();
    mkdirSync(path);
    expect(() => removeClaudeMcpConfigFile(path)).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]?.[0]);
    expect(message).toContain('could not remove a temporary MCP config file');
    expect(message).not.toContain(path);
  });
});

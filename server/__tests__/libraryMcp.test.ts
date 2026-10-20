import { describe, expect, it } from 'vitest';

import {
  mergeMcpCandidates,
  parseClaudeMcpList,
  parseMcpJson,
} from '../src/library/mcp.js';

describe('library MCP data handling', () => {
  it('merges matching servers from omp, Claude and agy without exposing credentials or arguments', () => {
    const omp = parseMcpJson(JSON.stringify({
      mcpServers: {
        shared: {
          command: '/opt/private/bin/secret-command',
          args: ['ARG_SECRET_7f2'],
          env: { API_TOKEN: 'ENV_SECRET_9a1' },
        },
      },
    }), 'omp');
    const claude = parseMcpJson(JSON.stringify({
      mcpServers: {
        shared: {
          type: 'http',
          url: 'https://user:PASS_SECRET_3c4@example.test:8443/api?token=URL_SECRET_6b8#FRAGMENT_SECRET_2d0',
          headers: { Authorization: 'HEADER_SECRET_4e5' },
        },
      },
    }), 'claude');
    const agy = parseMcpJson(JSON.stringify({
      mcpServers: {
        shared: { url: 'https://example.test/mcp', type: 'http' },
      },
    }), 'agy');

    const merged = mergeMcpCandidates([...omp, ...claude, ...agy]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      name: 'shared',
      tools: ['omp', 'claude', 'agy'],
      commandName: 'secret-command',
      endpoint: 'https://example.test:8443/api',
      status: 'unchecked',
    });
    const publicJson = JSON.stringify(merged);
    for (const secret of [
      'ARG_SECRET_7f2',
      'ENV_SECRET_9a1',
      'PASS_SECRET_3c4',
      'URL_SECRET_6b8',
      'FRAGMENT_SECRET_2d0',
      'HEADER_SECRET_4e5',
    ]) {
      expect(publicJson).not.toContain(secret);
    }
  });

  it('rejects malformed JSON so the caller can record and skip that source', () => {
    expect(() => parseMcpJson('{broken json', 'claude')).toThrow();
  });

  it('parses Claude connection markers without exposing CLI details', () => {
    const statuses = parseClaudeMcpList([
      'connected-server: command - √ Connected',
      'failed-server: URL https://host/?token=CLI_SECRET_12a - ✗ Connection refused',
      'auth-server: command - ! Needs authentication',
      'a noisy status line without a marker',
    ].join('\n'));

    expect([...statuses]).toEqual([
      ['connected-server', 'connected'],
      ['failed-server', 'error'],
      ['auth-server', 'error'],
    ]);
    expect(JSON.stringify([...statuses])).not.toContain('CLI_SECRET_12a');
  });
});

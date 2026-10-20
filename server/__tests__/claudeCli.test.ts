import { describe, expect, it } from 'vitest';

import {
  CLAUDE_AUTH_ARGS,
  CLAUDE_COMMAND,
  CLAUDE_DENIED_TOOLS,
  type ClaudeRunArgs,
  claudeRunArgs,
  claudeStatusLabel,
  claudeTurnArgs,
  clipText,
  parseAuthStatus,
  parseStreamLine,
  parseTurnOutput,
} from '../src/company/claudeCode/claudeCli.js';

const SESSION = '6f1c2b1e-0000-4000-8000-000000000001';
const SCHEMA_JSON = '{"type":"object"}';

/** Edit-run arguments with the usual values filled in; a test overrides only what it varies. */
const BASE_RUN: ClaudeRunArgs = {
  mode: 'edit',
  permission: 'acceptEdits',
  allowedTools: [],
  sessionId: SESSION,
  resume: false,
  maxTurns: 40,
  maxBudgetUsd: 3,
};

const DEFAULT_TOOLS = ['Bash(git status*)', 'Bash(npm run *)'];

describe('claudeRunArgs', () => {
  it('runs an edit in acceptEdits and opens a new session with --session-id', () => {
    expect(claudeRunArgs(BASE_RUN)).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-prompts',
      'none',
      '--permission-mode',
      'acceptEdits',
      '--max-turns',
      '40',
      '--max-budget-usd',
      '3',
      '--disallowedTools',
      'Bash(git push*)',
      'Bash(git reset --hard*)',
      'Bash(git stash*)',
      'Bash(git clean*)',
      'Bash(git checkout -- *)',
      'Bash(git restore*)',
      'Bash(git branch -D*)',
      'Bash(git worktree remove*)',
      '--session-id',
      SESSION,
    ]);
  });

  it('runs an edit in auto mode when the setting says auto', () => {
    const args = claudeRunArgs({ ...BASE_RUN, permission: 'auto' });
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('auto');
    expect(args).not.toContain('acceptEdits');
  });

  it('passes each allowed tool as its own argv element right after --allowedTools', () => {
    const args = claudeRunArgs({ ...BASE_RUN, permission: 'auto', allowedTools: DEFAULT_TOOLS });
    const at = args.indexOf('--allowedTools');
    expect(at).toBeGreaterThan(-1);
    expect(args.slice(at, at + DEFAULT_TOOLS.length + 1)).toEqual([
      '--allowedTools',
      ...DEFAULT_TOOLS,
    ]);
    expect(args.slice(-2)).toEqual(['--session-id', SESSION]);
  });

  it('passes no --allowedTools when the list is empty, in either edit mode', () => {
    for (const permission of ['auto', 'acceptEdits'] as const) {
      expect(claudeRunArgs({ ...BASE_RUN, permission })).not.toContain('--allowedTools');
    }
  });

  it('denies git push and work-losing git commands in every mode, even if the allowlist names them', () => {
    for (const run of [
      { ...BASE_RUN, permission: 'auto' as const, allowedTools: ['Bash(git push*)'] },
      { ...BASE_RUN, permission: 'acceptEdits' as const },
      { ...BASE_RUN, mode: 'read' as const },
    ]) {
      const args = claudeRunArgs(run);
      const at = args.indexOf('--disallowedTools');
      expect(at).toBeGreaterThan(-1);
      expect(args.slice(at + 1, at + 1 + CLAUDE_DENIED_TOOLS.length)).toEqual([...CLAUDE_DENIED_TOOLS]);
      expect(CLAUDE_DENIED_TOOLS).toContain('Bash(git push*)');
    }
  });

  it('passes no --allowedTools to a read, even when tools are listed', () => {
    const args = claudeRunArgs({ ...BASE_RUN, mode: 'read', allowedTools: DEFAULT_TOOLS });
    expect(args).not.toContain('--allowedTools');
    expect(args).not.toContain('Bash(npm run *)');
  });

  it('runs a read in plan mode whatever the edit permission is', () => {
    for (const permission of ['auto', 'acceptEdits'] as const) {
      const args = claudeRunArgs({ ...BASE_RUN, mode: 'read', permission });
      expect(args[args.indexOf('--permission-mode') + 1]).toBe('plan');
      expect(args).not.toContain('acceptEdits');
    }
  });

  it('keeps permission prompts off in every mode', () => {
    for (const mode of ['edit', 'read'] as const) {
      for (const permission of ['auto', 'acceptEdits'] as const) {
        const args = claudeRunArgs({ ...BASE_RUN, mode, permission, allowedTools: DEFAULT_TOOLS });
        expect(args[args.indexOf('--permission-prompts') + 1]).toBe('none');
      }
    }
  });

  it('continues an existing session with --resume instead of --session-id', () => {
    const args = claudeRunArgs({
      ...BASE_RUN,
      permission: 'auto',
      allowedTools: DEFAULT_TOOLS,
      resume: true,
    });
    expect(args.slice(-2)).toEqual(['--resume', SESSION]);
    expect(args).not.toContain('--session-id');
  });

  it('adds --agent after the allowlist and before the session flag only when an agent is given', () => {
    const withAgent = claudeRunArgs({ ...BASE_RUN, allowedTools: ['Edit'], agent: 'reviewer' });
    expect(withAgent.slice(-6)).toEqual([
      '--allowedTools',
      'Edit',
      '--agent',
      'reviewer',
      '--session-id',
      SESSION,
    ]);

    expect(claudeRunArgs(BASE_RUN)).not.toContain('--agent');
  });

  it('never passes --bare', () => {
    for (const mode of ['edit', 'read'] as const) {
      for (const resume of [true, false]) {
        const args = claudeRunArgs({
          ...BASE_RUN,
          mode,
          resume,
          agent: 'a',
          maxTurns: 1,
          maxBudgetUsd: 1,
        });
        expect(args).not.toContain('--bare');
      }
    }
  });
});

describe('claudeTurnArgs', () => {
  it('runs print mode with no tools, no MCP server, no saved session, a JSON schema, and two turns', () => {
    expect(claudeTurnArgs({ model: 'opus', schemaJson: SCHEMA_JSON })).toEqual([
      '-p',
      '--tools',
      '',
      '--strict-mcp-config',
      '--mcp-config',
      '{"mcpServers":{}}',
      '--disallowedTools',
      'mcp__*',
      '--no-session-persistence',
      '--output-format',
      'json',
      '--json-schema',
      SCHEMA_JSON,
      '--model',
      'opus',
      '--max-turns',
      '2',
    ]);
  });

  it('never passes --bare', () => {
    expect(claudeTurnArgs({ model: 'sonnet', schemaJson: SCHEMA_JSON })).not.toContain('--bare');
  });
});

describe('auth command', () => {
  it('uses the claude command with the auth status argv', () => {
    expect(CLAUDE_COMMAND).toBe('claude');
    expect([...CLAUDE_AUTH_ARGS]).toEqual(['auth', 'status']);
  });
});

describe('parseAuthStatus', () => {
  it('reads a signed-in account from loggedIn true and a real authMethod', () => {
    expect(parseAuthStatus(0, '{"loggedIn":true,"authMethod":"claude.ai"}')).toBe('signed_in');
  });

  it('reads the CLI signed-out answer, exit 1 with loggedIn false, as signed out', () => {
    expect(
      parseAuthStatus(1, '{"loggedIn":false,"authMethod":"none","apiProvider":"firstParty"}'),
    ).toBe('signed_out');
  });

  it('reads loggedIn true with authMethod none or missing as signed out', () => {
    expect(parseAuthStatus(0, '{"loggedIn":true,"authMethod":"none"}')).toBe('signed_out');
    expect(parseAuthStatus(0, '{"loggedIn":true}')).toBe('signed_out');
  });

  it('reads an authMethod without a loggedIn true as signed out', () => {
    expect(parseAuthStatus(0, '{"authMethod":"claude.ai"}')).toBe('signed_out');
    expect(parseAuthStatus(0, '{"loggedIn":"true","authMethod":"claude.ai"}')).toBe('signed_out');
  });

  it('lets the JSON answer decide over the exit code', () => {
    expect(parseAuthStatus(1, '{"loggedIn":true,"authMethod":"claude.ai"}')).toBe('signed_in');
  });

  it('reads output that is not a JSON object as unknown, at either exit code', () => {
    expect(parseAuthStatus(0, 'not json')).toBe('unknown');
    expect(parseAuthStatus(0, '[1,2]')).toBe('unknown');
    expect(parseAuthStatus(1, 'Error: not logged in')).toBe('unknown');
  });

  it('reads a probe with no exit code as unknown, not signed out', () => {
    expect(parseAuthStatus(null, '{"loggedIn":true,"authMethod":"claude.ai"}')).toBe('unknown');
  });
});

describe('claudeStatusLabel', () => {
  it('returns the exact Vietnamese label for each state', () => {
    expect(claudeStatusLabel('missing')).toBe('Claude Code: chưa cài');
    expect(claudeStatusLabel('signed_out')).toBe(
      'Claude Code: chưa đăng nhập — chạy `claude` để đăng nhập',
    );
    expect(claudeStatusLabel('signed_in')).toBe('Claude Code: đã đăng nhập (gói Claude)');
    expect(claudeStatusLabel('unknown')).toBe('Claude Code: chưa kiểm tra');
  });
});

describe('parseStreamLine', () => {
  it('reads the init event with its session id', () => {
    expect(
      parseStreamLine(JSON.stringify({ type: 'system', subtype: 'init', session_id: SESSION })),
    ).toEqual({ kind: 'init', sessionId: SESSION });
  });

  it('reads the latest assistant text block as progress', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Đang đọc tệp' }] },
    });
    expect(parseStreamLine(line)).toEqual({ kind: 'progress', text: 'Đang đọc tệp' });
  });

  it('reads a tool-use block as the tool it runs', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Sửa tệp' },
          { type: 'tool_use', name: 'Edit' },
        ],
      },
    });
    expect(parseStreamLine(line)).toEqual({ kind: 'progress', text: 'Dùng công cụ: Edit' });
  });

  it('clips progress to 300 characters', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'a'.repeat(400) }] },
    });
    const event = parseStreamLine(line);
    expect(event?.kind === 'progress' ? event.text.length : -1).toBe(300);
  });

  it('reads the result event with its outcome', () => {
    const line = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'xong',
      session_id: SESSION,
      permission_denials: [{}],
    });
    expect(parseStreamLine(line)).toEqual({
      kind: 'result',
      isError: false,
      subtype: 'success',
      resultText: 'xong',
      sessionId: SESSION,
      permissionDenials: 1,
    });
  });

  it('reads unknown, malformed, and empty lines as nothing', () => {
    expect(parseStreamLine('')).toBeUndefined();
    expect(parseStreamLine('not json')).toBeUndefined();
    expect(parseStreamLine('[1,2]')).toBeUndefined();
    expect(parseStreamLine(JSON.stringify({ type: 'user' }))).toBeUndefined();
    expect(parseStreamLine(JSON.stringify({ type: 'assistant' }))).toBeUndefined();
  });
});

describe('parseTurnOutput', () => {
  it('returns the structured output as JSON when the schema was answered', () => {
    const stdout = JSON.stringify({
      type: 'result',
      is_error: false,
      result: '',
      structured_output: { steps: 2 },
    });
    expect(parseTurnOutput(stdout)).toEqual({ ok: true, text: '{"steps":2}' });
  });

  it('returns the plain result text when there is no structured output', () => {
    const stdout = JSON.stringify({ type: 'result', is_error: false, result: '  Kế hoạch  ' });
    expect(parseTurnOutput(stdout)).toEqual({ ok: true, text: 'Kế hoạch' });
  });

  it('takes the last result line when several are printed', () => {
    const stdout = [
      JSON.stringify({ type: 'result', is_error: false, result: 'cũ' }),
      JSON.stringify({ type: 'result', is_error: false, result: 'mới' }),
      '',
    ].join('\n');
    expect(parseTurnOutput(stdout)).toEqual({ ok: true, text: 'mới' });
  });

  it('returns the clipped error text when the result is an error', () => {
    const stdout = JSON.stringify({ type: 'result', is_error: true, result: 'Hết hạn mức' });
    expect(parseTurnOutput(stdout)).toEqual({ ok: false, reason: 'Hết hạn mức' });
  });

  it('uses a fixed reason for an error with no text', () => {
    const stdout = JSON.stringify({ type: 'result', is_error: true, result: '' });
    expect(parseTurnOutput(stdout)).toEqual({ ok: false, reason: 'Claude Code gặp lỗi.' });
  });

  it('reports empty output as no result', () => {
    expect(parseTurnOutput('')).toEqual({
      ok: false,
      reason: 'Claude Code không trả về kết quả.',
    });
    expect(parseTurnOutput('garbage\nmore garbage')).toEqual({
      ok: false,
      reason: 'Claude Code không trả về kết quả.',
    });
  });

  it('reports an empty answer as empty', () => {
    const stdout = JSON.stringify({ type: 'result', is_error: false, result: '   ' });
    expect(parseTurnOutput(stdout)).toEqual({ ok: false, reason: 'Claude Code trả về rỗng.' });
  });

  it('reads one multi-line JSON document as the result', () => {
    const stdout = JSON.stringify({ type: 'result', is_error: false, result: 'ok' }, null, 2);
    expect(parseTurnOutput(stdout)).toEqual({ ok: true, text: 'ok' });
  });
});

describe('clipText', () => {
  it('returns short text unchanged', () => {
    expect(clipText('abc', 3)).toBe('abc');
    expect(clipText('abc', 10)).toBe('abc');
  });

  it('clips long text to the limit', () => {
    expect(clipText('abcdef', 4)).toBe('abcd');
    expect(clipText('abcdef', 0)).toBe('');
  });

  it('never splits a surrogate pair', () => {
    expect(clipText('a😀b', 2)).toBe('a😀');
    expect(clipText('😀😀', 1)).toBe('😀');
  });
});

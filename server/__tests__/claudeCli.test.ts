import { describe, expect, it } from 'vitest';

import {
  CLAUDE_AUTH_ARGS,
  CLAUDE_COMMAND,
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

describe('claudeRunArgs', () => {
  it('runs an edit with acceptEdits and opens a new session with --session-id', () => {
    expect(
      claudeRunArgs({
        mode: 'edit',
        sessionId: SESSION,
        resume: false,
        maxTurns: 40,
        maxBudgetUsd: 3,
      }),
    ).toEqual([
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
      '--session-id',
      SESSION,
    ]);
  });

  it('runs a read with plan mode', () => {
    const args = claudeRunArgs({
      mode: 'read',
      sessionId: SESSION,
      resume: false,
      maxTurns: 5,
      maxBudgetUsd: 0.5,
    });
    expect(args).toContain('plan');
    expect(args).not.toContain('acceptEdits');
  });

  it('continues an existing session with --resume instead of --session-id', () => {
    const args = claudeRunArgs({
      mode: 'edit',
      sessionId: SESSION,
      resume: true,
      maxTurns: 40,
      maxBudgetUsd: 3,
    });
    expect(args.slice(-2)).toEqual(['--resume', SESSION]);
    expect(args).not.toContain('--session-id');
  });

  it('adds --agent before the session flag only when an agent is given', () => {
    const withAgent = claudeRunArgs({
      mode: 'edit',
      sessionId: SESSION,
      resume: false,
      agent: 'reviewer',
      maxTurns: 40,
      maxBudgetUsd: 3,
    });
    expect(withAgent.slice(-4)).toEqual(['--agent', 'reviewer', '--session-id', SESSION]);

    const withoutAgent = claudeRunArgs({
      mode: 'edit',
      sessionId: SESSION,
      resume: false,
      maxTurns: 40,
      maxBudgetUsd: 3,
    });
    expect(withoutAgent).not.toContain('--agent');
  });

  it('never passes --bare', () => {
    for (const mode of ['edit', 'read'] as const) {
      for (const resume of [true, false]) {
        const args = claudeRunArgs({
          mode,
          sessionId: SESSION,
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
  it('runs print mode with no tools, no saved session, a JSON schema, and two turns', () => {
    expect(claudeTurnArgs({ model: 'opus', schemaJson: SCHEMA_JSON })).toEqual([
      '-p',
      '--tools',
      '',
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
  it('reads a signed-in account from a non-none authMethod', () => {
    expect(parseAuthStatus(0, '{"authMethod":"claude.ai"}')).toBe('signed_in');
    expect(parseAuthStatus(0, '{"authMethod":"oauth_token"}')).toBe('signed_in');
  });

  it('reads none or a missing authMethod as signed out', () => {
    expect(parseAuthStatus(0, '{"authMethod":"none"}')).toBe('signed_out');
    expect(parseAuthStatus(0, '{"loggedIn":false}')).toBe('signed_out');
  });

  it('reads a non-zero exit as signed out', () => {
    expect(parseAuthStatus(1, '{"authMethod":"claude.ai"}')).toBe('signed_out');
  });

  it('reads exit 0 with unparseable output as unknown', () => {
    expect(parseAuthStatus(0, 'not json')).toBe('unknown');
    expect(parseAuthStatus(0, '[1,2]')).toBe('unknown');
  });

  it('reads a probe with no exit code as unknown, not signed out', () => {
    expect(parseAuthStatus(null, '')).toBe('unknown');
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

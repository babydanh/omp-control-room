import * as fs from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import {
  createOmpLeaderRunner,
  execLeaderProcess,
  leaderArgs,
  type LeaderProcessRequest,
  leaderTextFromOutput,
  SquadLeaderError,
} from '../src/company/squad/squadRunner.js';

const COMMAND = { file: 'node', args: ['omp.js'] } as const;

function agentEnd(messages: unknown[]): string {
  return JSON.stringify({ type: 'agent_end', messages, isTerminal: true, yielded: false });
}

function assistant(
  content: unknown[],
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { role: 'assistant', content, stopReason: 'stop', ...extra };
}

const USER = { role: 'user', content: [{ type: 'text', text: 'prompt' }] };

describe('leaderArgs', () => {
  it('runs print mode with no session, no tools, JSON output, and the prompt file last', () => {
    const args = leaderArgs(COMMAND, 'anthropic/claude-x', null, '/tmp/p/prompt.md');
    expect(args).toEqual([
      'omp.js',
      '-p',
      '--no-session',
      '--no-tools',
      '--no-extensions',
      '--no-skills',
      '--no-rules',
      '--no-title',
      '--mode',
      'json',
      '--model',
      'anthropic/claude-x',
      '@/tmp/p/prompt.md',
    ]);
  });

  it('adds the thinking level only when one is given', () => {
    const args = leaderArgs(COMMAND, 'm', 'high', '/tmp/p/prompt.md');
    const at = args.indexOf('--thinking');
    expect(at).toBeGreaterThan(-1);
    expect(args[at + 1]).toBe('high');
    expect(args.at(-1)).toBe('@/tmp/p/prompt.md');
  });
});

describe('leaderTextFromOutput', () => {
  it('reads the answer of the last assistant message, ignoring thinking and noise', () => {
    const stdout = [
      'not json at all',
      JSON.stringify({ type: 'session', id: 's' }),
      JSON.stringify({ type: 'message_update' }),
      agentEnd([
        USER,
        assistant([
          { type: 'thinking', thinking: 'nghĩ' },
          { type: 'text', text: '{"assignments":[],"note":"Xong.","done":true}' },
        ]),
      ]),
    ].join('\n');
    expect(leaderTextFromOutput(stdout)).toBe('{"assignments":[],"note":"Xong.","done":true}');
  });

  it('refuses output with no finished event', () => {
    expect(() => leaderTextFromOutput(JSON.stringify({ type: 'agent_start' }))).toThrow(
      SquadLeaderError,
    );
  });

  it('reports the failure omp recorded for the assistant message', () => {
    const stdout = agentEnd([
      USER,
      assistant([], { stopReason: 'error', errorMessage: 'quota hết' }),
    ]);
    expect(() => leaderTextFromOutput(stdout)).toThrow('Đội trưởng gặp lỗi: quota hết. Thử lại.');
  });

  it('refuses an empty answer', () => {
    const stdout = agentEnd([USER, assistant([{ type: 'thinking', thinking: 'chỉ nghĩ' }])]);
    expect(() => leaderTextFromOutput(stdout)).toThrow('rỗng');
  });
});

describe('createOmpLeaderRunner', () => {
  it('hands omp the prompt through a private file and removes it after the turn', async () => {
    const prompt = 'Yêu cầu: làm trang đăng nhập';
    let seen: LeaderProcessRequest | undefined;
    let promptText = '';
    const runner = createOmpLeaderRunner({
      command: COMMAND,
      cwd: '/work/folder',
      model: 'anthropic/claude-x',
      thinking: null,
      execute: async (request) => {
        seen = request;
        const promptPath = request.args.at(-1)?.slice(1) ?? '';
        promptText = await fs.readFile(promptPath, 'utf8');
        return agentEnd([USER, assistant([{ type: 'text', text: 'OK' }])]);
      },
    });
    const answer = await runner.run(prompt, new AbortController().signal);
    expect(answer).toBe('OK');
    expect(promptText).toBe(prompt);
    expect(seen?.cwd).toBe('/work/folder');
    expect(seen?.file).toBe('node');
    const promptDir = seen?.args.at(-1)?.slice(1, seen.args.at(-1)?.lastIndexOf('/')) ?? '';
    await expect(fs.access(promptDir)).rejects.toThrow();
  });

  it('passes the default timeout to the process', async () => {
    let timeoutMs = 0;
    const runner = createOmpLeaderRunner({
      command: COMMAND,
      cwd: '/work/folder',
      model: 'm',
      thinking: null,
      execute: async (request) => {
        timeoutMs = request.timeoutMs;
        return agentEnd([USER, assistant([{ type: 'text', text: 'OK' }])]);
      },
    });
    await runner.run('x', new AbortController().signal);
    expect(timeoutMs).toBe(240_000);
  });
});

describe('execLeaderProcess', () => {
  const node = process.execPath;

  it('runs the program without a shell and returns its stdout', async () => {
    const stdout = await execLeaderProcess({
      file: node,
      args: ['-e', 'process.stdout.write("ok " + process.argv.length)', 'a b;c'],
      cwd: process.cwd(),
      timeoutMs: 20_000,
      signal: new AbortController().signal,
    });
    expect(stdout.startsWith('ok ')).toBe(true);
  });

  // Integration exception: the kill-on-timeout path only exists against the platform clock, since a
  // fake timer cannot stop a real child process. The child spins until the limit kills it.
  it('turns a run past the time limit into a Vietnamese leader error', async () => {
    await expect(
      execLeaderProcess({
        file: node,
        args: ['-e', 'for (;;) {}'],
        cwd: process.cwd(),
        timeoutMs: 300,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('quá lâu');
  });
});

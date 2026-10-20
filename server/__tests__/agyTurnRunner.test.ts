import { describe, expect, it } from 'vitest';

import { createAgyTurnRunner } from '../src/company/agyCode/agyTurnRunner.js';
import type {
  ClaudeChildProcess,
  ClaudeReadable,
  ClaudeSpawn,
  ClaudeWritable,
} from '../src/company/claudeCode/claudeProcess.js';
import { SquadLeaderError } from '../src/company/squad/squadRunner.js';

function fakeSpawn(
  stdout: string,
  exitCode = 0,
  calls?: { file: string; args: readonly string[]; cwd: string; prompt: string }[],
): ClaudeSpawn {
  return (file, args, options) => {
    let onStdout: ((chunk: Buffer) => void) | undefined;
    let onClose: ((code: number | null) => void) | undefined;
    let prompt = '';
    const child = {
      pid: 123,
      stdin: {
        on: () => undefined,
        write: (chunk: string) => {
          prompt += chunk;
          return true;
        },
        end: () => {
          calls?.push({ file, args, cwd: options.cwd, prompt });
          queueMicrotask(() => {
            onStdout?.(Buffer.from(stdout));
            onClose?.(exitCode);
          });
        },
      } satisfies ClaudeWritable,
      stdout: {
        on: (_event: 'data', listener: (chunk: Buffer) => void) => {
          onStdout = listener;
        },
      } satisfies ClaudeReadable,
      stderr: { on: () => undefined } satisfies ClaudeReadable,
      on: (
        event: 'close' | 'error',
        listener: ((code: number | null) => void) | ((error: Error) => void),
      ) => {
        if (event === 'close') onClose = listener as (code: number | null) => void;
      },
      kill: () => true,
    } satisfies ClaudeChildProcess;
    return child;
  };
}

function successfulResult(response: string): string {
  return JSON.stringify({ status: 'SUCCESS', response });
}

describe('createAgyTurnRunner', () => {
  it('passes the prompt through stdin and returns the schema response', async () => {
    const calls: { file: string; args: readonly string[]; cwd: string; prompt: string }[] = [];
    const runner = createAgyTurnRunner({
      cwd: 'C:/workspace',
      label: 'Giám khảo',
      schema: { type: 'object', properties: { ok: { type: 'boolean' } } },
      spawn: fakeSpawn(successfulResult('{"ok":true}'), 0, calls),
    });

    await expect(runner.run('prompt dài', new AbortController().signal)).resolves.toBe('{"ok":true}');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ file: 'agy', cwd: 'C:/workspace', prompt: 'prompt dài' });
    expect(calls[0]?.args).toContain('--json-schema');
    expect(calls[0]?.args).toContain('--input-format');
    expect(calls[0]?.args).toContain('text');
  });

  it('reports a missing agy executable in Vietnamese', async () => {
    const runner = createAgyTurnRunner({
      cwd: '/workspace',
      label: 'Trưởng đội',
      schema: {},
      spawn: (() => {
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      }) as ClaudeSpawn,
    });
    await expect(runner.run('prompt', new AbortController().signal)).rejects.toThrow(
      'Không tìm thấy Antigravity CLI',
    );
  });

  it('reports unsuccessful status and non-JSON output', async () => {
    const failed = createAgyTurnRunner({
      cwd: '/workspace',
      label: 'Giám khảo',
      schema: {},
      spawn: fakeSpawn(JSON.stringify({ status: 'ERROR', error: 'bị từ chối' })),
    });
    await expect(failed.run('prompt', new AbortController().signal)).rejects.toThrow(
      'bị từ chối',
    );

    const malformed = createAgyTurnRunner({
      cwd: '/workspace',
      label: 'Giám khảo',
      schema: {},
      spawn: fakeSpawn('not json'),
    });
    await expect(malformed.run('prompt', new AbortController().signal)).rejects.toThrow(
      'không phải JSON',
    );
  });
  it('reports its bounded timeout', async () => {
    const runner = createAgyTurnRunner({
      cwd: '/workspace',
      label: 'Giám khảo',
      schema: {},
      spawn: fakeSpawn(successfulResult('unused')),
      timeoutMs: 1,
      setTimer: (callback) => {
        queueMicrotask(callback);
        return null;
      },
      clearTimer: () => undefined,
    });
    await expect(runner.run('prompt', new AbortController().signal)).rejects.toBeInstanceOf(
      SquadLeaderError,
    );
  });
});

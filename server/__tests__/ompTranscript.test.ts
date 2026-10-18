import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  OMP_HEAD_BYTES,
  OMP_TAIL_BYTES,
  OMP_TOOL_USAGE_LIMIT,
  ompAgentFields,
  parseMcpToolName,
  readOmpTranscript,
} from '../src/herdr/ompTranscript.js';

interface CallSpec {
  readonly name: string;
  readonly args?: Record<string, unknown>;
}

let dir: string;

beforeEach(async () => {
  dir = path.join(os.tmpdir(), `omp-transcript-${randomUUID()}`);
  await fs.mkdir(dir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

/** Writes entries as JSON lines, then `rawTail` as-is, which may be a half-written line. */
async function writeTranscript(entries: readonly unknown[], rawTail = ''): Promise<string> {
  const file = path.join(dir, `${randomUUID()}.jsonl`);
  const body = entries.map((entry) => JSON.stringify(entry)).join('\n');
  await fs.writeFile(file, `${body}\n${rawTail}`);
  return file;
}

/** An assistant message making the given tool calls, the way omp records them. */
function assistant(calls: readonly CallSpec[], extra: Record<string, unknown> = {}): unknown {
  return {
    type: 'message',
    message: {
      role: 'assistant',
      ...extra,
      content: calls.map((call) => ({
        type: 'toolCall',
        id: randomUUID(),
        name: call.name,
        arguments: call.args ?? {},
      })),
    },
  };
}

describe('readOmpTranscript', () => {
  it('reads the header, model, thinking, tool usage, and skills of a short transcript', async () => {
    const file = await writeTranscript([
      { type: 'session', version: 3, id: 's1', cwd: 'D:\\' },
      { type: 'model_change', model: 'anthropic/claude-haiku-5-5' },
      { type: 'thinking_level_change', thinkingLevel: 'xhigh' },
      assistant([{ name: 'read', args: { path: 'skill://lavish' } }, { name: 'bash' }], {
        provider: 'anthropic',
        model: 'claude-opus-5-5',
        requestControls: {
          tools: {
            declared: ['read', 'bash'],
            deferred: ['mcp__openviking_find'],
            active: ['read', 'bash'],
          },
        },
      }),
      assistant([
        { name: 'read', args: { path: 'skill://lavish/SKILL.md' } },
        { name: 'read', args: { path: 'src/a.ts' } },
      ]),
    ]);

    const summary = await readOmpTranscript(file);

    expect(summary).toMatchObject({
      sessionFile: file,
      sessionCwd: 'D:\\',
      model: 'anthropic/claude-opus-5-5',
      thinking: 'xhigh',
      declaredTools: ['read', 'bash', 'mcp__openviking_find'],
      activeTools: ['read', 'bash'],
      toolUsage: [
        { name: 'read', count: 3 },
        { name: 'bash', count: 1 },
      ],
      skillsRead: ['lavish'],
      truncated: false,
    });
  });

  it('gives the board fields with MCP servers, active flags, and skills', async () => {
    const file = await writeTranscript([
      { type: 'model_change', model: 'anthropic/claude-opus-5-5' },
      { type: 'thinking_level_change', thinkingLevel: 'high' },
      assistant([{ name: 'read', args: { path: 'skill://lavish' } }, { name: 'bash' }], {
        provider: 'anthropic',
        model: 'claude-opus-5-5',
        requestControls: {
          tools: {
            declared: ['read', 'bash'],
            deferred: ['mcp__openviking_find'],
            active: ['read', 'bash'],
          },
        },
      }),
    ]);

    const fields = ompAgentFields(await readOmpTranscript(file));

    expect(fields).toEqual({
      model: 'anthropic/claude-opus-5-5',
      thinking: 'high',
      sessionFile: file,
      tools: [
        { name: 'bash', source: 'builtin', active: true },
        { name: 'mcp__openviking_find', source: 'mcp', mcpServer: 'openviking', active: false },
        { name: 'read', source: 'builtin', active: true },
      ],
      skills: [{ name: 'lavish', used: true }],
      toolUsage: [
        { name: 'bash', count: 1 },
        { name: 'read', count: 1 },
      ],
    });
  });

  it('skips a half-written last line and any line that is not JSON', async () => {
    const file = await writeTranscript(
      [{ type: 'model_change', model: 'anthropic/claude-haiku-5-5' }],
      'not json\n{"type":"model_change","model":"anthropic/claude-opus-5-5"',
    );

    const summary = await readOmpTranscript(file);

    expect(summary.model).toBe('anthropic/claude-haiku-5-5');
  });

  it('refuses paths that are not absolute .jsonl files', async () => {
    const notes = path.join(dir, 'notes.txt');
    const folder = path.join(dir, 'folder.jsonl');
    await fs.writeFile(notes, '{}\n');
    await fs.mkdir(folder);

    await expect(readOmpTranscript('relative.jsonl')).rejects.toThrow();
    await expect(readOmpTranscript(notes)).rejects.toThrow();
    await expect(readOmpTranscript(folder)).rejects.toThrow();
  });

  it('counts usage from the tail of a long transcript and reads the header from its head', async () => {
    const filler = 'x'.repeat(OMP_HEAD_BYTES + OMP_TAIL_BYTES);
    const file = await writeTranscript([
      { type: 'session', version: 3, id: 's1', cwd: 'D:\\' },
      assistant([{ name: 'grep' }]),
      { type: 'custom', data: filler },
      { type: 'model_change', model: 'anthropic/claude-opus-5-5' },
      assistant([
        { name: 'bash' },
        { name: 'bash' },
        { name: 'read', args: { path: 'skill://lavish' } },
      ]),
    ]);

    const summary = await readOmpTranscript(file);

    expect(summary).toMatchObject({
      sessionCwd: 'D:\\',
      model: 'anthropic/claude-opus-5-5',
      toolUsage: [
        { name: 'bash', count: 2 },
        { name: 'read', count: 1 },
      ],
      skillsRead: ['lavish'],
      truncated: true,
    });
  });

  it('keeps the most used 50 tools, most used first', async () => {
    const tools = OMP_TOOL_USAGE_LIMIT + 10;
    const entries = Array.from({ length: tools }, (_, index) =>
      assistant(Array.from({ length: index + 1 }, () => ({ name: `tool_${index}` }))),
    );
    const file = await writeTranscript(entries);

    const { toolUsage } = await readOmpTranscript(file);

    expect(toolUsage).toHaveLength(OMP_TOOL_USAGE_LIMIT);
    expect(toolUsage[0]).toEqual({ name: `tool_${tools - 1}`, count: tools });
    expect(toolUsage[OMP_TOOL_USAGE_LIMIT - 1]).toEqual({
      name: `tool_${tools - OMP_TOOL_USAGE_LIMIT}`,
      count: tools - OMP_TOOL_USAGE_LIMIT + 1,
    });
  });
});

describe('parseMcpToolName', () => {
  it('splits the server at the first underscore after the prefix, as omp does', () => {
    expect(parseMcpToolName('mcp__openviking_write')).toEqual({
      server: 'openviking',
      tool: 'write',
    });
    expect(parseMcpToolName('mcp__my_server_tool')).toEqual({
      server: 'my',
      tool: 'server_tool',
    });
  });

  it('returns undefined for names that are not MCP tools', () => {
    expect(parseMcpToolName('read')).toBeUndefined();
    expect(parseMcpToolName('mcp__noseparator')).toBeUndefined();
    expect(parseMcpToolName('mcp___tool')).toBeUndefined();
  });
});

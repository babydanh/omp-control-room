/**
 * The slash vocabulary the composer speaks.
 *
 * These are the rules OMP's own dispatcher applies, so each block names the
 * source line it is holding to. A failure here means the box and the terminal
 * have drifted apart, not that a preference changed.
 */

import { describe, expect, it } from 'vitest';

import {
  commandCompletionQuery,
  commandCompletions,
  lookupSlashCommand,
  OMP_SLASH_COMMANDS,
  ompModelMessage,
  parseSlashCommand,
  resolveSlashCommand,
} from '../src/company/slashCommands.js';

describe('the transcribed OMP vocabulary', () => {
  it('covers every registry file, not just the ones the box uses', () => {
    const files = new Set(OMP_SLASH_COMMANDS.map((command) => command.source.split(':')[0]));
    expect([...files].sort()).toEqual([
      'src/slash-commands/builtin-collaboration.ts',
      'src/slash-commands/builtin-control.ts',
      'src/slash-commands/builtin-lifecycle.ts',
      'src/slash-commands/builtin-marketplace.ts',
      'src/slash-commands/builtin-modes.ts',
      'src/slash-commands/builtin-session.ts',
      'src/slash-commands/builtin-skills.ts',
    ]);
  });

  it('carries a citable source for every entry and no duplicate name', () => {
    const names = OMP_SLASH_COMMANDS.map((command) => command.name);
    expect(new Set(names).size).toBe(names.length);
    for (const command of OMP_SLASH_COMMANDS) {
      expect(command.source, command.name).toMatch(/^src\/slash-commands\/[\w-]+\.ts:\d+$/);
      expect(command.description.length, command.name).toBeGreaterThan(0);
    }
  });

  it('declares the two model commands exactly as OMP does', () => {
    // builtin-modes.ts:451-454 — no `allowArgs`, alias `models`.
    expect(OMP_SLASH_COMMANDS.find((command) => command.name === 'model')).toMatchObject({
      aliases: ['models'],
      allowArgs: false,
    });
    // builtin-modes.ts:495-503 — takes an argument.
    expect(OMP_SLASH_COMMANDS.find((command) => command.name === 'switch')).toMatchObject({
      allowArgs: true,
      inlineHint: '[model]',
    });
  });
});

describe('parsing a slash invocation (OMP helpers/parse.ts:22-36)', () => {
  it('splits on the earliest whitespace or colon', () => {
    expect(parseSlashCommand('/foo bar baz')).toMatchObject({ name: 'foo', args: 'bar baz' });
    expect(parseSlashCommand('/foo:bar')).toMatchObject({ name: 'foo', args: 'bar' });
    // Whichever comes first wins, so `/a:b c` is the command `a`.
    expect(parseSlashCommand('/a:b c')).toMatchObject({ name: 'a', args: 'b c' });
  });

  it('is not an invocation without a leading slash or a name', () => {
    expect(parseSlashCommand('foo')).toBeNull();
    expect(parseSlashCommand('/')).toBeNull();
    expect(parseSlashCommand('')).toBeNull();
  });
});

describe('the accept gate (OMP builtin-registry.ts:133-140)', () => {
  it('accepts a builtin by name and by alias', () => {
    expect(resolveSlashCommand('/compact')).toMatchObject({ command: { name: 'compact' } });
    expect(resolveSlashCommand('/models')).toMatchObject({ command: { name: 'model' } });
    // `/force:Bash` reaches `force` because `:` separates — that is the whole
    // reason OMP registers the `force:` alias (builtin-control.ts:12).
    expect(resolveSlashCommand('/force:Bash')).toMatchObject({
      command: { name: 'force' },
      parsed: { args: 'Bash' },
    });
  });

  it('declines arguments for a command that declares none', () => {
    // `/model` sets no allowArgs, so in the TUI `/model x` is not a command
    // and goes to the model as text. Only `/switch` takes an argument.
    expect(resolveSlashCommand('/model stealthy/bunnies')).toBeNull();
    expect(resolveSlashCommand('/model')).toMatchObject({ command: { name: 'model' } });
    expect(resolveSlashCommand('/switch stealthy/bunnies')).toMatchObject({
      command: { name: 'switch' },
      parsed: { args: 'stealthy/bunnies' },
    });
  });

  it('declines an unknown name so the text stays a prompt', () => {
    expect(resolveSlashCommand('/definitely-not-a-command')).toBeNull();
    expect(resolveSlashCommand('not a command')).toBeNull();
  });

  it('does not answer for a name inherited from Object.prototype', () => {
    expect(lookupSlashCommand('constructor')).toBeUndefined();
    expect(lookupSlashCommand('toString')).toBeUndefined();
  });
});

describe('name completion (OMP completes only the first token)', () => {
  it('offers matches only while no separator has been typed', () => {
    expect(commandCompletionQuery('/mo')).toBe('mo');
    expect(commandCompletionQuery('/switch ste')).toBeNull();
    expect(commandCompletionQuery('/force:')).toBeNull();
    expect(commandCompletionQuery('mo')).toBeNull();
  });

  it('matches on a prefix and follows an alias', () => {
    expect(commandCompletions('mo').map((command) => command.name)).toContain('model');
    expect(commandCompletions('models').map((command) => command.name)).toContain('model');
    expect(commandCompletions('zzz')).toEqual([]);
  });
});

describe("OMP's model-command replies", () => {
  it('reuses the terminal wording, including the no-model form', () => {
    expect(ompModelMessage('unknown', 'nope')).toBe(
      'Model không xác định: nope. Hãy dùng ACP `session/setModel` để chọn qua bảng chọn, hoặc liệt kê model có sẵn bằng /model.',
    );
    expect(ompModelMessage('set', 'stealthy/bunnies')).toBe('Đã đặt model thành stealthy/bunnies.');
    expect(ompModelMessage('switched', 'stealthy/bunnies')).toBe('Model chỉ dùng cho phiên này: stealthy/bunnies.');
    expect(ompModelMessage('current', 'stealthy/bunnies')).toBe('Model hiện tại: stealthy/bunnies');
    expect(ompModelMessage('current', '')).toBe('Chưa chọn model nào.');
  });
});

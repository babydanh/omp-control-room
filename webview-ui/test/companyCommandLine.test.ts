import { describe, expect, it } from 'vitest';

import {
  COMMAND_NEEDLE_MAX_CHARS,
  commandNeedle,
  findCommandLine,
} from '../src/company/commandLine.js';

describe('commandNeedle', () => {
  it('collapses whitespace runs and trims both ends', () => {
    expect(commandNeedle('  npm   run\t build  ')).toBe('npm run build');
  });

  it('returns null for a blank command', () => {
    expect(commandNeedle('')).toBeNull();
    expect(commandNeedle('   \t ')).toBeNull();
  });

  it('truncates to 80 code points without splitting a surrogate pair', () => {
    const needle = commandNeedle('😀'.repeat(90));
    expect(needle).toBe('😀'.repeat(COMMAND_NEEDLE_MAX_CHARS));
    expect(Array.from(needle ?? '')).toHaveLength(80);
  });
});

describe('findCommandLine', () => {
  it('returns the index of the newest line containing the command', () => {
    const lines = ['$ make', 'build ok', '$ make', 'done'];
    expect(findCommandLine(lines, 'make')).toBe(2);
  });

  it('matches across whitespace differences in the captured line', () => {
    const lines = ['$   npm    test', 'output'];
    expect(findCommandLine(lines, 'npm test')).toBe(0);
  });

  it('returns null when no line contains the command', () => {
    expect(findCommandLine(['alpha', 'beta'], 'gamma')).toBeNull();
  });

  it('returns null for an empty command even when lines exist', () => {
    expect(findCommandLine(['alpha'], '   ')).toBeNull();
  });

  it('returns null for an empty line list', () => {
    expect(findCommandLine([], 'npm test')).toBeNull();
  });

  it('counts a line that merely contains the command', () => {
    expect(findCommandLine(['prompt> git status --short'], 'git status')).toBe(0);
  });

  it('matches on the truncated prefix of a long command', () => {
    const long = 'x'.repeat(80) + 'TAIL';
    expect(findCommandLine([`echo ${'x'.repeat(80)}`], long)).toBe(0);
  });
});

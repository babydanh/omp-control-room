import { describe, expect, it } from 'vitest';

import { defaultFolderName, folderNameError } from '../src/company/folderName.js';

describe('folderNameError', () => {
  it('accepts an ordinary name', () => {
    expect(folderNameError('du-an 2')).toBeNull();
  });

  it('refuses a blank name', () => {
    expect(folderNameError('')).toBe('Hãy nhập tên thư mục.');
    expect(folderNameError('   ')).toBe('Hãy nhập tên thư mục.');
  });

  it('accepts exactly 255 characters and refuses 256', () => {
    expect(folderNameError('a'.repeat(255))).toBeNull();
    expect(folderNameError('a'.repeat(256))).toBe('Tên thư mục dài tối đa 255 ký tự.');
  });

  it('refuses the characters a path or a Windows name cannot hold', () => {
    for (const char of ['/', '\\', ':', '*', '?', '"', '<', '>', '|']) {
      expect(folderNameError(`a${char}b`)).toMatch(/không được chứa/);
    }
  });

  it('refuses the relative names . and ..', () => {
    expect(folderNameError('.')).not.toBeNull();
    expect(folderNameError('..')).not.toBeNull();
  });

  it('refuses a trailing dot, and trims a surrounding space before checking', () => {
    expect(folderNameError('docs.')).not.toBeNull();
    expect(folderNameError('docs ')).toBeNull();
    expect(folderNameError('  docs  ')).toBeNull();
  });

  it('refuses the Windows device names, with or without an extension, in any case', () => {
    expect(folderNameError('CON')).not.toBeNull();
    expect(folderNameError('lpt3')).not.toBeNull();
    expect(folderNameError('nul.txt')).not.toBeNull();
    expect(folderNameError('console')).toBeNull();
    expect(folderNameError('com10')).toBeNull();
  });
});

describe('defaultFolderName', () => {
  it('is the last segment of the path, whatever the separator', () => {
    expect(defaultFolderName('D:\\du-an\\')).toBe('du-an');
    expect(defaultFolderName('/home/me/app')).toBe('app');
  });
});

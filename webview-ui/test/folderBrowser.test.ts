import { describe, expect, it } from 'vitest';

import {
  breadcrumbs,
  defaultFolderName,
  filterFolderEntries,
  folderNameError,
  stepHighlight,
} from '../src/company/folderBrowser.js';

describe('breadcrumbs', () => {
  it('walks a Windows path down from its drive, keeping the separator the path used', () => {
    expect(breadcrumbs('D:\\du-an\\src')).toEqual([
      { label: 'D:', path: 'D:\\' },
      { label: 'du-an', path: 'D:\\du-an' },
      { label: 'src', path: 'D:\\du-an\\src' },
    ]);
  });

  it('reads forward slashes on Windows, and ignores repeated or trailing separators', () => {
    expect(breadcrumbs('D:/du-an//src/')).toEqual([
      { label: 'D:', path: 'D:/' },
      { label: 'du-an', path: 'D:/du-an' },
      { label: 'src', path: 'D:/du-an/src' },
    ]);
  });

  it('starts a posix path at the root', () => {
    expect(breadcrumbs('/home/me/app')).toEqual([
      { label: '/', path: '/' },
      { label: 'home', path: '/home' },
      { label: 'me', path: '/home/me' },
      { label: 'app', path: '/home/me/app' },
    ]);
  });

  it('is the drive alone for a drive root, and empty for an empty path', () => {
    expect(breadcrumbs('D:\\')).toEqual([{ label: 'D:', path: 'D:\\' }]);
    expect(breadcrumbs('')).toEqual([]);
  });
});

describe('filterFolderEntries', () => {
  const entries = [{ name: 'Backend' }, { name: 'frontend' }, { name: 'docs' }];

  it('keeps the folders whose name contains the filter, ignoring case', () => {
    expect(filterFolderEntries(entries, 'END')).toEqual([
      { name: 'Backend' },
      { name: 'frontend' },
    ]);
  });

  it('trims the filter, and a blank filter keeps every folder in order', () => {
    expect(filterFolderEntries(entries, '  doc ')).toEqual([{ name: 'docs' }]);
    expect(filterFolderEntries(entries, '   ')).toEqual(entries);
  });

  it('returns a new list, so the listing the caller holds is never changed', () => {
    expect(filterFolderEntries(entries, '')).not.toBe(entries);
  });
});

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

describe('stepHighlight', () => {
  it('moves one row at a time and stops at the first and last rows', () => {
    expect(stepHighlight(0, 1, 3)).toBe(1);
    expect(stepHighlight(1, -1, 3)).toBe(0);
    expect(stepHighlight(2, 1, 3)).toBe(2);
    expect(stepHighlight(0, -1, 3)).toBe(0);
  });

  it('keeps the first row when there are no rows to move over', () => {
    expect(stepHighlight(4, 1, 0)).toBe(0);
  });
});

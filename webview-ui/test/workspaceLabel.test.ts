import { describe, expect, it } from 'vitest';

import type { CompanyWorkspaceEntry } from '../../core/src/messages.js';
import { folderLabel, folderLabelFor } from '../src/company/workspaces.js';

const DU_AN = 'D:\\du-an';
const KHAC = 'D:\\khac';

function folder(path: string, name?: string): CompanyWorkspaceEntry {
  return {
    path,
    active: false,
    open: true,
    working: 0,
    waiting: 0,
    ...(name === undefined ? {} : { name }),
  };
}

describe('a folder label', () => {
  it('is the display name the server holds for the folder', () => {
    expect(folderLabel({ path: DU_AN, name: 'Cửa hàng' })).toBe('Cửa hàng');
  });

  it('trims the display name', () => {
    expect(folderLabel({ path: DU_AN, name: '  Cửa hàng  ' })).toBe('Cửa hàng');
  });

  it('falls back to the last path segment when there is no display name or it is blank', () => {
    expect(folderLabel({ path: DU_AN })).toBe('du-an');
    expect(folderLabel({ path: DU_AN, name: '   ' })).toBe('du-an');
    expect(folderLabel({ path: 'D:/work/shop/' })).toBe('shop');
  });
});

describe('the label of a folder in the server list', () => {
  const list = [folder(DU_AN, 'Cửa hàng'), folder(KHAC)];

  it('uses the display name of the entry at that exact path', () => {
    expect(folderLabelFor(list, DU_AN)).toBe('Cửa hàng');
  });

  it('uses the basename of a listed folder that has no display name', () => {
    expect(folderLabelFor(list, KHAC)).toBe('khac');
  });

  it('matches the path exactly, so a differently cased path falls back to its basename', () => {
    expect(folderLabelFor(list, 'd:\\du-an')).toBe('du-an');
  });

  it('names a folder the list does not hold by its basename, and any folder before a list', () => {
    expect(folderLabelFor(list, 'D:\\moi')).toBe('moi');
    expect(folderLabelFor(null, DU_AN)).toBe('du-an');
  });
});

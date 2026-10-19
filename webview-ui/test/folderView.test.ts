import { describe, expect, it } from 'vitest';

import type { CompanyWorkspaceEntry } from '../../core/src/messages.js';
import {
  FOLDER_LIST_LOADING_MESSAGE,
  type FolderFocusInput,
  folderListLoading,
  inFolderView,
  samePath,
} from '../src/company/folderView.js';

describe('the folder list while it loads', () => {
  it('is loading until the server has sent a list, even an empty one', () => {
    const list: CompanyWorkspaceEntry[] = [
      { path: 'D:\\du-an', active: true, open: true, working: 0, waiting: 0 },
    ];

    expect(folderListLoading({ workspaces: null })).toBe(true);
    expect(folderListLoading({ workspaces: [] })).toBe(false);
    expect(folderListLoading({ workspaces: list })).toBe(false);
  });

  it('says so in Vietnamese', () => {
    expect(FOLDER_LIST_LOADING_MESSAGE).toBe('Đang tải thư mục…');
  });
});

describe('samePath', () => {
  it('ignores case, the separator and trailing separators', () => {
    expect(
      samePath('D:\\Duancanhan\\Project_QuanLyGiaiDau', 'd:/duancanhan/project_quanlygiaidau/'),
    ).toBe(true);
    expect(samePath('D:\\', 'd:/')).toBe(true);
  });

  it('keeps folders apart when one name starts with the other', () => {
    expect(
      samePath('D:/Duancanhan/Project_QuanLyGiaiDau2', 'D:/Duancanhan/Project_QuanLyGiaiDau'),
    ).toBe(false);
    expect(samePath('V:/Duancanhan/AICheckVAR', 'D:/Duancanhan/AICheckVAR')).toBe(false);
  });
});

describe('inFolderView', () => {
  const ACTIVE = 'D:\\Duancanhan\\Project_QuanLyGiaiDau';
  const OTHER = 'V:\\Duancanhan\\AICheckVAR';
  const folderMode: FolderFocusInput = {
    viewMode: 'folder',
    focusPath: null,
    workspaces: [
      { path: ACTIVE, active: true, open: true, working: 0, waiting: 0 },
      { path: OTHER, active: false, open: true, working: 0, waiting: 0 },
    ],
  };

  it('shows every item in all mode, tagged or not', () => {
    const allMode: FolderFocusInput = { ...folderMode, viewMode: 'all' };
    expect(inFolderView(allMode, OTHER)).toBe(true);
    expect(inFolderView(allMode, undefined)).toBe(true);
  });

  it('shows only the items tagged with the active folder in folder mode', () => {
    expect(inFolderView(folderMode, ACTIVE)).toBe(true);
    expect(inFolderView(folderMode, 'd:/duancanhan/project_quanlygiaidau/')).toBe(true);
    expect(inFolderView(folderMode, OTHER)).toBe(false);
  });

  it('hides an item tagged with no open folder in folder mode', () => {
    expect(inFolderView(folderMode, undefined)).toBe(false);
  });

  it('shows nothing in folder mode when no folder is active', () => {
    const noActive: FolderFocusInput = {
      viewMode: 'folder',
      focusPath: null,
      workspaces: [{ path: OTHER, active: false, open: true, working: 0, waiting: 0 }],
    };
    expect(inFolderView(noActive, OTHER)).toBe(false);
  });

  it('does not match a folder whose name only starts with the active one', () => {
    expect(inFolderView(folderMode, 'D:\\Duancanhan\\Project_QuanLyGiaiDau2')).toBe(false);
  });

  it('shows everything while there is no folder list to filter by', () => {
    const noList: FolderFocusInput = { ...folderMode, workspaces: null };
    expect(inFolderView(noList, undefined)).toBe(true);
    expect(inFolderView(noList, OTHER)).toBe(true);
  });
});

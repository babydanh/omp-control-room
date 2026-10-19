import { describe, expect, it } from 'vitest';

import type { CompanyWorkspaceEntry } from '../../core/src/messages.js';
import { FOLDER_LIST_LOADING_MESSAGE, folderListLoading } from '../src/company/folderView.js';

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

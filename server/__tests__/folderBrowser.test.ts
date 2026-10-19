import { describe, expect, it } from 'vitest';

import { CompanyError } from '../src/company/companyError.js';
import {
  createFolder,
  type FolderDirent,
  type FolderErrorCode,
  type FolderFs,
  listFolder,
  resolveFolderPath,
  startView,
  validateFolderName,
} from '../src/company/folderBrowser.js';

/** A Node-style system error carrying a `code`, such as `ENOENT`. */
function systemError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

function dirent(name: string, kind: 'dir' | 'file' | 'link'): FolderDirent {
  return {
    name,
    isDirectory: () => kind === 'dir',
    isSymbolicLink: () => kind === 'link',
  };
}

interface FakeTree {
  platform: NodeJS.Platform;
  home: string;
  /** Existing directories, each with the entries `readdir` reports for it. */
  dirs: Record<string, FolderDirent[]>;
  /** Existing paths that are files, not directories. */
  files?: string[];
}

/** An in-memory file system: anything not in the tree is missing. `mkdir` adds to it. */
function fakeFs(tree: FakeTree): FolderFs {
  const dirs = new Set(Object.keys(tree.dirs));
  const files = new Set(tree.files ?? []);
  const kindOf = (target: string): { isDirectory(): boolean } => {
    if (dirs.has(target)) return { isDirectory: () => true };
    if (files.has(target)) return { isDirectory: () => false };
    throw systemError('ENOENT');
  };
  return {
    platform: tree.platform,
    homedir: () => tree.home,
    realpath: async (target) => {
      kindOf(target);
      return target;
    },
    stat: async (target) => kindOf(target),
    lstat: async (target) => kindOf(target),
    readdir: async (target) => {
      const children = tree.dirs[target];
      if (children === undefined) throw systemError('ENOENT');
      return children;
    },
    mkdir: async (target) => {
      if (dirs.has(target) || files.has(target)) throw systemError('EEXIST');
      dirs.add(target);
    },
  };
}

describe('validateFolderName', () => {
  it.each<[string, FolderErrorCode | null]>([
    ['Alpha', null],
    ['  Alpha  ', null],
    ['Mốc A', null],
    ['console', null],
    ['x'.repeat(255), null],
    ['   ', 'folder_name_invalid'],
    ['', 'folder_name_invalid'],
    ['.', 'folder_name_invalid'],
    ['..', 'folder_name_invalid'],
    ['file.', 'folder_name_invalid'],
    ['a/b', 'folder_name_invalid'],
    ['a\\b', 'folder_name_invalid'],
    ['a:b', 'folder_name_invalid'],
    ['a*b', 'folder_name_invalid'],
    ['a?b', 'folder_name_invalid'],
    ['a"b', 'folder_name_invalid'],
    ['a<b', 'folder_name_invalid'],
    ['a>b', 'folder_name_invalid'],
    ['a|b', 'folder_name_invalid'],
    ['tab\there', 'folder_name_invalid'],
    ['CON', 'folder_name_invalid'],
    ['nul.txt', 'folder_name_invalid'],
    ['COM1', 'folder_name_invalid'],
    ['lpt9.log', 'folder_name_invalid'],
    ['x'.repeat(256), 'folder_name_too_long'],
  ])('checks %j after trimming and returns %s', (name, expected) => {
    expect(validateFolderName(name)).toBe(expected);
  });
});

describe('resolveFolderPath', () => {
  const posix = fakeFs({
    platform: 'linux',
    home: '/home/me',
    dirs: { '/': [], '/w': [], '/home/me': [] },
    files: ['/w/notes.txt'],
  });

  it('returns the canonical form of an absolute folder', async () => {
    await expect(resolveFolderPath('/w', posix)).resolves.toBe('/w');
  });

  it.each([
    ['a relative path', 'w'],
    ['a path with a .. segment', '/w/../w'],
    ['a path with a backslash .. segment', '/w\\..\\w'],
    ['a path with a NUL character', '/w\0'],
  ])('refuses %s with folder_path_invalid', async (_label, input) => {
    await expect(resolveFolderPath(input, posix)).rejects.toMatchObject({
      code: 'folder_path_invalid',
      message: 'Đường dẫn không hợp lệ.',
    });
  });

  it('refuses a missing folder with folder_not_found', async () => {
    await expect(resolveFolderPath('/missing', posix)).rejects.toMatchObject({
      code: 'folder_not_found',
      message: 'Thư mục không tồn tại.',
    });
  });

  it('refuses a file with not_a_folder', async () => {
    await expect(resolveFolderPath('/w/notes.txt', posix)).rejects.toMatchObject({
      code: 'not_a_folder',
      message: 'Đây không phải thư mục.',
    });
  });

  it('applies win32 path rules to a drive path', async () => {
    const win = fakeFs({ platform: 'win32', home: 'C:\\Users\\me', dirs: { 'C:\\w': [] } });
    await expect(resolveFolderPath('C:\\w', win)).resolves.toBe('C:\\w');
    await expect(resolveFolderPath('C:\\w\\..\\w', win)).rejects.toBeInstanceOf(CompanyError);
  });
});

describe('listFolder', () => {
  it('lists directories and links that resolve to directories, sorted case-insensitively', async () => {
    const io = fakeFs({
      platform: 'linux',
      home: '/home/me',
      dirs: {
        '/w': [
          dirent('beta', 'dir'),
          dirent('Alpha', 'dir'),
          dirent('notes.txt', 'file'),
          dirent('shortcut', 'link'),
          dirent('broken', 'link'),
        ],
        '/w/shortcut': [],
      },
    });

    const listing = await listFolder('/w', io);

    expect(listing).toEqual({
      path: '/w',
      parent: '/',
      roots: [],
      entries: [
        { name: 'Alpha', path: '/w/Alpha' },
        { name: 'beta', path: '/w/beta' },
        { name: 'shortcut', path: '/w/shortcut' },
      ],
      truncated: false,
    });
  });

  it('has no parent at the file-system root', async () => {
    const io = fakeFs({ platform: 'linux', home: '/home/me', dirs: { '/': [] } });
    expect((await listFolder('/', io)).parent).toBeNull();
  });

  it('caps a large folder at 1000 entries and marks it truncated', async () => {
    const children = Array.from({ length: 1001 }, (_, index) => dirent(`d${index}`, 'dir'));
    const io = fakeFs({ platform: 'linux', home: '/home/me', dirs: { '/big': children } });

    const listing = await listFolder('/big', io);

    expect(listing.entries).toHaveLength(1000);
    expect(listing.truncated).toBe(true);
  });

  it('refuses a folder it cannot read with folder_unreadable', async () => {
    const base = fakeFs({ platform: 'linux', home: '/home/me', dirs: { '/w': [] } });
    const io: FolderFs = {
      ...base,
      readdir: async () => {
        throw systemError('EACCES');
      },
    };
    await expect(listFolder('/w', io)).rejects.toMatchObject({
      code: 'folder_unreadable',
      message: 'Không đọc được thư mục này.',
    });
  });
});

describe('startView', () => {
  it('lists the existing drives and the home folder on win32', async () => {
    const io = fakeFs({
      platform: 'win32',
      home: 'C:\\Users\\me',
      dirs: { 'C:\\': [], 'D:\\': [], 'C:\\Users\\me': [] },
    });

    expect(await startView(io)).toEqual({
      path: null,
      parent: null,
      roots: [
        { kind: 'drive', name: 'C:', path: 'C:\\' },
        { kind: 'drive', name: 'D:', path: 'D:\\' },
        { kind: 'home', name: 'me', path: 'C:\\Users\\me' },
      ],
      entries: [],
      truncated: false,
    });
  });

  it('starts at the file-system root elsewhere, then the home folder', async () => {
    const io = fakeFs({ platform: 'linux', home: '/home/me', dirs: { '/': [], '/home/me': [] } });

    expect((await startView(io)).roots).toEqual([
      { kind: 'root', name: '/', path: '/' },
      { kind: 'home', name: 'me', path: '/home/me' },
    ]);
  });
});

describe('createFolder', () => {
  it('creates the trimmed name inside the parent and returns its canonical path', async () => {
    const io = fakeFs({ platform: 'linux', home: '/home/me', dirs: { '/w': [] } });

    await expect(createFolder('/w', '  Gamma  ', io)).resolves.toBe('/w/Gamma');
    expect((await io.stat('/w/Gamma')).isDirectory()).toBe(true);
  });

  it('refuses an existing name with folder_exists', async () => {
    const io = fakeFs({ platform: 'linux', home: '/home/me', dirs: { '/w': [], '/w/Alpha': [] } });

    await expect(createFolder('/w', 'Alpha', io)).rejects.toMatchObject({
      code: 'folder_exists',
      message: 'Thư mục đã tồn tại.',
    });
  });

  it('maps a mkdir that loses a race to folder_exists', async () => {
    const base = fakeFs({ platform: 'linux', home: '/home/me', dirs: { '/w': [] } });
    const io: FolderFs = {
      ...base,
      mkdir: async () => {
        throw systemError('EEXIST');
      },
    };

    await expect(createFolder('/w', 'Gamma', io)).rejects.toMatchObject({ code: 'folder_exists' });
  });

  it('maps a mkdir the system refuses to folder_create_failed', async () => {
    const base = fakeFs({ platform: 'linux', home: '/home/me', dirs: { '/w': [] } });
    const io: FolderFs = {
      ...base,
      mkdir: async () => {
        throw systemError('EACCES');
      },
    };

    await expect(createFolder('/w', 'Gamma', io)).rejects.toMatchObject({
      code: 'folder_create_failed',
      message: 'Không tạo được thư mục.',
    });
  });

  it('refuses an invalid name before the parent is read', async () => {
    const io = fakeFs({ platform: 'linux', home: '/home/me', dirs: {} });

    await expect(createFolder('/w', 'a/b', io)).rejects.toMatchObject({
      code: 'folder_name_invalid',
    });
  });
});

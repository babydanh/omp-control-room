import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { FolderScope, type RealpathNative } from '../src/company/folderScope.js';

/**
 * A fake `realpath.native`: a path under a junction resolves through it, a path in `missing` fails
 * as a missing file does, and anything else is already real. Every call is recorded in `calls`.
 */
function fakeRealpath(
  junctions: Record<string, string> = {},
  missing: readonly string[] = [],
  calls: string[] = [],
): RealpathNative {
  return async (target) => {
    calls.push(target);
    const lower = target.toLowerCase();
    if (missing.some((gone) => lower.startsWith(gone.toLowerCase()))) {
      throw Object.assign(new Error(`ENOENT: ${target}`), { code: 'ENOENT' });
    }
    for (const [from, to] of Object.entries(junctions)) {
      if (lower.startsWith(from.toLowerCase())) return to + target.slice(from.length);
    }
    return target;
  };
}

function windowsScope(
  junctions?: Record<string, string>,
  missing?: readonly string[],
  calls?: string[],
): FolderScope {
  return new FolderScope({
    realpath: fakeRealpath(junctions, missing, calls),
    pathApi: path.win32,
    caseInsensitive: true,
  });
}

describe('FolderScope', () => {
  it('tags a path with the open folder that holds it, resolving a junction to its real folder', async () => {
    const scope = windowsScope({ 'D:\\Duancanhan': 'V:\\Duancanhan' });
    await scope.setFolders(['D:\\Duancanhan\\Project_QuanLyGiaiDau']);

    expect(await scope.folderOf('V:\\Duancanhan\\Project_QuanLyGiaiDau\\apps\\web')).toBe(
      'V:\\Duancanhan\\Project_QuanLyGiaiDau',
    );
    expect(await scope.folderOf('D:\\Duancanhan\\Project_QuanLyGiaiDau\\apps\\web')).toBe(
      'V:\\Duancanhan\\Project_QuanLyGiaiDau',
    );
  });

  it('picks the deepest open folder that contains the path', async () => {
    const scope = windowsScope();
    await scope.setFolders(['V:\\Duan', 'V:\\Duan\\Project']);

    expect(await scope.folderOf('V:\\Duan\\Project\\src')).toBe('V:\\Duan\\Project');
    expect(await scope.folderOf('V:\\Duan\\Other')).toBe('V:\\Duan');
  });

  it('returns undefined outside every open folder, for a sibling sharing a name prefix, and for a parent', async () => {
    const scope = windowsScope();
    await scope.setFolders(['V:\\Duan\\Project']);

    expect(await scope.folderOf('V:\\Duan\\Project2\\x')).toBeUndefined();
    expect(await scope.folderOf('V:\\Duan')).toBeUndefined();
    expect(await scope.folderOf('D:\\')).toBeUndefined();
  });

  it('returns undefined before any folder is set', async () => {
    expect(await windowsScope().folderOf('V:\\Duan\\Project\\src')).toBeUndefined();
  });

  it('matches case and separators case-insensitively where the platform ignores case', async () => {
    const scope = windowsScope();
    await scope.setFolders(['v:/duan/project']);

    expect(await scope.folderOf('V:\\DUAN\\PROJECT\\src')).toBe('v:\\duan\\project');
  });

  it('keeps the lexical spelling of a folder that no longer exists, without a trailing separator', async () => {
    const scope = windowsScope({}, ['V:\\Gone']);
    await scope.setFolders(['V:\\Gone\\app\\']);

    expect(await scope.folderOf('V:\\Gone\\app\\x')).toBe('V:\\Gone\\app');
    expect(await scope.folderOf('V:\\Gone\\missing\\x')).toBeUndefined();
  });

  it('never rejects for a path that cannot be resolved', async () => {
    const scope = windowsScope({}, ['V:\\Gone']);
    await scope.setFolders(['V:\\Duan']);

    await expect(scope.folderOf('V:\\Gone\\anything')).resolves.toBeUndefined();
  });

  it('resolves each spelling once until the folder list changes', async () => {
    const calls: string[] = [];
    const scope = windowsScope({}, [], calls);
    await scope.setFolders(['D:\\A']);
    await scope.folderOf('D:\\A\\x');
    await scope.folderOf('D:\\A\\x');
    expect(calls.filter((call) => call === 'D:\\A\\x')).toHaveLength(1);

    await scope.setFolders(['D:\\A']);
    await scope.folderOf('D:\\A\\x');
    expect(calls.filter((call) => call === 'D:\\A\\x')).toHaveLength(2);
  });

  it('compares case-sensitively and by POSIX separators on a platform that keeps case', async () => {
    const scope = new FolderScope({
      realpath: fakeRealpath(),
      pathApi: path.posix,
      caseInsensitive: false,
    });
    await scope.setFolders(['/home/u/app']);

    expect(await scope.folderOf('/home/u/app/src')).toBe('/home/u/app');
    expect(await scope.folderOf('/home/u/APP/src')).toBeUndefined();
  });
});

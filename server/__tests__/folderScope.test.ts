import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  canonicalWithinFolder,
  FolderScope,
  type RealpathNative,
  resolveFolderCwd,
} from '../src/company/folderScope.js';

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

  it('tags an agent in the sibling "<folder>.worktrees" with that folder, and nothing for ".worktreesX"', async () => {
    const scope = windowsScope();
    await scope.setFolders(['V:\\Duancanhan\\Auto3Dvideo', 'V:\\Duancanhan\\Project_QuanLyGiaiDau']);

    expect(await scope.folderOf('V:\\Duancanhan\\Auto3Dvideo.worktrees\\claude-1025-1438')).toBe('V:\\Duancanhan\\Auto3Dvideo');
    expect(await scope.folderOf('v:/duancanhan/auto3dvideo.WORKTREES/x/')).toBe('V:\\Duancanhan\\Auto3Dvideo');
    expect(await scope.folderOf('V:\\Duancanhan\\Auto3Dvideo.worktreesX\\x')).toBeUndefined();
    expect(await scope.folderOf('V:\\Duancanhan\\Project_QuanLyGiaiDau.worktrees\\a')).toBe('V:\\Duancanhan\\Project_QuanLyGiaiDau');
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

describe('resolveFolderCwd and canonicalWithinFolder', () => {
  let scratch: string;
  let root: string;

  beforeEach(async () => {
    scratch = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pxl-folder-cwd-'));
    root = path.join(scratch, 'Project');
    await fs.promises.mkdir(path.join(root, 'repo'), { recursive: true });
    await fs.promises.mkdir(path.join(scratch, 'Project2'));
    await fs.promises.writeFile(path.join(root, 'file.txt'), 'x');
  });

  afterEach(async () => {
    await fs.promises.rm(scratch, { recursive: true, force: true });
  });

  it('accepts the folder itself and a directory inside it, in canonical form', async () => {
    expect(await resolveFolderCwd(root, root)).toBe(await fs.promises.realpath(root));
    expect(await resolveFolderCwd(path.join(root, 'repo'), root)).toBe(
      await fs.promises.realpath(path.join(root, 'repo')),
    );
  });

  it.skipIf(process.platform !== 'win32')(
    'matches the folder case-insensitively on Windows',
    async () => {
      await expect(resolveFolderCwd(path.join(root.toUpperCase(), 'repo'), root)).resolves.toEqual(
        expect.any(String),
      );
    },
  );

  it('refuses a directory outside the folder, a sibling sharing its name prefix, and a ".." escape', async () => {
    await expect(resolveFolderCwd(path.join(scratch, 'Project2'), root)).rejects.toMatchObject({
      code: 'cwd_outside_folder',
    });
    await expect(resolveFolderCwd(path.join(root, '..', 'Project2'), root)).rejects.toMatchObject({
      code: 'cwd_outside_folder',
    });
    await expect(resolveFolderCwd(scratch, root)).rejects.toMatchObject({
      code: 'cwd_outside_folder',
    });
  });

  it('accepts the sibling "<folder>.worktrees" only when the folder is a git repo', async () => {
    const worktree = path.join(scratch, 'Project.worktrees', 'squad-1');
    await fs.promises.mkdir(worktree, { recursive: true });
    // A plain folder gets no sibling: the path lies outside it.
    await expect(resolveFolderCwd(worktree, root)).rejects.toMatchObject({ code: 'cwd_outside_folder' });
    expect(await canonicalWithinFolder(worktree, root)).toBeUndefined();

    await fs.promises.mkdir(path.join(root, '.git'));
    expect(await resolveFolderCwd(worktree, root)).toBe(await fs.promises.realpath(worktree));
    expect(await canonicalWithinFolder(worktree, root)).toBe(await fs.promises.realpath(worktree));
    await fs.promises.mkdir(path.join(scratch, 'Project.worktreesX'));
    await expect(resolveFolderCwd(path.join(scratch, 'Project.worktreesX'), root)).rejects.toMatchObject({
      code: 'cwd_outside_folder',
    });
  });

  it('refuses a path that does not exist and a file that is not a directory', async () => {
    await expect(resolveFolderCwd(path.join(root, 'missing'), root)).rejects.toMatchObject({
      code: 'cwd_invalid',
    });
    await expect(resolveFolderCwd(path.join(root, 'file.txt'), root)).rejects.toMatchObject({
      code: 'cwd_invalid',
    });
  });

  it('refuses a junction inside the folder that leads outside it', async () => {
    const junction = path.join(root, 'link');
    const outside = path.join(scratch, 'Project2');
    // Models the junction: anything under `link` resolves to the same place under the outside folder.
    const realpath: RealpathNative = (target) =>
      target === junction || target.startsWith(`${junction}${path.sep}`)
        ? fs.promises.realpath(path.join(outside, path.relative(junction, target)))
        : fs.promises.realpath(target);
    await expect(resolveFolderCwd(junction, root, realpath)).rejects.toMatchObject({
      code: 'cwd_outside_folder',
    });
  });

  it('maps the folder and anything inside it, even a directory that no longer exists, to a canonical path', async () => {
    const real = await fs.promises.realpath(root);
    expect(await canonicalWithinFolder(real, root)).toBe(real);
    expect(await canonicalWithinFolder(path.join(real, 'repo'), root)).toBe(
      path.join(real, 'repo'),
    );
    expect(await canonicalWithinFolder(path.join(real, 'gone'), root)).toBe(
      path.join(real, 'gone'),
    );
  });

  it('maps a path outside the folder, or a sibling sharing its name prefix, to nothing', async () => {
    expect(await canonicalWithinFolder(path.join(scratch, 'Project2'), root)).toBeUndefined();
    expect(await canonicalWithinFolder(scratch, root)).toBeUndefined();
  });
});

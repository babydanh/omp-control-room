import { describe, expect, it } from 'vitest';

import { CompanyError } from '../src/company/companyError.js';
import {
  type FolderFs,
  type PickerRun,
  type PickerRunResult,
  pickFolder,
  resolveFolderPath,
} from '../src/company/folderPicker.js';

/** A Node-style system error carrying a `code`, such as `ENOENT`. */
function systemError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

/** An in-memory file system: anything not listed is missing; paths resolve to themselves. */
function fakeFs(platform: NodeJS.Platform, dirs: readonly string[], files: readonly string[] = []): FolderFs {
  const kindOf = (target: string): { isDirectory(): boolean } => {
    if (dirs.includes(target)) return { isDirectory: () => true };
    if (files.includes(target)) return { isDirectory: () => false };
    throw systemError('ENOENT');
  };
  return {
    platform,
    realpath: async (target) => {
      kindOf(target);
      return target;
    },
    stat: async (target) => kindOf(target),
  };
}

/** A runner that answers each program from `answers` and records what it was asked to run. */
function fakeRun(answers: Record<string, PickerRunResult>): PickerRun & { calls: { program: string; env: Readonly<Record<string, string>> }[] } {
  const calls: { program: string; env: Readonly<Record<string, string>> }[] = [];
  const run = async (program: string, _args: readonly string[], env: Readonly<Record<string, string>>) => {
    calls.push({ program, env });
    return answers[program] ?? { kind: 'missing' as const };
  };
  return Object.assign(run, { calls });
}

const ran = (stdout: string, ok = true, stderr = ''): PickerRunResult => ({ kind: 'ran', ok, stdout, stderr });

describe('resolveFolderPath', () => {
  const posix = fakeFs('linux', ['/', '/w', '/home/me'], ['/w/notes.txt']);

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
    const win = fakeFs('win32', ['C:\\w']);
    await expect(resolveFolderPath('C:\\w', win)).resolves.toBe('C:\\w');
    await expect(resolveFolderPath('C:\\w\\..\\w', win)).rejects.toBeInstanceOf(CompanyError);
  });
});

describe('pickFolder', () => {
  const win = fakeFs('win32', ['V:\\Duancanhan\\Moi']);

  it('opens the dialog in PowerShell 7 with its Vietnamese title and answers with the canonical folder chosen', async () => {
    const run = fakeRun({ pwsh: ran('V:\\Duancanhan\\Moi\r\n') });
    await expect(pickFolder(run, win)).resolves.toBe('V:\\Duancanhan\\Moi');
    expect(run.calls).toEqual([{ program: 'pwsh', env: { PIXEL_AGENTS_PICK_TITLE: 'Chọn thư mục cho Agent Board' } }]);
  });

  it('reads a cancelled dialog, which prints nothing, as no folder', async () => {
    await expect(pickFolder(fakeRun({ pwsh: ran('') }), win)).resolves.toBeNull();
  });

  it('falls back to Windows PowerShell when PowerShell 7 is not installed', async () => {
    const run = fakeRun({ 'powershell.exe': ran('V:\\Duancanhan\\Moi') });
    await expect(pickFolder(run, win)).resolves.toBe('V:\\Duancanhan\\Moi');
    expect(run.calls.map((call) => call.program)).toEqual(['pwsh', 'powershell.exe']);
  });

  it('refuses off Windows without running anything', async () => {
    const run = fakeRun({ pwsh: ran('/w') });
    await expect(pickFolder(run, fakeFs('linux', ['/w']))).rejects.toMatchObject({ code: 'folder_pick_unsupported' });
    expect(run.calls).toEqual([]);
  });

  it('refuses when PowerShell fails or none is installed, and opens again afterwards', async () => {
    await expect(pickFolder(fakeRun({ pwsh: ran('', false, 'Add-Type failed') }), win)).rejects.toMatchObject({ code: 'folder_pick_failed' });
    await expect(pickFolder(fakeRun({}), win)).rejects.toMatchObject({ code: 'folder_pick_failed' });
    await expect(pickFolder(fakeRun({ pwsh: ran('V:\\Duancanhan\\Moi') }), win)).resolves.toBe('V:\\Duancanhan\\Moi');
  });

  it('refuses a second dialog while one is open, and allows one once it closes', async () => {
    let close: (result: PickerRunResult) => void = () => undefined;
    const open: PickerRun = () =>
      new Promise((resolve) => {
        close = resolve;
      });
    const first = pickFolder(open, win);
    await expect(pickFolder(fakeRun({ pwsh: ran('V:\\Duancanhan\\Moi') }), win)).rejects.toMatchObject({ code: 'folder_pick_busy' });
    close(ran(''));
    await expect(first).resolves.toBeNull();
    await expect(pickFolder(fakeRun({ pwsh: ran('V:\\Duancanhan\\Moi') }), win)).resolves.toBe('V:\\Duancanhan\\Moi');
  });
});

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  assertOmpSessionFileIn,
  comparableOmpPath,
  listOmpSessionFiles,
  OMP_SESSION_LIST_LIMIT,
  ompSessionDirName,
  ompSessionsRoot,
  readOmpSessionTitle,
  removeSessionFileWithin,
} from '../src/company/ompSessionFiles.js';

let scratch: string;

beforeEach(async () => {
  scratch = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pxl-omp-files-'));
});

afterEach(async () => {
  await fs.promises.rm(scratch, { recursive: true, force: true });
});

function writeFile(file: string, text: string): Promise<void> {
  return fs.promises.writeFile(file, text);
}

describe('omp session directory names', () => {
  it.skipIf(process.platform !== 'win32')('encodes a drive root the way omp does', () => {
    expect(ompSessionDirName('D:\\', 'C:\\nowhere-tmp', 'C:\\nowhere-home')).toBe('--D----');
  });

  it.skipIf(process.platform === 'win32')('encodes an absolute folder with dashes', () => {
    expect(ompSessionDirName('/srv/proj', '/nowhere-tmp', '/nowhere-home')).toBe('--srv-proj--');
  });

  it('uses the temp and home scopes for folders inside them', () => {
    const tempRoot = path.join(scratch, 'tmp');
    const home = path.join(scratch, 'home');
    expect(ompSessionDirName(path.join(tempRoot, 'proj'), tempRoot, home)).toBe('-tmp-proj');
    expect(ompSessionDirName(path.join(home, 'work'), tempRoot, home)).toBe('-work');
  });
});

describe('ompSessionsRoot', () => {
  it('honours PI_CODING_AGENT_DIR, then PI_CONFIG_DIR, then the default folder', () => {
    expect(ompSessionsRoot({ PI_CODING_AGENT_DIR: '/agent' }, '/home/u')).toBe(
      path.join('/agent', 'sessions'),
    );
    expect(ompSessionsRoot({ PI_CONFIG_DIR: '.cfg' }, '/home/u')).toBe(
      path.join('/home/u', '.cfg', 'agent', 'sessions'),
    );
    expect(ompSessionsRoot({}, '/home/u')).toBe(path.join('/home/u', '.omp', 'agent', 'sessions'));
  });
});

describe('readOmpSessionTitle', () => {
  it('reads a title line from the head of the file, trimmed', async () => {
    const file = path.join(scratch, 'titled.jsonl');
    await writeFile(file, `${JSON.stringify({ type: 'title', title: '  Thiết kế API  ' })}\n`);
    expect(await readOmpSessionTitle(file)).toBe('Thiết kế API');
  });

  it('reads a title carried by the session header on the second line', async () => {
    const file = path.join(scratch, 'header.jsonl');
    await writeFile(
      file,
      `${JSON.stringify({ type: 'session', id: 's' })}\n${JSON.stringify({ type: 'session', title: 'Phiên 2' })}\n`,
    );
    expect(await readOmpSessionTitle(file)).toBe('Phiên 2');
  });

  it('returns nothing for a file without a title or one that cannot be read', async () => {
    const file = path.join(scratch, 'untitled.jsonl');
    await writeFile(file, '{"type":"message"}\nnot json\n');
    expect(await readOmpSessionTitle(file)).toBeUndefined();
    expect(await readOmpSessionTitle(path.join(scratch, 'missing.jsonl'))).toBeUndefined();
  });
});

describe('listOmpSessionFiles', () => {
  it('lists nothing for a folder that has no session directory yet', async () => {
    expect(await listOmpSessionFiles(path.join(scratch, 'absent'), new Map())).toEqual([]);
  });

  it('lists only .jsonl files, newest first, with titles and board session links', async () => {
    const dir = path.join(scratch, 'sessions');
    await fs.promises.mkdir(dir);
    const older = path.join(dir, 'older.jsonl');
    const newer = path.join(dir, 'newer.jsonl');
    await writeFile(older, `${JSON.stringify({ type: 'title', title: 'Cũ' })}\n`);
    await writeFile(newer, '{"type":"message"}\n');
    await writeFile(path.join(dir, 'notes.txt'), 'bỏ qua');
    await fs.promises.utimes(older, new Date('2026-01-01'), new Date('2026-01-01'));
    await fs.promises.utimes(newer, new Date('2026-02-01'), new Date('2026-02-01'));

    const listing = await listOmpSessionFiles(dir, new Map([[comparableOmpPath(newer), 'S-9']]));

    expect(listing.map((entry) => path.basename(entry.file))).toEqual([
      'newer.jsonl',
      'older.jsonl',
    ]);
    expect(listing[0]).toMatchObject({ boardSessionId: 'S-9', sizeBytes: expect.any(Number) });
    expect(listing[0]?.title).toBeUndefined();
    expect(listing[1]).toMatchObject({ title: 'Cũ', updatedAt: expect.any(String) });
    expect(listing[1]?.boardSessionId).toBeUndefined();
  });

  it('caps the listing at the newest entries', async () => {
    const dir = path.join(scratch, 'many');
    await fs.promises.mkdir(dir);
    const total = OMP_SESSION_LIST_LIMIT + 5;
    await Promise.all(
      Array.from({ length: total }, async (_, index) => {
        const file = path.join(dir, `s${index}.jsonl`);
        await writeFile(file, '{}\n');
        const at = new Date(Date.UTC(2026, 0, 1) + index * 1000);
        await fs.promises.utimes(file, at, at);
      }),
    );

    const listing = await listOmpSessionFiles(dir, new Map());

    expect(listing).toHaveLength(OMP_SESSION_LIST_LIMIT);
    expect(path.basename(listing[0]?.file ?? '')).toBe(`s${total - 1}.jsonl`);
  });
});

describe('assertOmpSessionFileIn', () => {
  it('accepts a .jsonl file inside the folder and returns its resolved path', async () => {
    const dir = path.join(scratch, 'omp');
    await fs.promises.mkdir(dir);
    const file = path.join(dir, 'saved.jsonl');
    await writeFile(file, '{}\n');
    expect(await assertOmpSessionFileIn(file, dir)).toBe(path.resolve(file));
  });

  it('refuses a relative path, a non-.jsonl file, and a file that does not exist', async () => {
    const dir = path.join(scratch, 'omp');
    await fs.promises.mkdir(dir);
    const notSession = path.join(dir, 'saved.txt');
    await writeFile(notSession, 'x');
    await expect(assertOmpSessionFileIn('saved.jsonl', dir)).rejects.toMatchObject({
      code: 'omp_session_invalid',
    });
    await expect(assertOmpSessionFileIn(notSession, dir)).rejects.toMatchObject({
      code: 'omp_session_invalid',
    });
    await expect(assertOmpSessionFileIn(path.join(dir, 'gone.jsonl'), dir)).rejects.toMatchObject({
      code: 'omp_session_missing',
    });
  });

  it('refuses a file outside the folder, including one reached through ..', async () => {
    const dir = path.join(scratch, 'omp');
    await fs.promises.mkdir(dir);
    const outside = path.join(scratch, 'outside.jsonl');
    await writeFile(outside, '{}\n');
    await expect(assertOmpSessionFileIn(outside, dir)).rejects.toMatchObject({
      code: 'omp_session_outside_folder',
    });
    await expect(
      assertOmpSessionFileIn(path.join(dir, '..', 'outside.jsonl'), dir),
    ).rejects.toMatchObject({ code: 'omp_session_outside_folder' });
  });
});

describe('removeSessionFileWithin', () => {
  it('deletes a .jsonl file that resolves inside one of the roots', async () => {
    const root = path.join(scratch, 'root');
    await fs.promises.mkdir(root);
    const file = path.join(root, 'owned.jsonl');
    await writeFile(file, '{}\n');
    expect(await removeSessionFileWithin(file, [path.join(scratch, 'other'), root])).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('leaves a file outside every root, a non-.jsonl file, and a missing file alone', async () => {
    const root = path.join(scratch, 'root');
    await fs.promises.mkdir(root);
    const outside = path.join(scratch, 'outside.jsonl');
    const notSession = path.join(root, 'keep.txt');
    await writeFile(outside, '{}\n');
    await writeFile(notSession, 'x');
    expect(await removeSessionFileWithin(outside, [root])).toBe(false);
    expect(await removeSessionFileWithin(notSession, [root])).toBe(false);
    expect(await removeSessionFileWithin(path.join(root, 'gone.jsonl'), [root])).toBe(false);
    expect(fs.existsSync(outside)).toBe(true);
    expect(fs.existsSync(notSession)).toBe(true);
  });
});

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { ProjectImageSaveMessage } from '../../core/src/messages.js';
import { PROMPT_IMAGE_MAX_BYTES, savePromptImage } from '../src/projects/imageSave.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64');

let dirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'prompt-image-'));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(dirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
  dirs = [];
});

describe('savePromptImage', () => {
  it('writes the bytes under a name of its own, with the extension of the type', async () => {
    const dir = await tempDir();
    const file = await savePromptImage({ mediaType: 'image/png', dataBase64: PNG }, dir, new Date('2026-10-21T10:05:06Z'));
    expect(path.dirname(file)).toBe(dir);
    expect(path.basename(file)).toMatch(/^20261021100506-[0-9a-f]{8}\.png$/);
    expect((await fs.readFile(file)).toString('base64')).toBe(PNG);
  });

  it('refuses a type it does not keep, a payload that is not base64, and one over the limit', async () => {
    const dir = await tempDir();
    const save = (request: { mediaType: string; dataBase64: string }) =>
      savePromptImage(request as Pick<ProjectImageSaveMessage, 'mediaType' | 'dataBase64'>, dir);
    await expect(save({ mediaType: 'image/svg+xml', dataBase64: PNG })).rejects.toThrow();
    await expect(save({ mediaType: 'image/png', dataBase64: '@@not base64@@' })).rejects.toThrow();
    const big = Buffer.alloc(PROMPT_IMAGE_MAX_BYTES + 1).toString('base64');
    await expect(save({ mediaType: 'image/png', dataBase64: big })).rejects.toThrow();
    expect(await fs.readdir(dir)).toEqual([]);
  });
});

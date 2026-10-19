import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  COMPANY_FOLDER_NAME_MAX_LENGTH,
  COMPANY_FOLDER_NAMES_LIMIT,
  companyFolderNameFor,
  readCompanyFolderNames,
  setCompanyFolderName,
} from '../src/configPersistence.js';
import { CONFIG_FILE_NAME, LAYOUT_FILE_DIR } from '../src/constants.js';
import { toPathKey } from '../src/pathKey.js';

describe('company folder display names in config', () => {
  let tempHome: string;
  let originalHome: string | undefined;
  let originalUserProfile: string | undefined;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-folder-names-'));
    originalHome = process.env.HOME;
    originalUserProfile = process.env.USERPROFILE;
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
  });

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (originalUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = originalUserProfile;
    }
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  /** A folder path under the temporary home; the folder need not exist for names. */
  function folderAt(name: string): string {
    return path.join(tempHome, 'Projects', name);
  }

  /** Write a raw config.json the way a hand edit would leave it. */
  function writeRawNames(companyFolderNames: unknown): void {
    const file = path.join(tempHome, LAYOUT_FILE_DIR, CONFIG_FILE_NAME);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ companyFolderNames }), 'utf-8');
  }

  it('stores a name under the folder path key and reads it back', () => {
    const alpha = folderAt('Alpha');

    expect(setCompanyFolderName(alpha, 'Mốc A')).toBe(true);
    expect(readCompanyFolderNames()).toEqual({ [toPathKey(alpha)]: 'Mốc A' });
  });

  it('finds the name through another spelling of the same folder', () => {
    setCompanyFolderName(folderAt('Alpha'), 'Mốc A');
    const respelled = `${tempHome}${path.sep}Projects${path.sep}..${path.sep}Projects${path.sep}Alpha`;

    expect(companyFolderNameFor(readCompanyFolderNames(), respelled)).toBe('Mốc A');
    expect(companyFolderNameFor(readCompanyFolderNames(), folderAt('Beta'))).toBeUndefined();
  });

  it('clears a name when it is set to null or to a blank name', () => {
    const alpha = folderAt('Alpha');
    setCompanyFolderName(alpha, 'Mốc A');

    expect(setCompanyFolderName(alpha, null)).toBe(true);
    expect(readCompanyFolderNames()).toEqual({});

    setCompanyFolderName(alpha, 'Mốc A');
    expect(setCompanyFolderName(alpha, '   ')).toBe(true);
    expect(readCompanyFolderNames()).toEqual({});
  });

  it('trims a name and caps it at the character limit without splitting a character', () => {
    const alpha = folderAt('Alpha');

    setCompanyFolderName(alpha, `  ${'😀'.repeat(COMPANY_FOLDER_NAME_MAX_LENGTH + 1)}  `);

    expect(readCompanyFolderNames()[toPathKey(alpha)]).toBe(
      '😀'.repeat(COMPANY_FOLDER_NAME_MAX_LENGTH),
    );
  });

  it('drops hand-edited entries that are not usable', () => {
    const alpha = folderAt('Alpha');
    writeRawNames({
      [alpha]: 'Mốc A',
      [folderAt('Beta')]: 42,
      [folderAt('Gamma')]: '   ',
      [folderAt('Epsilon')]: null,
      'relative/Delta': 'Mốc D',
    });

    expect(readCompanyFolderNames()).toEqual({ [toPathKey(alpha)]: 'Mốc A' });
  });

  it('keeps only the newest names at the limit and evicts the oldest on the next save', () => {
    const raw: Record<string, string> = {};
    for (let index = 0; index < COMPANY_FOLDER_NAMES_LIMIT + 5; index += 1) {
      raw[folderAt(`F${index}`)] = `Tên ${index}`;
    }
    writeRawNames(raw);

    const kept = readCompanyFolderNames();
    expect(Object.keys(kept)).toHaveLength(COMPANY_FOLDER_NAMES_LIMIT);
    expect(kept[toPathKey(folderAt('F0'))]).toBeUndefined();
    expect(kept[toPathKey(folderAt('F5'))]).toBe('Tên 5');

    setCompanyFolderName(folderAt('Newest'), 'Mới');

    const after = readCompanyFolderNames();
    expect(Object.keys(after)).toHaveLength(COMPANY_FOLDER_NAMES_LIMIT);
    expect(after[toPathKey(folderAt('F5'))]).toBeUndefined();
    expect(after[toPathKey(folderAt('Newest'))]).toBe('Mới');
  });

  it('reports a save that never reached the disk as false', () => {
    // A regular file where the config directory should be: the write cannot land.
    fs.writeFileSync(path.join(tempHome, LAYOUT_FILE_DIR), '');

    expect(setCompanyFolderName(folderAt('Alpha'), 'Mốc A')).toBe(false);
  });
});

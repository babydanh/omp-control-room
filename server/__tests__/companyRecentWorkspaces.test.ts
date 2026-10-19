import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  forgetRecentCompanyWorkspace,
  readConfig,
  readRecentCompanyWorkspaces,
  RECENT_COMPANY_WORKSPACES_LIMIT,
  rememberRecentCompanyWorkspace,
  writeConfig,
} from '../src/configPersistence.js';
import { CONFIG_FILE_NAME, LAYOUT_FILE_DIR } from '../src/constants.js';

describe('configPersistence: recent company workspaces', () => {
  let tempHome: string;
  let originalHome: string | undefined;
  let originalUserProfile: string | undefined;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-recent-workspaces-'));
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

  function configFile(): string {
    return path.join(tempHome, LAYOUT_FILE_DIR, CONFIG_FILE_NAME);
  }

  it('is empty when no config file exists', () => {
    expect(readRecentCompanyWorkspaces()).toEqual([]);
  });

  it('persists a remembered folder across reads and keeps the other config fields', () => {
    writeConfig({ ...readConfig(), hooksEnabled: { claude: false } });

    rememberRecentCompanyWorkspace(path.join(tempHome, 'alpha'));

    expect(readRecentCompanyWorkspaces()).toEqual([path.join(tempHome, 'alpha')]);
    expect(readConfig().hooksEnabled).toEqual({ claude: false });
  });

  it('moves a folder to the front when it is remembered again, without duplicating it', () => {
    const alpha = path.join(tempHome, 'alpha');
    const beta = path.join(tempHome, 'beta');

    rememberRecentCompanyWorkspace(alpha);
    rememberRecentCompanyWorkspace(beta);
    rememberRecentCompanyWorkspace(alpha);

    expect(readRecentCompanyWorkspaces()).toEqual([alpha, beta]);
  });

  it('treats a trailing separator as the same folder', () => {
    const alpha = path.join(tempHome, 'alpha');

    rememberRecentCompanyWorkspace(alpha + path.sep);
    rememberRecentCompanyWorkspace(alpha);

    expect(readRecentCompanyWorkspaces()).toEqual([alpha]);
  });

  it('keeps only the newest entries up to the limit', () => {
    const folders = Array.from({ length: RECENT_COMPANY_WORKSPACES_LIMIT + 2 }, (_, index) =>
      path.join(tempHome, `folder-${index}`),
    );

    for (const folder of folders) rememberRecentCompanyWorkspace(folder);

    const recent = readRecentCompanyWorkspaces();
    expect(recent).toHaveLength(RECENT_COMPANY_WORKSPACES_LIMIT);
    expect(recent[0]).toBe(folders[folders.length - 1]);
    expect(recent).not.toContain(folders[0]);
    expect(recent).not.toContain(folders[1]);
  });

  it('drops malformed and duplicate entries from the file', () => {
    const alpha = path.join(tempHome, 'alpha');
    const beta = path.join(tempHome, 'beta');
    fs.mkdirSync(path.dirname(configFile()), { recursive: true });
    fs.writeFileSync(
      configFile(),
      JSON.stringify({ recentCompanyWorkspaces: [42, '   ', alpha, alpha + path.sep, null, beta] }),
    );

    expect(readRecentCompanyWorkspaces()).toEqual([alpha, beta]);
  });

  it('forgets a folder, matching a trailing separator, and keeps the other entries', () => {
    const alpha = path.join(tempHome, 'alpha');
    const beta = path.join(tempHome, 'beta');
    rememberRecentCompanyWorkspace(alpha);
    rememberRecentCompanyWorkspace(beta);

    expect(forgetRecentCompanyWorkspace(alpha + path.sep)).toBe(true);

    expect(readRecentCompanyWorkspaces()).toEqual([beta]);
  });

  it('reports success and leaves the list alone when the folder was never remembered', () => {
    const alpha = path.join(tempHome, 'alpha');
    rememberRecentCompanyWorkspace(alpha);

    expect(forgetRecentCompanyWorkspace(path.join(tempHome, 'never'))).toBe(true);

    expect(readRecentCompanyWorkspaces()).toEqual([alpha]);
  });
});

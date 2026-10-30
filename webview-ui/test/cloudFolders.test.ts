import { describe, expect, it } from 'vitest';

import { cloudFolderKey, parseCloudFolders, placeCloudRows } from '../src/company/fleet/cloudFolders.js';

const row = (machine: string, session: string) => ({ machine, session });

describe('parseCloudFolders', () => {
  it('reads a stored map and drops anything that is not a string pair', () => {
    const raw = JSON.stringify({ 'danh/a': 'node-1', 'danh/b': 7, 'danh/c': null });
    expect(parseCloudFolders(raw)).toEqual({ 'danh/a': 'node-1' });
  });

  it('answers an empty map for missing, broken or non-object storage', () => {
    expect(parseCloudFolders(null)).toEqual({});
    expect(parseCloudFolders('{oops')).toEqual({});
    expect(parseCloudFolders('[1,2]')).toEqual({});
  });
});

describe('placeCloudRows', () => {
  const map = { [cloudFolderKey('danh', 'fix-ab12')]: 'folder-1', [cloudFolderKey('danh3', 'gone')]: 'folder-removed' };

  it('puts a session under the folder that created it', () => {
    const placed = placeCloudRows([row('danh', 'fix-ab12')], map, new Set(['folder-1']));
    expect(placed.byFolder.get('folder-1')).toEqual([row('danh', 'fix-ab12')]);
    expect(placed.loose).toEqual([]);
  });

  it('keeps a session with no folder, or whose folder was removed, in the loose list', () => {
    const placed = placeCloudRows([row('danh', 'old'), row('danh3', 'gone')], map, new Set(['folder-1']));
    expect(placed.byFolder.size).toBe(0);
    expect(placed.loose).toEqual([row('danh', 'old'), row('danh3', 'gone')]);
  });
});

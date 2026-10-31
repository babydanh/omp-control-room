import { describe, expect, it } from 'vitest';

import { cloudFolderKey, parseCloudFolders, placeCloudRows } from '../src/company/fleet/cloudFolders.js';

const row = (machine: string, session: string, repos: readonly string[] = []) => ({ machine, session, repos: repos.map((name) => ({ name })) });
const folder = (id: string, path: string, parentId?: string) => ({ id, kind: 'folder', path, ...(parentId === undefined ? {} : { parentId }) });
const node = (id: string) => ({ id, kind: 'folder' });

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
    const placed = placeCloudRows([row('danh', 'fix-ab12')], map, [node('folder-1')]);
    expect(placed.byFolder.get('folder-1')).toEqual([row('danh', 'fix-ab12')]);
    expect(placed.loose).toEqual([]);
  });

  it('keeps a session with no folder, or whose folder was removed, in the loose list', () => {
    const placed = placeCloudRows([row('danh', 'old'), row('danh3', 'gone')], map, [node('folder-1')]);
    expect(placed.byFolder.size).toBe(0);
    expect(placed.loose).toEqual([row('danh', 'old'), row('danh3', 'gone')]);
  });
});

describe('placeCloudRows by repository', () => {
  const be = folder('f-be', 'V:\\Duancanhan\\Project_QuanLyGiaiDau\\HethongBackendApi_QuanlyGiaiDau', 'proj');
  const web = folder('f-web', 'V:\\Duancanhan\\Project_QuanLyGiaiDau\\HethongFrontEndWeb_QLgiaidau', 'proj');
  const tree = [{ id: 'proj', kind: 'project' }, be, web];

  it('puts a session under the folder named like its repository, with no click made in this browser', () => {
    const placed = placeCloudRows([row('danh', 'a', ['hethongbackendapi_quanlygiaidau'])], {}, tree);
    expect(placed.byFolder.get('f-be')).toHaveLength(1);
    expect(placed.loose).toEqual([]);
  });

  it('puts a session that holds worktrees of several folders under their shared project', () => {
    const placed = placeCloudRows([row('danh', 'all', ['HethongBackendApi_QuanlyGiaiDau', 'HethongFrontEndWeb_QLgiaidau'])], {}, tree);
    expect(placed.byFolder.get('proj')).toHaveLength(1);
  });

  it('puts a session under the folder whose own sessions work in that repository', () => {
    const qlgd = folder('f-qlgd', 'V:\\Duancanhan\\Project_QuanLyGiaiDau', 'proj');
    const other = folder('f-other', 'V:\\Duancanhan\\AICheckVAR', 'proj');
    const sessionIn = (id: string, parentId: string, path: string) => ({ id, parentId, kind: 'session', path });
    const nodes = [
      { id: 'proj', kind: 'project' },
      qlgd,
      other,
      sessionIn('s1', 'f-qlgd', 'V:\\Duancanhan\\Project_QuanLyGiaiDau\\HethongBackendApi_QuanlyGiaiDau'),
      sessionIn('s2', 'f-qlgd', 'V:\\Duancanhan\\Project_QuanLyGiaiDau\\HethongFrontEndWeb_QLgiaidau'),
      sessionIn('s3', 'f-other', 'V:\\Duancanhan\\AICheckVAR'),
    ];
    const placed = placeCloudRows([row('danh', 'heloo', ['HethongFrontEndApp_QLgiaidau', 'HethongBackendApi_QuanlyGiaiDau', 'HethongFrontEndWeb_QLgiaidau'])], {}, nodes);
    expect([...placed.byFolder.keys()]).toEqual(['f-qlgd']);
    expect(placed.loose).toEqual([]);
  });

  it('keeps the folder the user started it from over the repository guess', () => {
    const placed = placeCloudRows([row('danh', 'a', ['HethongBackendApi_QuanlyGiaiDau'])], { [cloudFolderKey('danh', 'a')]: 'f-web' }, tree);
    expect(placed.byFolder.get('f-web')).toHaveLength(1);
    expect(placed.byFolder.has('f-be')).toBe(false);
  });

  it('leaves a session whose repository has no folder in the loose list', () => {
    const placed = placeCloudRows([row('danh3', 'x', ['agent-chung-khoan']), row('danh3', 'y')], {}, tree);
    expect(placed.byFolder.size).toBe(0);
    expect(placed.loose).toHaveLength(2);
  });
});


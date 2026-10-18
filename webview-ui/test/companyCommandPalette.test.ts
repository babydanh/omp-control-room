import { describe, expect, it } from 'vitest';

import type { CompanyFileEntry, HerdrAgent } from '../../core/src/company.js';
import type { HerdrSleepingSession } from '../../core/src/messages.js';
import {
  buildPaletteItems,
  normalizeForSearch,
  PALETTE_ACTION_LABELS,
  PALETTE_ACTIONS,
  PALETTE_GROUP_ORDER,
  type PaletteItem,
  rankPaletteItems,
} from '../src/company/commandPalette.js';
import {
  type CompanyViewState,
  emptyHerdrView,
  type FileListingView,
} from '../src/company/companyState.js';
import { session, settings, stateFrom, task } from './companyFixtures.js';

const NO_FOLDERS = { activePath: null, folders: [] };

function stateWith(overrides: Partial<CompanyViewState>): CompanyViewState {
  return { ...stateFrom(), ...overrides };
}

function herdrAgent(overrides: Partial<HerdrAgent> = {}): HerdrAgent {
  return { paneId: 'pane-1', kind: 'omp', status: 'working', workspaceId: 'ws-1', ...overrides };
}

function sleepingEntry(overrides: Partial<HerdrSleepingSession> = {}): HerdrSleepingSession {
  return {
    paneId: 'sleep-1',
    title: '',
    sessionFile: '/sessions/a.jsonl',
    sleptAt: '2026-10-02T10:00:00.000Z',
    ...overrides,
  };
}

function fileEntry(path: string, kind: CompanyFileEntry['kind'] = 'file'): CompanyFileEntry {
  return { name: path.split('/').at(-1) ?? path, path, kind };
}

function fileListing(path: string, entries: CompanyFileEntry[], loaded = true): FileListingView {
  return { path, entries, loaded, error: null };
}

function item(id: string, fields: Partial<Omit<PaletteItem, 'id'>> = {}): PaletteItem {
  return {
    id,
    group: 'session',
    target: { kind: 'session', sessionId: id },
    title: id,
    subtitle: '',
    keywords: '',
    ...fields,
  };
}

function byId(items: readonly PaletteItem[], id: string): PaletteItem {
  const found = items.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`no palette item ${id}`);
  return found;
}

describe('normalizeForSearch', () => {
  it('strips Vietnamese marks and maps đ and Đ to d', () => {
    expect(normalizeForSearch('Đăng nhập')).toBe('dang nhap');
    expect(normalizeForSearch('ĐÔNG')).toBe('dong');
  });

  it('strips combining marks written as separate code points', () => {
    expect(normalizeForSearch('e\u0301')).toBe('e');
  });

  it('maps horn, circumflex and breve vowels to plain letters', () => {
    expect(normalizeForSearch('ư ơ ê ô ă')).toBe('u o e o a');
  });

  it('lowercases and keeps ASCII punctuation', () => {
    expect(normalizeForSearch('PA-S0001')).toBe('pa-s0001');
  });

  it('collapses whitespace runs and trims both ends', () => {
    expect(normalizeForSearch('  Nguyễn \t Văn\n\nÁnh  ')).toBe('nguyen van anh');
  });

  it('returns an empty string for blank input', () => {
    expect(normalizeForSearch(' \t\n ')).toBe('');
  });
});

describe('buildPaletteItems', () => {
  it('emits one action item per PALETTE_ACTIONS entry, in that order', () => {
    const items = buildPaletteItems(stateFrom(), NO_FOLDERS);
    const actions = items.filter((entry) => entry.group === 'action');

    expect(items).toHaveLength(PALETTE_ACTIONS.length);
    expect(actions.map((entry) => entry.id)).toEqual(
      PALETTE_ACTIONS.map((action) => `action:${action.id}`),
    );
    PALETTE_ACTIONS.forEach((action, index) => {
      expect(actions[index]).toMatchObject({
        target: { kind: 'action', action: action.id },
        title: action.title,
        subtitle: action.subtitle,
        keywords: action.keywords,
      });
    });
  });

  it('titles a session with its trimmed name and falls back to its code when the name is blank', () => {
    const items = buildPaletteItems(
      stateFrom({
        sessions: [
          session({ id: 's-1', code: 'PA-S0001', name: '  Lan  ', role: 'worker', status: 'busy' }),
          session({ id: 's-2', code: 'PA-S0002', name: '   ', role: 'worker' }),
        ],
      }),
      NO_FOLDERS,
    );

    expect(byId(items, 'session:s-1')).toMatchObject({
      group: 'session',
      target: { kind: 'session', sessionId: 's-1' },
      title: 'Lan',
      subtitle: 'PA-S0001 · Nhân viên · Đang bận',
    });
    expect(byId(items, 'session:s-2').title).toBe('PA-S0002');
  });

  it('keeps the session code and the active task title in its keywords', () => {
    const state = stateFrom({
      sessions: [session({ id: 's-3', code: 'PA-S0003', name: 'Lan', activeTaskId: 't-3' })],
      tasks: [task({ id: 't-3', code: 'PA-T0003', title: 'Cấu hình đăng nhập' })],
    });

    const row = byId(buildPaletteItems(state, NO_FOLDERS), 'session:s-3');

    expect(row.keywords).toContain('PA-S0003');
    expect(row.keywords).toContain('Cấu hình đăng nhập');
  });

  it('titles a task by code and title, and subtitles it with its status label', () => {
    const state = stateFrom({
      tasks: [task({ id: 't-1', code: 'PA-T0001', title: 'Viết API', status: 'running' })],
    });

    const row = byId(buildPaletteItems(state, NO_FOLDERS), 'task:t-1');

    expect(row).toMatchObject({
      group: 'task',
      target: { kind: 'task', taskId: 't-1' },
      title: 'PA-T0001 · Viết API',
      subtitle: 'Đang chạy',
    });
    expect(row.keywords).toContain('PA-T0001');
    expect(row.keywords).toContain('running');
  });

  it('titles a live agent by its name and subtitles it with repo and branch', () => {
    const state = stateWith({
      herdr: {
        ...emptyHerdrView(),
        loaded: true,
        agents: [herdrAgent({ paneId: 'p-1', name: 'Worker A', repo: 'pixel', branch: 'main' })],
      },
    });

    const row = byId(buildPaletteItems(state, NO_FOLDERS), 'herdr:p-1');

    expect(row).toMatchObject({
      group: 'herdr',
      target: { kind: 'herdr', paneId: 'p-1' },
      title: 'Worker A',
      subtitle: 'pixel · main',
    });
  });

  it('falls back to the kind for the title and the working folder for the subtitle', () => {
    const state = stateWith({
      herdr: {
        ...emptyHerdrView(),
        loaded: true,
        agents: [herdrAgent({ paneId: 'p-2', kind: 'claude', cwd: '/work/app' })],
      },
    });

    const row = byId(buildPaletteItems(state, NO_FOLDERS), 'herdr:p-2');

    expect(row).toMatchObject({ title: 'claude', subtitle: '/work/app' });
  });

  it('titles a sleeping session by its title and falls back to its pane when the title is blank', () => {
    const state = stateWith({
      herdr: {
        ...emptyHerdrView(),
        loaded: true,
        sleeping: [
          sleepingEntry({ paneId: 'sleep-1', title: 'Nhiệm vụ cũ' }),
          sleepingEntry({ paneId: 'sleep-2', title: '   ' }),
        ],
      },
    });

    const items = buildPaletteItems(state, NO_FOLDERS);

    expect(byId(items, 'sleeping:sleep-1')).toMatchObject({
      group: 'sleeping',
      target: { kind: 'sleeping', paneId: 'sleep-1' },
      title: 'Nhiệm vụ cũ',
      subtitle: 'Phiên ngủ đông',
    });
    expect(byId(items, 'sleeping:sleep-2').title).toBe('sleep-2');
  });

  it('titles a folder by its last segment whichever separator it uses, and marks the active one', () => {
    const folder = {
      activePath: '/work/gamma',
      folders: ['/work/alpha', 'C:\\work\\beta\\', '/work/gamma'],
    };

    const items = buildPaletteItems(stateFrom(), folder);

    expect(byId(items, 'folder:/work/alpha')).toMatchObject({
      group: 'folder',
      target: { kind: 'folder', path: '/work/alpha' },
      title: 'alpha',
      subtitle: '/work/alpha',
      keywords: '/work/alpha',
    });
    expect(byId(items, 'folder:C:\\work\\beta\\')).toMatchObject({
      title: 'beta',
      subtitle: 'C:\\work\\beta\\',
    });
    expect(byId(items, 'folder:/work/gamma')).toMatchObject({
      title: 'gamma',
      subtitle: '/work/gamma · đang mở',
    });
  });

  it('lists only loaded file entries, skips directories, and relates paths to the workspace root', () => {
    const state: CompanyViewState = {
      ...stateFrom({ settings: settings({ workspacePath: '/work/app' }) }),
      fileListings: {
        src: fileListing('src', [
          fileEntry('/work/app/src/a.ts'),
          fileEntry('/work/app/src/lib', 'directory'),
        ]),
        // Shares the root's spelling but is a sibling folder, so it keeps its full path.
        sibling: fileListing('sibling', [fileEntry('/work/application/b.ts')]),
        pending: fileListing('pending', [fileEntry('/work/app/c.ts')], false),
      },
    };

    const files = buildPaletteItems(state, NO_FOLDERS).filter((entry) => entry.group === 'file');

    expect(files.map((entry) => entry.id).sort()).toEqual([
      'file:/work/app/src/a.ts',
      'file:/work/application/b.ts',
    ]);
    expect(byId(files, 'file:/work/app/src/a.ts')).toMatchObject({
      title: 'a.ts',
      subtitle: 'src/a.ts',
      keywords: '/work/app/src/a.ts',
      target: { kind: 'file', path: '/work/app/src/a.ts' },
    });
    expect(byId(files, 'file:/work/application/b.ts').subtitle).toBe('/work/application/b.ts');
  });

  it('shows a workspace-relative entry path as given', () => {
    const state: CompanyViewState = {
      ...stateFrom({ settings: settings({ workspacePath: '/work/app' }) }),
      fileListings: { src: fileListing('src', [fileEntry('src/c.ts')]) },
    };

    const row = byId(buildPaletteItems(state, NO_FOLDERS), 'file:src/c.ts');

    expect(row.subtitle).toBe('src/c.ts');
  });

  it('caps file rows at 2000, dropping the extras in listing-key order', () => {
    const fileRows = (folder: string, count: number): CompanyFileEntry[] =>
      Array.from({ length: count }, (_, index) => fileEntry(`${folder}/f${index}.ts`));
    const state: CompanyViewState = {
      ...stateFrom(),
      // Inserted out of key order: the cap follows sorted keys, not insertion order.
      fileListings: {
        b: fileListing('b', fileRows('b', 1000)),
        a: fileListing('a', fileRows('a', 1500)),
      },
    };

    const files = buildPaletteItems(state, NO_FOLDERS).filter((entry) => entry.group === 'file');
    const fileIds = new Set(files.map((entry) => entry.id));

    expect(files).toHaveLength(2000);
    expect(fileIds.has('file:a/f1499.ts')).toBe(true);
    expect(fileIds.has('file:b/f499.ts')).toBe(true);
    expect(fileIds.has('file:b/f500.ts')).toBe(false);
  });

  it('keeps the first row when two rows claim the same id', () => {
    const state = stateWith({
      herdr: {
        ...emptyHerdrView(),
        loaded: true,
        agents: [
          herdrAgent({ paneId: 'dup', name: 'First' }),
          herdrAgent({ paneId: 'dup', name: 'Second' }),
        ],
      },
    });

    const items = buildPaletteItems(state, { activePath: null, folders: ['/a', '/a'] });

    expect(items.filter((entry) => entry.id === 'herdr:dup')).toEqual([
      expect.objectContaining({ title: 'First' }),
    ]);
    expect(items.filter((entry) => entry.id === 'folder:/a')).toHaveLength(1);
  });

  it('gives every row a target whose kind is its group, with all seven groups present', () => {
    const state: CompanyViewState = {
      ...stateFrom({
        settings: settings({ workspacePath: '/work/app' }),
        sessions: [session({ id: 's-1' })],
        tasks: [task({ id: 't-1' })],
      }),
      herdr: {
        ...emptyHerdrView(),
        loaded: true,
        agents: [herdrAgent({ paneId: 'p-1' })],
        sleeping: [sleepingEntry({ paneId: 'sleep-1' })],
      },
      fileListings: { src: fileListing('src', [fileEntry('/work/app/src/a.ts')]) },
    };

    const items = buildPaletteItems(state, { activePath: '/work/app', folders: ['/work/app'] });

    expect(new Set(items.map((entry) => entry.group))).toEqual(new Set(PALETTE_GROUP_ORDER));
    expect(items.every((entry) => entry.target.kind === entry.group)).toBe(true);
  });
});

describe('rankPaletteItems', () => {
  it('keeps every row in group order, input order within a group, when the query is blank', () => {
    const items = [
      item('file-1', { group: 'file' }),
      item('session-1', { group: 'session' }),
      item('action-1', { group: 'action' }),
      item('session-2', { group: 'session' }),
      item('folder-1', { group: 'folder' }),
    ];

    const ranked = rankPaletteItems(items, '   ');

    expect(ranked.map((match) => match.item.id)).toEqual([
      'action-1',
      'session-1',
      'session-2',
      'folder-1',
      'file-1',
    ]);
    expect(ranked.every((match) => match.score === 0)).toBe(true);
  });

  it('requires every token to match somewhere in the row', () => {
    const items = [item('lan', { title: 'Lan Nguyen', subtitle: 'PA-S0001' })];

    expect(rankPaletteItems(items, 'lan pa')).toHaveLength(1);
    expect(rankPaletteItems(items, 'lan zzz')).toEqual([]);
  });

  it('ranks a title prefix above a subtitle hit', () => {
    const items = [
      item('subtitle-hit', { title: 'Other', subtitle: 'review queue' }),
      item('title-hit', { title: 'Review build' }),
    ];

    const ranked = rankPaletteItems(items, 'review');

    expect(ranked.map((match) => match.item.id)).toEqual(['title-hit', 'subtitle-hit']);
  });

  it('scores each title tier in order: exact, prefix, word prefix, substring, subsequence', () => {
    const items = [
      item('subsequence', { title: 'd a n g' }),
      item('substring', { title: 'xdangx' }),
      item('word', { title: 'nhap dang' }),
      item('prefix', { title: 'dang nhap' }),
      item('exact', { title: 'dang' }),
    ];

    const ranked = rankPaletteItems(items, 'dang');

    expect(ranked.map((match) => [match.item.id, match.score])).toEqual([
      ['exact', 100],
      ['prefix', 79],
      ['word', 59],
      ['substring', 50],
      ['subsequence', 30],
    ]);
  });

  it('scores a subtitle substring 20 and a keyword subsequence 10, below any title hit', () => {
    const items = [
      item('keyword-subsequence', { title: 'Gamma', keywords: 'd a n g' }),
      item('subtitle-substring', { title: 'Alpha', subtitle: 'nhap dang' }),
    ];

    const ranked = rankPaletteItems(items, 'dang');

    expect(ranked.map((match) => [match.item.id, match.score])).toEqual([
      ['subtitle-substring', 20],
      ['keyword-subsequence', 10],
    ]);
  });

  it('matches diacritic-insensitively in both directions', () => {
    const items = [item('name', { title: 'Đăng nhập' })];

    expect(rankPaletteItems(items, 'dang')).toEqual([{ item: items[0], score: 79 }]);
    expect(rankPaletteItems(items, 'Đăng')).toHaveLength(1);
  });

  it('takes one point per eight title characters off the score', () => {
    const items = [
      item('long', { title: 'Lan Nguyen Van Anh Thu' }),
      item('short', { title: 'Lan' }),
    ];

    const ranked = rankPaletteItems(items, 'la');

    expect(ranked.map((match) => [match.item.id, match.score])).toEqual([
      ['short', 80],
      ['long', 78],
    ]);
  });

  it('never lets a score go below zero, but still keeps the matching row', () => {
    const items = [item('long', { title: 'q'.repeat(96), subtitle: 'review' })];

    const ranked = rankPaletteItems(items, 'rv');

    expect(ranked).toEqual([{ item: items[0], score: 0 }]);
  });

  it('breaks ties by group, then normalized title, then id, whatever the input order', () => {
    const items = [
      item('task:b', { group: 'task', title: 'Task beta' }),
      item('task:a2', { group: 'task', title: 'Task alpha' }),
      item('session:x', { group: 'session', title: 'Task alpha' }),
      item('task:a', { group: 'task', title: 'Task alpha' }),
    ];

    const ranked = rankPaletteItems(items, 'task');

    expect(ranked.map((match) => match.item.id)).toEqual([
      'session:x',
      'task:a',
      'task:a2',
      'task:b',
    ]);
  });

  it('caps results at the limit and falls back to 60 for a limit that is not a positive integer', () => {
    const items = Array.from({ length: 70 }, (_, index) =>
      item(`item-${index}`, { title: `Item ${index}` }),
    );

    expect(rankPaletteItems(items, 'item', 5)).toHaveLength(5);
    expect(rankPaletteItems(items, 'item')).toHaveLength(60);
    expect(rankPaletteItems(items, '', 0)).toHaveLength(60);
    expect(rankPaletteItems(items, '', -3)).toHaveLength(60);
    expect(rankPaletteItems(items, '', 2.5)).toHaveLength(60);
    expect(rankPaletteItems(items, '', Number.NaN)).toHaveLength(60);
  });
});

describe('palette constants', () => {
  it('lists every group once, in display order', () => {
    expect([...PALETTE_GROUP_ORDER]).toEqual([
      'action',
      'session',
      'task',
      'herdr',
      'sleeping',
      'folder',
      'file',
    ]);
  });

  it('titles each action with its label from the label table', () => {
    expect(PALETTE_ACTIONS.map((action) => action.title)).toEqual(
      PALETTE_ACTIONS.map((action) => PALETTE_ACTION_LABELS[action.id]),
    );
  });
});

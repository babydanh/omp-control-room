import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { emptyWorkItemsFile } from '../src/company/workItems/workItemModel.js';
import { WORK_ITEMS_FILE_NAME, WorkItemFileStore } from '../src/company/workItems/workItemStore.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'work-items-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('WorkItemFileStore', () => {
  it('loads an empty folder when no file exists yet', async () => {
    const parsed = await new WorkItemFileStore(dir).load();

    expect(parsed.corrupt).toBe(false);
    expect(parsed.file).toEqual(emptyWorkItemsFile());
  });

  it('reads back exactly what it saved', async () => {
    const store = new WorkItemFileStore(dir);
    const file = { ...emptyWorkItemsFile(), revision: 4, nextSequence: 2 };

    await store.save(file);

    expect(fs.existsSync(path.join(dir, WORK_ITEMS_FILE_NAME))).toBe(true);
    expect((await store.load()).file).toEqual(file);
  });

  it('moves an unreadable file aside and loads an empty folder', async () => {
    fs.writeFileSync(path.join(dir, WORK_ITEMS_FILE_NAME), '{ not json', 'utf-8');

    const parsed = await new WorkItemFileStore(dir).load();

    expect(parsed.corrupt).toBe(true);
    expect(parsed.file).toEqual(emptyWorkItemsFile());
    expect(fs.existsSync(path.join(dir, WORK_ITEMS_FILE_NAME))).toBe(false);
    const aside = fs.readdirSync(dir).filter((name) => name.startsWith('work-items.corrupt-'));
    expect(aside).toHaveLength(1);
  });
});

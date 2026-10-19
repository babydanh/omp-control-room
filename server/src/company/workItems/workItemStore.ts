/**
 * Durable storage for one folder's work items and role notes: one JSON file in the folder's
 * company namespace directory. Writes go through a temp file and are synced before the rename, so a
 * crash leaves the previous file or the new one, never half of one.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { type ParsedWorkItems, parseWorkItemsFile, type WorkItemsFile } from './workItemModel.js';

/** File name inside the folder's company namespace directory. */
export const WORK_ITEMS_FILE_NAME = 'work-items.json';

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

export class WorkItemFileStore {
  private readonly directory: string;
  private readonly filePath: string;

  constructor(directory: string) {
    this.directory = directory;
    this.filePath = path.join(directory, WORK_ITEMS_FILE_NAME);
  }

  /**
   * Reads the file. A file that cannot be used is moved aside under a dated name first, so the
   * next save cannot overwrite what the user might still want to inspect.
   */
  async load(): Promise<ParsedWorkItems> {
    let text: string;
    try {
      text = await fs.promises.readFile(this.filePath, 'utf-8');
    } catch (error) {
      if (isMissingFile(error)) return parseWorkItemsFile(null);
      throw error;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      raw = text;
    }
    const parsed = parseWorkItemsFile(raw);
    if (parsed.corrupt) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      await fs.promises.rename(
        this.filePath,
        path.join(this.directory, `work-items.corrupt-${stamp}.json`),
      );
    }
    return parsed;
  }

  /** Replaces the file with `file`. Resolves once the new content is on disk. */
  async save(file: WorkItemsFile): Promise<void> {
    await fs.promises.mkdir(this.directory, { recursive: true });
    const tmpPath = `${this.filePath}.tmp`;
    const handle = await fs.promises.open(tmpPath, 'w');
    try {
      await handle.writeFile(JSON.stringify(file, null, 2), 'utf-8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.promises.rename(tmpPath, this.filePath);
  }
}

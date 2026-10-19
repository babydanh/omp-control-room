/**
 * Durable storage for one folder's work items and role notes: one JSON file in the folder's
 * company namespace directory, written atomically through {@link DurableJsonFile}.
 */

import { DurableJsonFile } from '../durableJsonFile.js';
import { type ParsedWorkItems, parseWorkItemsFile, type WorkItemsFile } from './workItemModel.js';

/** File name inside the folder's company namespace directory. */
export const WORK_ITEMS_FILE_NAME = 'work-items.json';

export class WorkItemFileStore {
  private readonly file: DurableJsonFile<ParsedWorkItems>;

  constructor(directory: string) {
    this.file = new DurableJsonFile(directory, WORK_ITEMS_FILE_NAME, parseWorkItemsFile);
  }

  /** Reads the file; see {@link DurableJsonFile.load} for an unusable file. */
  load(): Promise<ParsedWorkItems> {
    return this.file.load();
  }

  /** Replaces the file with `file`. Resolves once the new content is on disk. */
  save(file: WorkItemsFile): Promise<void> {
    return this.file.save(file);
  }
}

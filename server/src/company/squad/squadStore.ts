/**
 * Durable storage for one folder's squad runs: one JSON file in the folder's company namespace
 * directory, written atomically through {@link DurableJsonFile}.
 */

import { DurableJsonFile } from '../durableJsonFile.js';
import { type ParsedSquadFile, parseSquadFile, type SquadFile } from './squadModel.js';

/** File name inside the folder's company namespace directory. */
export const SQUAD_FILE_NAME = 'squad-runs.json';

export class SquadFileStore {
  private readonly file: DurableJsonFile<ParsedSquadFile>;

  constructor(directory: string) {
    this.file = new DurableJsonFile(directory, SQUAD_FILE_NAME, parseSquadFile);
  }

  /** Reads the file; see {@link DurableJsonFile.load} for an unusable file. */
  load(): Promise<ParsedSquadFile> {
    return this.file.load();
  }

  /** Replaces the file with `file`. Resolves once the new content is on disk. */
  save(file: SquadFile): Promise<void> {
    return this.file.save(file);
  }
}

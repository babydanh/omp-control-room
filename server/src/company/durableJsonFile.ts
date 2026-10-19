/**
 * One JSON file in a folder's company namespace directory, written atomically: the new content goes
 * to a temp file that is synced before it replaces the old one, so a crash leaves the previous file
 * or the new one, never half of one. Each store supplies its own `parse`, which decides what counts
 * as a usable file.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/** What a store's `parse` returns. `corrupt` means the file existed but was not usable. */
export interface ParsedJsonFile {
  readonly corrupt: boolean;
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

export class DurableJsonFile<T extends ParsedJsonFile> {
  private readonly directory: string;
  private readonly fileName: string;
  private readonly filePath: string;
  private readonly parse: (raw: unknown) => T;

  /** `parse(null)` describes a missing file; `parse(text)` a file that is not valid JSON. */
  constructor(directory: string, fileName: string, parse: (raw: unknown) => T) {
    this.directory = directory;
    this.fileName = fileName;
    this.filePath = path.join(directory, fileName);
    this.parse = parse;
  }

  /**
   * Reads the file. A file that cannot be used is moved aside under a dated name first, so the next
   * save cannot overwrite what the user might still want to inspect.
   */
  async load(): Promise<T> {
    let text: string;
    try {
      text = await fs.promises.readFile(this.filePath, 'utf-8');
    } catch (error) {
      if (isMissingFile(error)) return this.parse(null);
      throw error;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      raw = text;
    }
    const parsed = this.parse(raw);
    if (parsed.corrupt) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const base = this.fileName.replace(/\.json$/, '');
      await fs.promises.rename(
        this.filePath,
        path.join(this.directory, `${base}.corrupt-${stamp}.json`),
      );
    }
    return parsed;
  }

  /** Replaces the file with `value`. Resolves once the new content is on disk. */
  async save(value: unknown): Promise<void> {
    await fs.promises.mkdir(this.directory, { recursive: true });
    const tmpPath = `${this.filePath}.tmp`;
    const handle = await fs.promises.open(tmpPath, 'w');
    try {
      await handle.writeFile(JSON.stringify(value, null, 2), 'utf-8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.promises.rename(tmpPath, this.filePath);
  }
}

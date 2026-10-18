import { describe, expect, it } from 'vitest';

import {
  COMPOSER_HEIGHT_KEY,
  type ComposerStorage,
  readComposerHeight,
  writeComposerHeight,
} from '../src/company/composerPrefs.js';

/** An in-memory store, optionally already holding a raw value under the composer key. */
function memoryStorage(raw?: string): ComposerStorage & { values: Map<string, string> } {
  const values = new Map<string, string>();
  if (raw !== undefined) values.set(COMPOSER_HEIGHT_KEY, raw);
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}

/** A store that refuses every access, as a privacy-mode browser does. */
const refusingStorage: ComposerStorage = {
  getItem() {
    throw new Error('storage denied');
  },
  setItem() {
    throw new Error('storage denied');
  },
};

describe('composer height preference', () => {
  it('reads nothing when there is no storage or nothing was saved', () => {
    expect(readComposerHeight(null)).toBeNull();
    expect(readComposerHeight(memoryStorage())).toBeNull();
  });

  it('round-trips a dragged height, rounded to whole pixels', () => {
    const storage = memoryStorage();
    writeComposerHeight(storage, 143.6);
    expect(storage.values.get(COMPOSER_HEIGHT_KEY)).toBe('144');
    expect(readComposerHeight(storage)).toBe(144);
  });

  it('ignores a saved value that is not a usable height', () => {
    for (const raw of ['abc', '', '0', '-5', 'Infinity']) {
      expect(readComposerHeight(memoryStorage(raw))).toBeNull();
    }
  });

  it('does nothing without storage', () => {
    expect(() => writeComposerHeight(null, 120)).not.toThrow();
  });

  it('survives a storage that refuses access', () => {
    expect(readComposerHeight(refusingStorage)).toBeNull();
    expect(() => writeComposerHeight(refusingStorage, 120)).not.toThrow();
  });
});

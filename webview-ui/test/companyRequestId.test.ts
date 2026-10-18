import { afterEach, describe, expect, it, vi } from 'vitest';

import { newRequestId } from '../src/company/companyMessages.js';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('newRequestId', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // A board opened at a LAN address over plain HTTP is not a secure context,
  // where browsers leave `crypto.randomUUID` undefined.
  it('mints a v4 uuid without crypto.randomUUID', () => {
    const realCrypto = globalThis.crypto;
    vi.stubGlobal('crypto', {
      getRandomValues: <T extends ArrayBufferView>(array: T): T =>
        realCrypto.getRandomValues(array),
    });
    const id = newRequestId();
    expect(id).toMatch(UUID_V4);
    expect(newRequestId()).not.toBe(id);
  });
});

import { describe, expect, it } from 'vitest';

import { drawerWidthLimit, rememberedOrChatWidth } from '../src/company/drawerPrefs.js';

describe('rememberedOrChatWidth', () => {
  it('keeps the width the reader last dragged to, whether or not the session is live', () => {
    expect(rememberedOrChatWidth(420, true, 1600)).toBe(420);
    expect(rememberedOrChatWidth(420, false, 1600)).toBe(420);
  });

  it('asks a live chat for the widest drawer the board leaves room for until the reader drags', () => {
    expect(rememberedOrChatWidth(null, true, 1600)).toBe(drawerWidthLimit(1600));
  });

  it('leaves a session that is not live on the default width until the reader drags', () => {
    expect(rememberedOrChatWidth(null, false, 1600)).toBeNull();
  });
});

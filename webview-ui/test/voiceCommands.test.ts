import { describe, expect, it } from 'vitest';

import { readVoiceCommands } from '../src/company/voiceCommands.js';

describe('readVoiceCommands', () => {
  it('takes out "chụp màn" and a final "gửi đi", with or without diacritics, and keeps the prompt', () => {
    expect(readVoiceCommands('Chụp màn hình này, nút đăng nhập bị lệch, sửa giúp. Gửi đi.')).toEqual({
      text: 'nút đăng nhập bị lệch, sửa giúp.',
      capture: true,
      send: true,
    });
    expect(readVoiceCommands('chup man nay xem loi gi')).toEqual({ text: 'xem loi gi', capture: true, send: false });
  });

  it('leaves ordinary speech alone: "gửi đi" in the middle, "chụp" without "màn"', () => {
    expect(readVoiceCommands('gửi đi email rồi sửa test')).toEqual({ text: 'gửi đi email rồi sửa test', capture: false, send: false });
    expect(readVoiceCommands('ảnh chụp avatar bị méo')).toEqual({ text: 'ảnh chụp avatar bị méo', capture: false, send: false });
  });
});

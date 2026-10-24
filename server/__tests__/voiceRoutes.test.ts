import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import { registerVoiceRoutes, spokenText, VOICE_CAPTURE_ROUTE, VOICE_NO_KEY_REASON, VOICE_TRANSCRIBE_ROUTE } from '../src/voice/voiceRoutes.js';

const TOKEN = 'board-token';

async function server(options: Partial<Parameters<typeof registerVoiceRoutes>[1]> = {}) {
  const app = Fastify();
  registerVoiceRoutes(app, { token: TOKEN, ...options });
  await app.ready();
  return app;
}

const audio = (headers: Record<string, string> = {}) => ({
  method: 'POST' as const,
  url: VOICE_TRANSCRIBE_ROUTE,
  headers: { 'content-type': 'audio/webm', ...headers },
  payload: Buffer.from([1, 2, 3]),
});

describe('voice routes', () => {
  it('turn away a request without the board token before reading a key, the microphone audio or the screen', async () => {
    const transcribe = vi.fn(async () => 'x');
    const captureScreen = vi.fn(async () => Buffer.from('png'));
    const app = await server({ groqKey: async () => 'k', transcribe, captureScreen });
    expect((await app.inject(audio())).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: VOICE_CAPTURE_ROUTE, headers: { authorization: 'Bearer wrong' } })).statusCode).toBe(401);
    expect(transcribe).not.toHaveBeenCalled();
    expect(captureScreen).not.toHaveBeenCalled();
  });

  it('says how to add the Groq key when none is set, and returns the text when one is', async () => {
    const noKey = await server({ groqKey: async () => undefined });
    const missing = await noKey.inject(audio({ authorization: `Bearer ${TOKEN}` }));
    expect(missing.statusCode).toBe(503);
    expect(missing.json()).toEqual({ error: VOICE_NO_KEY_REASON });

    const transcribe = vi.fn(async () => 'sửa nút đăng nhập');
    const withKey = await server({ groqKey: async () => 'k', transcribe });
    const done = await withKey.inject(audio({ authorization: `Bearer ${TOKEN}` }));
    expect(done.json()).toEqual({ text: 'sửa nút đăng nhập' });
    expect(transcribe).toHaveBeenCalledWith(Buffer.from([1, 2, 3]), 'audio/webm', 'k');
  });

  it('returns the screen as a PNG, and a readable reason when the capture fails', async () => {
    const ok = await server({ captureScreen: async () => Buffer.from('png-bytes') });
    const shot = await ok.inject({ method: 'POST', url: VOICE_CAPTURE_ROUTE, headers: { authorization: `Bearer ${TOKEN}` } });
    expect(shot.headers['content-type']).toBe('image/png');
    expect(shot.rawPayload.toString()).toBe('png-bytes');

    const broken = await server({ captureScreen: async () => { throw new Error('cua-driver không chạy'); } });
    const failed = await broken.inject({ method: 'POST', url: VOICE_CAPTURE_ROUTE, headers: { authorization: `Bearer ${TOKEN}` } });
    expect(failed.statusCode).toBe(502);
    expect(failed.json()).toEqual({ error: 'cua-driver không chạy' });
  });
});

describe('spokenText', () => {
  it('drops a transcript that is only what Whisper invents over silence, and keeps every word of real speech', () => {
    // The reply Groq gave for one second of silence, no_speech_prob 0 included.
    expect(spokenText({ segments: [{ text: ' Hãy subscribe cho kênh Ghiền Mì Gõ Để không bỏ lỡ những video hấp dẫn', no_speech_prob: 0 }] })).toBe('');
    expect(spokenText({ segments: [{ text: ' ồn', no_speech_prob: 0.9 }, { text: ' ồn', no_speech_prob: 0.8 }] })).toBe('');
    // A pause mid-sentence, and the same words inside a real prompt, lose nothing.
    expect(spokenText({ segments: [
      { text: ' thêm nút đăng ký kênh', no_speech_prob: 0.01 },
      { text: ' ở trang chủ', no_speech_prob: 0.9 },
      { text: ' rồi gửi đi', no_speech_prob: 0.02 },
    ] })).toBe('thêm nút đăng ký kênh ở trang chủ rồi gửi đi');
    expect(spokenText({ text: ' chỉ có chữ ' })).toBe('chỉ có chữ');
    // Silence with the vocabulary prompt: Groq returned the prompt's first words.
    expect(spokenText({ segments: [{ text: ' Lập trình', no_speech_prob: 0 }] })).toBe('');
    expect(spokenText({ segments: [{ text: ' Lập trình lại màn đăng nhập', no_speech_prob: 0 }] })).toBe('Lập trình lại màn đăng nhập');
  });
});

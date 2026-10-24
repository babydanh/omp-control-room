/**
 * Voice routes: what the composer's 🎤 and 📸 buttons call.
 *
 * POST /api/voice/transcribe takes the recorded audio and returns its text from Groq's
 * whisper-large-v3-turbo (Vietnamese). POST /api/voice/capture returns a PNG of the whole
 * screen taken by cua-driver. Both need the board's bearer token: a page on another origin
 * cannot read it, and the Authorization header makes its request preflight, which the board
 * never approves. The screen PNG lives in a temp file only until it is read.
 */

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import type { FastifyInstance } from 'fastify';

import { bearerTokenValid } from '../wsAuth.js';

const execFileAsync = promisify(execFile);

export const VOICE_TRANSCRIBE_ROUTE = '/api/voice/transcribe';
export const VOICE_CAPTURE_ROUTE = '/api/voice/capture';

const GROQ_TRANSCRIBE_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const GROQ_MODEL = 'whisper-large-v3-turbo';
const GROQ_KEY_NAME = 'GROQ_API_KEY';
/** Groq's free tier takes files up to 25 MB; a spoken prompt is far below it. */
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const TRANSCRIBE_TIMEOUT_MS = 60_000;
const CAPTURE_TIMEOUT_MS = 20_000;
/** Long edge of the screen PNG: enough to read UI text, small enough to attach. */
const CAPTURE_MAX_DIMENSION = 1920;

export const VOICE_NO_KEY_REASON =
  'Chưa có GROQ_API_KEY: tạo key ở console.groq.com/keys, đặt biến môi trường User GROQ_API_KEY rồi bấm mic lại.';

export interface VoiceRoutesOptions {
  readonly token: string;
  /** The Groq key; the default reads the process env, then the Windows User env set after the board started. */
  readonly groqKey?: () => Promise<string | undefined>;
  readonly transcribe?: (audio: Buffer, contentType: string, key: string) => Promise<string>;
  readonly captureScreen?: () => Promise<Buffer>;
}

export function registerVoiceRoutes(app: FastifyInstance, options: VoiceRoutesOptions): void {
  const groqKey = options.groqKey ?? readGroqKey;
  const transcribe = options.transcribe ?? transcribeWithGroq;
  const captureScreen = options.captureScreen ?? captureWithCuaDriver;

  // Raw audio bodies are parsed only inside this scope.
  void app.register(async (scope) => {
    scope.addContentTypeParser(/^audio\//, { parseAs: 'buffer', bodyLimit: MAX_AUDIO_BYTES }, (_request, body, done) => done(null, body));

    scope.post(VOICE_TRANSCRIBE_ROUTE, async (request, reply) => {
      if (!bearerTokenValid(request.headers.authorization, options.token)) return reply.code(401).send({ error: 'unauthorized' });
      const audio = request.body;
      if (!Buffer.isBuffer(audio) || audio.length === 0) return reply.code(400).send({ error: 'Không nhận được âm thanh.' });
      const key = await groqKey();
      if (key === undefined) return reply.code(503).send({ error: VOICE_NO_KEY_REASON });
      try {
        const text = await transcribe(audio, request.headers['content-type'] ?? 'audio/webm', key);
        return reply.send({ text });
      } catch (error) {
        return reply.code(502).send({ error: error instanceof Error ? error.message : 'Không chép được giọng nói.' });
      }
    });

    scope.post(VOICE_CAPTURE_ROUTE, async (request, reply) => {
      if (!bearerTokenValid(request.headers.authorization, options.token)) return reply.code(401).send({ error: 'unauthorized' });
      let png: Buffer;
      try {
        png = await captureScreen();
      } catch (error) {
        return reply.code(502).send({ error: error instanceof Error ? error.message : 'Không chụp được màn hình.' });
      }
      return reply.type('image/png').send(png);
    });
  });
}

let cachedKey: string | undefined;

/** The process env first; on Windows a key set as a User variable after the board started is read from the registry. */
async function readGroqKey(): Promise<string | undefined> {
  const fromEnv = process.env[GROQ_KEY_NAME]?.trim();
  if (fromEnv) return fromEnv;
  if (cachedKey !== undefined || process.platform !== 'win32') return cachedKey;
  const output = await run('reg', ['query', 'HKCU\\Environment', '/v', GROQ_KEY_NAME], 5_000).catch(() => '');
  const match = new RegExp(`${GROQ_KEY_NAME}\\s+REG_\\w+\\s+(\\S+)`).exec(output);
  cachedKey = match?.[1];
  return cachedKey;
}

async function transcribeWithGroq(audio: Buffer, contentType: string, key: string): Promise<string> {
  const form = new FormData();
  const extension = contentType.includes('ogg') ? 'ogg' : contentType.includes('mp4') ? 'mp4' : contentType.includes('wav') ? 'wav' : 'webm';
  form.append('file', new Blob([new Uint8Array(audio)], { type: contentType }), `prompt.${extension}`);
  form.append('model', GROQ_MODEL);
  form.append('language', 'vi');
  form.append('response_format', 'json');
  form.append('temperature', '0');
  const response = await fetch(GROQ_TRANSCRIBE_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` },
    body: form,
    signal: AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS),
  });
  if (!response.ok) {
    // Groq's error body names the problem (bad key, rate limit); it never echoes the key.
    const detail = (await response.text()).slice(0, 300);
    throw new Error(`Groq trả lỗi ${response.status}: ${detail}`);
  }
  const body = (await response.json()) as { text?: unknown };
  return typeof body.text === 'string' ? body.text.trim() : '';
}

async function captureWithCuaDriver(): Promise<Buffer> {
  const file = join(tmpdir(), `board-capture-${randomUUID()}.png`);
  const args = JSON.stringify({ max_image_dimension: CAPTURE_MAX_DIMENSION, screenshot_out_file: file });
  try {
    await run('cua-driver', ['call', 'get_desktop_state', args], CAPTURE_TIMEOUT_MS);
    return await readFile(file);
  } finally {
    await rm(file, { force: true });
  }
}

async function run(file: string, args: readonly string[], timeoutMs: number): Promise<string> {
  const { stdout } = await execFileAsync(file, [...args], { encoding: 'utf8', timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 });
  return stdout;
}

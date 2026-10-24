/**
 * useVoiceInput: the composer's microphone and screen capture.
 *
 * Recording uses MediaRecorder in the page; the audio goes to the board server, which asks
 * Groq for the text (see server/src/voice/voiceRoutes.ts). The browser's own speech API is not
 * used: Brave does not provide its recognition service. Capture waits a few seconds so the user
 * can bring the window to show to the front, then the server takes the whole screen.
 */

import { useEffect, useRef, useState } from 'react';

import { serverToken } from '../transport/serverToken.js';

export type VoiceState = 'idle' | 'recording' | 'transcribing';

const TRANSCRIBE_ROUTE = '/api/voice/transcribe';
const CAPTURE_ROUTE = '/api/voice/capture';
export const CAPTURE_DELAY_SECONDS = 3;

function authHeaders(): Record<string, string> {
  return serverToken === null ? {} : { Authorization: `Bearer ${serverToken}` };
}

async function errorOf(response: Response, fallback: string): Promise<string> {
  const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
  return typeof body?.error === 'string' ? body.error : fallback;
}

export function useVoiceInput(onText: (text: string) => void, onError: (message: string) => void): {
  readonly state: VoiceState;
  readonly seconds: number;
  readonly toggle: () => void;
} {
  const [state, setState] = useState<VoiceState>('idle');
  const [seconds, setSeconds] = useState(0);
  const recorder = useRef<MediaRecorder | null>(null);
  /** Set from the press until recording starts: a second press meanwhile opens no second microphone. */
  const starting = useRef(false);
  const handlers = useRef({ onText, onError });
  handlers.current = { onText, onError };

  useEffect(() => {
    if (state !== 'recording') return undefined;
    const started = Date.now();
    const timer = window.setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 250);
    return () => window.clearInterval(timer);
  }, [state]);
  // Leaving the page mid-recording releases the microphone.
  useEffect(() => () => recorder.current?.stream.getTracks().forEach((track) => track.stop()), []);

  async function start(): Promise<void> {
    if (starting.current || recorder.current !== null) return;
    starting.current = true;
    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const opened = stream;
      const chunks: Blob[] = [];
      const next = new MediaRecorder(opened);
      next.addEventListener('dataavailable', (event) => chunks.push(event.data));
      next.addEventListener('stop', () => {
        opened.getTracks().forEach((track) => track.stop());
        recorder.current = null;
        void transcribe(new Blob(chunks, { type: next.mimeType || 'audio/webm' }));
      });
      next.start();
      recorder.current = next;
      setSeconds(0);
      setState('recording');
    } catch {
      stream?.getTracks().forEach((track) => track.stop());
      handlers.current.onError('Không mở được mic: cho phép trình duyệt dùng micro rồi thử lại.');
    } finally {
      starting.current = false;
    }
  }

  async function transcribe(audio: Blob): Promise<void> {
    if (audio.size === 0) {
      setState('idle');
      return;
    }
    setState('transcribing');
    try {
      const response = await fetch(TRANSCRIBE_ROUTE, {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': audio.type.split(';')[0] || 'audio/webm' },
        body: audio,
      });
      if (!response.ok) throw new Error(await errorOf(response, 'Không chép được giọng nói.'));
      const body = (await response.json()) as { text?: unknown };
      const text = typeof body.text === 'string' ? body.text.trim() : '';
      if (text !== '') handlers.current.onText(text);
    } catch (error) {
      handlers.current.onError(error instanceof Error ? error.message : 'Không chép được giọng nói.');
    } finally {
      setState('idle');
    }
  }

  return {
    state,
    seconds,
    toggle: () => {
      if (state === 'recording') recorder.current?.stop();
      else if (state === 'idle') void start();
    },
  };
}

/** The whole screen as a PNG file, taken by the board server. */
export async function captureScreen(): Promise<File> {
  const response = await fetch(CAPTURE_ROUTE, { method: 'POST', headers: authHeaders() });
  if (!response.ok) throw new Error(await errorOf(response, 'Không chụp được màn hình.'));
  return new File([await response.blob()], `man-hinh-${Date.now()}.png`, { type: 'image/png' });
}

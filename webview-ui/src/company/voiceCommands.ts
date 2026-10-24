/**
 * voiceCommands: the two spoken commands the composer understands in a dictated prompt.
 * "chụp màn (hình) (này)" asks for a screen capture to mark up; "gửi đi" at the very end sends
 * the prompt. The command words are taken out; the rest of what was said is the prompt text.
 * DOM-free and React-free.
 */

export interface VoiceCommandResult {
  readonly text: string;
  readonly capture: boolean;
  readonly send: boolean;
}

// Whisper writes Vietnamese with or without diacritics, so both spellings count.
const CAPTURE = /(^|[\s,.!?])(chụp|chup)(\s+lại|\s+lai)?\s+(màn|man)(\s+(hình|hinh))?(\s+(này|nay))?(?=$|[\s,.!?])/iu;
const SEND = /(^|[\s,.!?])(gửi|gui)\s+(đi|di)[\s.!?]*$/iu;

export function readVoiceCommands(transcript: string): VoiceCommandResult {
  let text = transcript.trim();
  const send = SEND.test(text);
  if (send) text = text.replace(SEND, '$1');
  const capture = CAPTURE.test(text);
  if (capture) text = text.replace(CAPTURE, '$1');
  return { text: text.replace(/\s+/g, ' ').replace(/^[\s,.!?]+|[\s,]+$/g, '').trim(), capture, send };
}

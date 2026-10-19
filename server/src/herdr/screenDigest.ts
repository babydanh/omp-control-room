import { createHash } from 'node:crypto';

/**
 * Digest of one screen's text. Two reads with the same digest show the same screen, so a
 * screen watch emits only when the digest changes.
 */
export function screenDigest(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

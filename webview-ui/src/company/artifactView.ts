/**
 * artifactView: turning paged bytes into something a person can read.
 *
 * Artifacts arrive as base64 pages that can split a UTF-8 sequence at any byte
 * boundary, so the decoder streams across pages (`{ stream: true }`) instead of
 * decoding each page on its own -- decoding a page alone turns the tail of a
 * multi-byte character into a replacement glyph.
 *
 * Workspace files arrive already decoded by the server, and they say which
 * encoding they used. A binary page is NOT rendered as text: pretending a PNG
 * is a string produces noise that looks like corruption.
 */

import type { CompanyFileContent } from '../../../core/src/messages.js';
import { decodeBase64ToBytes } from './base64.js';
import type { ArtifactView } from './companyState.js';

export interface ArtifactText {
  text: string;
  bytesHeld: number;
  /** True when the artifact was longer than what was decoded here. */
  clipped: boolean;
}

/** Decode the pages held for an artifact, in offset order. */
export function decodeArtifact(artifact: ArtifactView, maxBytes: number): ArtifactText {
  const decoder = new TextDecoder('utf-8');
  let text = '';
  let bytesHeld = 0;
  for (const [index, page] of artifact.pages.entries()) {
    const bytes = decodeBase64ToBytes(page.dataBase64);
    const last = index === artifact.pages.length - 1;
    // Stream every page but the last: the boundary may be mid-character.
    text += decoder.decode(bytes, { stream: !last });
    bytesHeld += bytes.length;
    if (bytesHeld >= maxBytes) break;
  }
  return {
    text: bytesHeld >= maxBytes ? text : text + decoder.decode(),
    bytesHeld,
    clipped: bytesHeld >= maxBytes || !artifact.eof,
  };
}

export interface FileContentView {
  kind: 'text' | 'binary';
  text: string;
  byteLength: number;
  offset: number;
  totalBytes: number;
  mediaType: string | null;
  /** Offset of the next page, or null when the whole file is held. */
  nextOffset: number | null;
}

export function describeFileContent(content: CompanyFileContent): FileContentView {
  return {
    byteLength: lengthOf(content),
    kind: content.encoding === 'utf8' ? 'text' : 'binary',
    text: content.encoding === 'utf8' ? (content.text ?? '') : '',
    offset: content.offset,
    totalBytes: content.totalBytes,
    mediaType: content.mediaType ?? null,
    nextOffset: content.truncated ? content.offset + lengthOf(content) : null,
  };
}

function lengthOf(content: CompanyFileContent): number {
  if (content.encoding === 'utf8') return new TextEncoder().encode(content.text ?? '').length;
  return decodeBase64ToBytes(content.dataBase64 ?? '').length;
}

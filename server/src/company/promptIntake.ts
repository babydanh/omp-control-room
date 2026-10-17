import { randomUUID } from 'node:crypto';

import type { CompanyPrompt } from '../../../core/src/company.js';

const LIST_ITEM = /^[\t ]*(?:\d+[.)]|[-*+])[\t ]+\S/u;
const FENCE = /^[\t ]*(`{3,}|~{3,})/u;

/**
 * Split raw prompt text at paragraph and list-item boundaries without
 * normalizing or dropping any source characters. Offsets use JavaScript's
 * UTF-16 indexing because consumers recover fragment text with String.slice.
 */
export function fragmentPrompt(text: string): NonNullable<CompanyPrompt['fragments']> {
  const starts = new Set<number>([0, text.length]);
  let fence: { marker: '`' | '~'; length: number } | undefined;
  let previousLineBlank = false;
  let lineStart = 0;

  while (lineStart < text.length) {
    const newline = text.indexOf('\n', lineStart);
    const lineEnd = newline === -1 ? text.length : newline;
    const line = text.slice(lineStart, lineEnd).replace(/\r$/u, '');
    const fenceMatch = FENCE.exec(line);

    if (fence) {
      if (fenceMatch?.[1]?.[0] === fence.marker && fenceMatch[1].length >= fence.length) {
        fence = undefined;
      }
    } else if (fenceMatch?.[1]) {
      fence = { marker: fenceMatch[1][0] as '`' | '~', length: fenceMatch[1].length };
    } else if (lineStart > 0 && (LIST_ITEM.test(line) || (previousLineBlank && line.trim()))) {
      starts.add(lineStart);
    }

    previousLineBlank = line.trim().length === 0;
    lineStart = newline === -1 ? text.length : newline + 1;
  }

  const boundaries = [...starts].sort((left, right) => left - right);
  const fragments: NonNullable<CompanyPrompt['fragments']> = [];
  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const start = boundaries[index];
    const end = boundaries[index + 1];
    if (start === undefined || end === undefined || start === end) continue;
    fragments.push({ id: randomUUID(), start, end, ordinal: fragments.length });
  }
  return fragments;
}

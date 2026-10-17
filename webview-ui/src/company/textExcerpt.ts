/**
 * Text excerpting for bubbles and previews.
 *
 * A bubble shows what an assistant SAID, bounded. It is not a transcript, it is
 * not parsed out of terminal output, and it is measured in graphemes so an
 * emoji or a combining accent never gets cut in half by the limit.
 */

const graphemeSegmenter =
  typeof Intl !== 'undefined' && 'Segmenter' in Intl
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : null;

/** The last `count` graphemes of `text`, or the whole string when shorter. */
export function lastGraphemes(text: string, count: number): string {
  if (text.length === 0 || count <= 0) return '';
  if (graphemeSegmenter) {
    const graphemes: string[] = [];
    for (const { segment } of graphemeSegmenter.segment(text)) graphemes.push(segment);
    return graphemes.length <= count ? text : graphemes.slice(-count).join('');
  }
  // Code points are the best available approximation when Segmenter is absent.
  const codePoints = Array.from(text);
  return codePoints.length <= count ? text : codePoints.slice(-count).join('');
}

/** Collapse a captured tail into a single-line bubble excerpt. */
export function excerptLine(text: string, count: number): string {
  return lastGraphemes(text.replace(/\s+/g, ' ').trim(), count);
}

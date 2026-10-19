/**
 * useParsedScreen: the parsed rows of a screen's text. A read that changed a few rows parses only
 * those rows; the rest keep the segments they had, so their memoised rows skip re-rendering.
 */

import { useMemo, useRef } from 'react';

import { parseAnsiScreenCached, type ScreenLine, type ScreenParseCache } from './terminalScreen.js';

export function useParsedScreen(text: string): readonly ScreenLine[] {
  const previous = useRef<ScreenParseCache | null>(null);
  return useMemo(() => {
    const parsed = parseAnsiScreenCached(text, previous.current);
    previous.current = parsed.cache;
    return parsed.lines;
  }, [text]);
}

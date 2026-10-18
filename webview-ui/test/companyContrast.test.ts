import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  CONTRAST_GRAPHIC_MIN,
  CONTRAST_TEXT_MIN,
  contrastRatio,
  mixColours,
  parseHex,
  relativeLuminance,
  type Rgb,
} from '../src/company/contrast.js';

// The board's colours are read from the stylesheet itself, so the test tracks the real tokens.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const css = readFileSync(path.join(root, 'src/index.css'), 'utf8');

/** Every `--color-*` token in the `.company-ui` block, keyed by its name without `--`. */
function boardTokens(): Map<string, Rgb> {
  const block = /\.company-ui \{([^}]*)\}/.exec(css)?.[1] ?? '';
  const entries = Array.from(
    block.matchAll(/--(color-[\w-]+):\s*(#[0-9a-f]{6});/gi),
    (match): [string, Rgb] => [match[1] ?? '', parseHex(match[2] ?? '')],
  );
  return new Map(entries);
}

/** Each lane's fill colour, keyed by lane id. */
function laneColours(): Map<string, Rgb> {
  const entries = Array.from(
    css.matchAll(/\.company-lane\[data-lane='([\w-]+)'\] \{\s*--lane-color:\s*(#[0-9a-f]{6});/gi),
    (match): [string, Rgb] => [match[1] ?? '', parseHex(match[2] ?? '')],
  );
  return new Map(entries);
}

interface Pair {
  label: string;
  foreground: Rgb;
  background: Rgb;
  minimum: number;
}

const tokens = boardTokens();

function token(name: string): Rgb {
  const value = tokens.get(`color-${name}`);
  if (value === undefined) throw new Error(`Missing board token --color-${name}`);
  return value;
}

/** Every foreground against every background, each pair held to the same minimum. */
function crossPairs(
  foregrounds: readonly string[],
  backgrounds: readonly string[],
  minimum: number,
): Pair[] {
  return foregrounds.flatMap((foreground) =>
    backgrounds.map((background) => ({
      label: `${foreground} on ${background}`,
      foreground: token(foreground),
      background: token(background),
      minimum,
    })),
  );
}

/** Pairs that fall short, as readable messages. An empty list means the board passes. */
function shortfalls(pairs: readonly Pair[]): string[] {
  return pairs.flatMap(({ label, foreground, background, minimum }) => {
    const ratio = contrastRatio(foreground, background);
    return ratio >= minimum ? [] : [`${label}: ${ratio.toFixed(2)}:1, needs ${minimum}:1`];
  });
}

const SURFACES = ['bg', 'panel', 'raised', 'hover', 'selected', 'well'];

// Every colour the board sets as text, on every surface the text can sit on.
const TEXT_COLOURS = [
  'text',
  'text-secondary',
  'text-muted',
  'accent',
  'accent-bright',
  'warning',
  'danger',
  'idle',
  'status-active',
  'status-success',
  'status-permission',
  'orchid',
];

// Focus rings, selection marks and scrollbar thumbs, on the surfaces they sit on.
const EDGE_COLOURS = ['border', 'accent'];
const EDGE_SURFACES = ['bg', 'panel', 'raised', 'well'];

// Status dots, role marks and lane colours drawn on the page surfaces.
const MARK_COLOURS = [
  'idle',
  'status-active',
  'status-success',
  'status-permission',
  'accent-bright',
  'warning',
  'danger',
  'orchid',
  'text-muted',
];
const PAGE_SURFACES = ['bg', 'panel', 'raised'];

// A hairline is decorative: it marks a seam between same-tone surfaces, so it only has to be seen.
const HAIRLINE_MIN = 1.2;

describe('board contrast tokens', () => {
  it('reads the board tokens and lane colours from the stylesheet', () => {
    expect(tokens.size).toBeGreaterThan(20);
    expect(laneColours().size).toBe(7);
  });

  it('keeps every board text colour at 4.5:1 or better on every surface', () => {
    const pairs = crossPairs(TEXT_COLOURS, SURFACES, CONTRAST_TEXT_MIN);
    expect(shortfalls(pairs)).toEqual([]);
  });

  it('keeps focus rings and scrollbar thumbs at 3:1 or better on their surfaces', () => {
    const pairs = crossPairs(EDGE_COLOURS, EDGE_SURFACES, CONTRAST_GRAPHIC_MIN);
    expect(shortfalls(pairs)).toEqual([]);
  });

  it('keeps the prompt field edge at 3:1 or better on the page surfaces', () => {
    // The field outlines itself with the border token. The hairline cannot do this: it is a
    // seam and sits near 1.3:1 on the canvas.
    const composer = readFileSync(
      path.join(root, 'src/company/components/PromptComposer.tsx'),
      'utf8',
    );
    const field = composer.match(/<textarea[\s\S]*?\/>/)?.[0] ?? '';
    expect(field).toMatch(/\bborder border-border\b/);
    expect(shortfalls(crossPairs(['border'], PAGE_SURFACES, CONTRAST_GRAPHIC_MIN))).toEqual([]);
  });

  it('keeps status marks and lane colours at 3:1 or better on the page surfaces', () => {
    const marks = crossPairs(MARK_COLOURS, PAGE_SURFACES, CONTRAST_GRAPHIC_MIN);
    const laneMarks = Array.from(laneColours()).flatMap(([id, colour]) =>
      PAGE_SURFACES.map((surface) => ({
        label: `lane ${id} on ${surface}`,
        foreground: colour,
        background: token(surface),
        minimum: CONTRAST_GRAPHIC_MIN,
      })),
    );
    expect(shortfalls([...marks, ...laneMarks])).toEqual([]);
  });

  it('keeps the hairline visible as a seam between same-tone surfaces', () => {
    expect(shortfalls(crossPairs(['hairline'], ['bg', 'panel'], HAIRLINE_MIN))).toEqual([]);
  });

  it('steps the surfaces up in tone from the well to the hover fill', () => {
    const order = ['well', 'bg', 'panel', 'raised', 'hover'];
    for (let index = 1; index < order.length; index++) {
      const lower = order[index - 1] ?? '';
      const upper = order[index] ?? '';
      expect(relativeLuminance(token(upper)), `${upper} above ${lower}`).toBeGreaterThan(
        relativeLuminance(token(lower)),
      );
    }
  });

  it('declares the three corner radii the board uses: 6, 10 and 14 pixels', () => {
    const radii = Array.from(css.matchAll(/--company-radius-(sm|md|lg): (\d+)px;/g), (match) => [
      match[1],
      Number(match[2]),
    ]);
    expect(radii).toEqual([
      ['sm', 6],
      ['md', 10],
      ['lg', 14],
    ]);
  });
});

describe('contrast helpers', () => {
  it('gives 21:1 for black on white and 1:1 for a colour on itself', () => {
    const white: Rgb = [255, 255, 255];
    const black: Rgb = [0, 0, 0];
    const grey: Rgb = [141, 139, 147];
    expect(contrastRatio(white, black)).toBeCloseTo(21, 5);
    expect(contrastRatio(grey, grey)).toBeCloseTo(1, 5);
  });

  it('rejects a value that is not a six-digit hex colour', () => {
    expect(() => parseHex('')).toThrow();
    expect(() => parseHex('#gggggg')).toThrow();
    expect(() => parseHex('not a colour')).toThrow();
  });

  it('mixes two colours at the given weight, as color-mix does in srgb', () => {
    const white: Rgb = [255, 255, 255];
    const black: Rgb = [0, 0, 0];
    expect(mixColours(white, black, 0)).toEqual([0, 0, 0]);
    expect(mixColours(white, black, 1)).toEqual([255, 255, 255]);
    expect(mixColours(white, black, 0.5)).toEqual([128, 128, 128]);
  });
});

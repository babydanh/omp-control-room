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

/** The share of the lane colour the lane head's fill mixes in, read from the stylesheet. */
function laneHeadMixPercent(): number {
  const match = /\.company-lane-head \{[^}]*?color-mix\(in srgb, var\(--lane-color\) (\d+)%/.exec(
    css,
  );
  return Number(match?.[1] ?? Number.NaN);
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

const SURFACES = ['bg', 'bg-dark', 'lane', 'card', 'btn-bg', 'btn-hover', 'active-bg'];

// Every colour the board sets as text, on every surface the text can sit on.
const TEXT_COLOURS = [
  'text',
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

// Borders and focus rings on the surfaces they outline: a control's fill and the page beneath.
const EDGE_COLOURS = ['border', 'card-line', 'card-hover', 'accent'];
const EDGE_SURFACES = ['bg', 'bg-dark', 'lane', 'card', 'btn-bg'];

// Status dots and marks drawn on the page surfaces.
const MARK_COLOURS = [
  'idle',
  'status-active',
  'status-success',
  'status-permission',
  'warning',
  'danger',
  'orchid',
];
const PAGE_SURFACES = ['bg', 'bg-dark', 'lane', 'card'];

describe('board contrast tokens', () => {
  it('reads the board tokens and lane colours from the stylesheet', () => {
    expect(tokens.size).toBeGreaterThan(20);
    expect(laneColours().size).toBe(7);
    expect(laneHeadMixPercent()).toBeGreaterThan(0);
  });

  it('keeps every board text colour at 4.5:1 or better on every surface', () => {
    const pairs = crossPairs(TEXT_COLOURS, SURFACES, CONTRAST_TEXT_MIN);
    expect(shortfalls(pairs)).toEqual([]);
  });

  it('keeps borders and focus rings at 3:1 or better against their surfaces', () => {
    const pairs = crossPairs(EDGE_COLOURS, EDGE_SURFACES, CONTRAST_GRAPHIC_MIN);
    expect(shortfalls(pairs)).toEqual([]);
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

  it('keeps each lane heading and owner line at 4.5:1 on the tinted lane head', () => {
    const percent = laneHeadMixPercent() / 100;
    const heads = Array.from(laneColours()).flatMap(([id, colour]) => {
      const head = mixColours(colour, token('lane'), percent);
      return ['text', 'text-muted', 'status-active'].map((foreground) => ({
        label: `lane ${id} head: ${foreground}`,
        foreground: token(foreground),
        background: head,
        minimum: CONTRAST_TEXT_MIN,
      }));
    });
    expect(shortfalls(heads)).toEqual([]);
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

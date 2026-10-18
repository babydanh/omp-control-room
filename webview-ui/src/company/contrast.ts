/**
 * WCAG 2.x contrast for the board's colour tokens. Pure: the token test reads the
 * stylesheet and feeds hex pairs here, so no DOM or colour engine is involved.
 */

/** An sRGB colour: red, green and blue, each 0–255. */
export type Rgb = readonly [number, number, number];

/** The least contrast body text may have on the board. */
export const CONTRAST_TEXT_MIN = 4.5;

/** The least contrast large text, UI borders, icons and focus rings may have. */
export const CONTRAST_GRAPHIC_MIN = 3;

const HEX_COLOUR = /^#([0-9a-f]{6})$/i;

/** Reads `#rrggbb`. Anything else throws, so a malformed token fails the test loudly. */
export function parseHex(hex: string): Rgb {
  const match = HEX_COLOUR.exec(hex);
  if (match === null) throw new Error(`Not a #rrggbb colour: ${hex}`);
  const value = Number.parseInt(match[1] ?? '', 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

/** Linearises one sRGB channel (0–255) with the WCAG 2.x transfer function. */
function linearChannel(channel: number): number {
  const scaled = channel / 255;
  return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
}

/** Relative luminance: 0 for black, 1 for white. */
export function relativeLuminance([red, green, blue]: Rgb): number {
  return 0.2126 * linearChannel(red) + 0.7152 * linearChannel(green) + 0.0722 * linearChannel(blue);
}

/** The contrast ratio of two colours: 1 when identical, 21 for black on white. */
export function contrastRatio(first: Rgb, second: Rgb): number {
  const a = relativeLuminance(first);
  const b = relativeLuminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/**
 * `colour` mixed into `base` at `weight` (0–1) in sRGB, as CSS
 * `color-mix(in srgb, colour weight%, base)` does.
 */
export function mixColours(colour: Rgb, base: Rgb, weight: number): Rgb {
  const channel = (index: 0 | 1 | 2) =>
    Math.round(colour[index] * weight + base[index] * (1 - weight));
  return [channel(0), channel(1), channel(2)];
}

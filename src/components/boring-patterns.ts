/**
 * Body textures for the mascot, ported from Boring Avatars.
 *
 * The pixel grid is Boring Avatars' own generator, so this file is a derivative
 * work. Boring Avatars is MIT licensed:
 *
 *   Copyright (c) 2021 Josep Martins and contributors
 *
 *   Permission is hereby granted, free of charge, to any person obtaining a copy
 *   of this software and associated documentation files (the "Software"), to deal
 *   in the Software without restriction, including without limitation the rights
 *   to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 *   copies of the Software, and to permit persons to whom the Software is
 *   furnished to do so, subject to the following conditions:
 *
 *   The above copyright notice and this permission notice shall be included in all
 *   copies or substantial portions of the Software.
 *
 *   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 *   IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 *   FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 *   AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 *   LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 *   OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 *   SOFTWARE.
 *
 * Changes from upstream:
 *   - Only the `pixel` variant is ported. It reads as a body texture at small
 *     sizes, has no blur filter to repaint, and needs no face of its own.
 *   - Output is inner SVG markup in the variant's own square coordinate space,
 *     not a full <svg>; the mascot renderer clips and places it in a body.
 *   - Every emitted number comes from the integer hash, so output is stable
 *     across renders and safe to snapshot.
 */

export const BORING_VARIANTS = ["pixel"] as const;
export type BoringVariant = (typeof BORING_VARIANTS)[number];

export const DEFAULT_BORING_VARIANT: BoringVariant = "pixel";

/* ------------------------------------------------------------- utilities */

/** Port of Boring Avatars' string hash. Same seed, same avatar, every run. */
export function hashCode(name: string): number {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    const character = name.charCodeAt(i);
    hash = (hash << 5) - hash + character;
    hash = hash & hash;
  }
  return Math.abs(hash);
}

function getRandomColor(number: number, colors: string[], range: number): string {
  return colors[number % range];
}

/* ---------------------------------------------------------------- palette */

type Rgb = [number, number, number];

function hexToRgb(hex: string): Rgb {
  const clean = hex.replace("#", "");
  const full =
    clean.length === 3
      ? clean
          .split("")
          .map((c) => c + c)
          .join("")
      : clean;
  return [
    Number.parseInt(full.slice(0, 2), 16),
    Number.parseInt(full.slice(2, 4), 16),
    Number.parseInt(full.slice(4, 6), 16),
  ];
}

function rgbToHsl([r, g, b]: Rgb): [number, number, number] {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0);
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  return [h * 60, s, l];
}

function hslToHex(h: number, s: number, l: number): string {
  const hue = ((h % 360) + 360) % 360;
  const sat = Math.min(1, Math.max(0, s));
  const lig = Math.min(1, Math.max(0, l));
  const c = (1 - Math.abs(2 * lig - 1)) * sat;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = lig - c / 2;
  const [r, g, b] =
    hue < 60
      ? [c, x, 0]
      : hue < 120
        ? [x, c, 0]
        : hue < 180
          ? [0, c, x]
          : hue < 240
            ? [0, x, c]
            : hue < 300
              ? [x, 0, c]
              : [c, 0, x];
  const toHex = (v: number) =>
    Math.round((v + m) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

/**
 * A five-stop palette derived from the bot's own color.
 *
 * The mascot gradient is a single hue, which makes the grid read as one flat
 * color. Two accents rotated off the base hue give the cells separation while
 * keeping the bot recognisably its own color.
 */
export function paletteFor(baseColor: string): string[] {
  const [h, s, l] = rgbToHsl(hexToRgb(baseColor));
  const sat = Math.max(0.28, s);
  return [
    hslToHex(h + 12, sat * 0.85, Math.min(0.82, l + 0.22)),
    hslToHex(h, sat, l),
    hslToHex(h - 10, sat, Math.max(0.24, l - 0.18)),
    hslToHex(h + 38, sat * 0.95, Math.min(0.78, l + 0.08)),
    hslToHex(h - 34, sat * 0.9, Math.max(0.3, l - 0.05)),
  ];
}

/* ------------------------------------------------------------ seed / pick */

/** Stable seed for a bot: id when present, else name, else a constant. */
export function boringSeed(bot: { id?: string | null; name?: string | null }): string {
  return bot.id?.trim() || bot.name?.trim() || "bot";
}

/** Only one variant ships, so the choice is a constant, not a hash. */
export function boringVariantFor(_seed: string): BoringVariant {
  return DEFAULT_BORING_VARIANT;
}

/* --------------------------------------------------------------- markup */

export interface BoringPattern {
  /** Side length of the square coordinate space `markup` is authored in. */
  size: number;
  /** Inner SVG markup; the caller supplies the <g>, clip, and paint opacity. */
  markup: string;
}

interface PatternInput {
  seed: string;
  colors: string[];
  variant: BoringVariant;
}

/** The eight-by-eight grid, one color per cell, seeded by the bot. */
const PIXEL_CELLS: Array<[number, number]> = [
  [0, 0], [20, 0], [40, 0], [60, 0],
  [10, 0], [30, 0], [50, 0], [70, 0],
  [0, 10], [0, 20], [0, 30], [0, 40], [0, 50], [0, 60], [0, 70],
  [20, 10], [20, 20], [20, 30], [20, 40], [20, 50], [20, 60], [20, 70],
  [40, 10], [40, 20], [40, 30], [40, 40], [40, 50], [40, 60], [40, 70],
  [60, 10], [60, 20], [60, 30], [60, 40], [60, 50], [60, 60], [60, 70],
  [10, 10], [10, 20], [10, 30], [10, 40], [10, 50], [10, 60], [10, 70],
  [30, 10], [30, 20], [30, 30], [30, 40], [30, 50], [30, 60], [30, 70],
  [50, 10], [50, 20], [50, 30], [50, 40], [50, 50], [50, 60], [50, 70],
  [70, 10], [70, 20], [70, 30], [70, 40], [70, 50], [70, 60], [70, 70],
];

function pixel({ seed, colors }: PatternInput): BoringPattern {
  const SIZE = 80;
  const numFromName = hashCode(seed);
  const range = colors.length;
  const markup = PIXEL_CELLS.map(([x, y], i) => {
    const color = getRandomColor(numFromName % (i + 1), colors, range);
    return `<rect x="${x}" y="${y}" width="10" height="10" fill="${color}"/>`;
  }).join("");
  return { size: SIZE, markup };
}

/** Deterministic body pattern markup for a bot. */
export function boringPattern(input: PatternInput): BoringPattern {
  return pixel(input);
}

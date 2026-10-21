import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// WCAG AA check for the token pairs the design system uses, in both themes.
// Add a pair here whenever a component puts one token's text on another's surface.
const css = readFileSync(new URL('../src/styles/tokens.css', import.meta.url), 'utf8');

function block(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`no ${selector} block`);
  const body = css.slice(start, css.indexOf('\n}', start));
  const vars: Record<string, string> = {};
  for (const m of body.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)) vars[m[1]!] = m[2]!.trim();
  return vars;
}

const light = block(':root');
const dark = { ...light, ...block('html[data-theme="dark"]') };

function resolveColor(vars: Record<string, string>, name: string, depth = 0): string {
  const value = vars[name];
  if (!value) throw new Error(`token --${name} missing`);
  const ref = /^var\(--([a-z0-9-]+)\)$/.exec(value);
  if (ref) {
    if (depth > 5) throw new Error(`token loop at --${name}`);
    return resolveColor(vars, ref[1]!, depth + 1);
  }
  if (!/^#[0-9a-f]{6}$/i.test(value)) throw new Error(`--${name} is not a #rrggbb colour: ${value}`);
  return value;
}

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const [r, g, b] = channels.map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

// [foreground, background, minimum ratio]
const TEXT = 4.5;
const UI = 3;
const PAIRS: Array<[string, string, number]> = [
  ...['bg', 'paper', 'card'].flatMap((bg): Array<[string, string, number]> => [
    ['text', bg, TEXT],
    ['ink', bg, TEXT],
    ['text-soft', bg, TEXT],
    ['muted', bg, TEXT],
    ['leaf', bg, TEXT],
    ['link-hover', bg, TEXT],
    ['focus', bg, UI],
  ]),
  ...['sage', 'sky', 'flesh-tint', 'butter', 'line'].flatMap((bg): Array<[string, string, number]> => [
    ['text', bg, TEXT],
    ['text-soft', bg, TEXT],
    ['muted', bg, TEXT],
    ['leaf', bg, TEXT],
  ]),
  ['on-brown', 'brown', TEXT],
  ['leaf-strong', 'leaf-tint', TEXT],
  ['leaf-tint', 'leaf-strong', TEXT],
  ['leaf-strong', 'card', TEXT],
  // blog account line notices sit on the post's end card
  ['ink', 'flesh-tint', TEXT],
  // the blog's email field: a brown outline on paper, inside the hero or the flesh-tint end card
  ['brown', 'paper', UI],
  ['brown', 'flesh-tint', UI],
  // the header's wordmark, in its little sky
  ['brown-on-sky', 'sky', TEXT],
  ['on-sun', 'sun', TEXT],
  ['on-sun-soft', 'sun', TEXT],
  ['on-sun', 'sun-deep', TEXT],
  ['on-soil', 'soil', TEXT],
  ['on-soil-soft', 'soil', TEXT],
  ['focus-on-dark', 'soil', UI],
  ['on-footer', 'footer', TEXT],
  ['on-footer-soft', 'footer', TEXT],
  ['footer-heading', 'footer', TEXT],
  ['footer-quiet', 'footer', TEXT],
  ['focus-on-dark', 'footer', UI],
  ['sun', 'footer', UI],
  ['text', 'selection', TEXT],
  // the weather report's bars, on the sky tile and on cards
  ...['sky', 'card', 'paper', 'bg'].flatMap((bg): Array<[string, string, number]> => [
    ['weather-bsky', bg, UI],
    ['weather-else', bg, UI],
  ]),
  // the forecast's chance of a storm, on its cream strip
  ['on-water-tint', 'bg', TEXT],
];

describe.each([
  ['light', light],
  ['dark', dark],
] as const)('%s theme contrast', (_name, vars) => {
  it.each(PAIRS)('--%s on --%s >= %d:1', (fg, bg, min) => {
    const ratio = contrast(resolveColor(vars, fg), resolveColor(vars, bg));
    expect(ratio, `${fg} on ${bg} = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(min);
  });
});

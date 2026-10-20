import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// WCAG AA for the colour pairs the widget uses, in both themes, plus a few CSS
// contracts (reduced motion, phone breakpoint matching ui.ts).
const root = process.cwd();
const tokens = readFileSync(join(root, 'src/styles/tokens.css'), 'utf8');
const poe = readFileSync(join(root, 'src/styles/poe.css'), 'utf8');

function block(css: string, selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`no ${selector} block`);
  const body = css.slice(start, css.indexOf('\n}', start));
  const vars: Record<string, string> = {};
  for (const m of body.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)) vars[m[1]!] = m[2]!.trim();
  return vars;
}

const light = { ...block(tokens, ':root'), ...block(poe, ':root') };
const dark = { ...light, ...block(tokens, 'html[data-theme="dark"]'), ...block(poe, 'html[data-theme="dark"]') };

function resolve(vars: Record<string, string>, name: string, depth = 0): string {
  const value = vars[name];
  if (!value) throw new Error(`--${name} missing`);
  const ref = /^var\(--([a-z0-9-]+)\)$/.exec(value);
  if (ref) return resolve(vars, ref[1]!, depth + 1);
  if (!/^#[0-9a-f]{6}$/i.test(value)) throw new Error(`--${name} is not #rrggbb: ${value}`);
  return value;
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

// [text, surface, minimum] as used in poe.css
const PAIRS: Array<[string, string, number]> = [
  ['text', 'card', 4.5], // panel, nudge
  ['muted', 'card', 4.5], // subtitle, footnote
  ['text-soft', 'card', 4.5], // chips, text buttons
  ['text-soft', 'bg', 4.5], // context chip
  ['text', 'flesh-tint', 4.5], // poe bubbles
  ['link', 'flesh-tint', 4.5], // answer links
  ['muted', 'flesh-tint', 4.5], // grey non-clickable URLs
  ['text-soft', 'flesh-tint', 4.5], // status line
  ['text', 'bg', 4.5], // note bubbles, code
  ['link', 'bg', 4.5], // link in a note bubble
  ['on-brown', 'brown', 4.5], // your bubbles, send button
  ['poe-quote', 'brown', 4.5], // quoted selection in your bubble
  ['on-soil', 'soil', 4.5], // "ask poe" label, highlight pill
  ['text', 'paper', 4.5], // input text
  ['muted', 'paper', 4.5], // input placeholder
  ['focus', 'card', 3], // focus ring inside the panel
  ['focus', 'bg', 3], // focus ring on the page
  ['focus', 'flesh-tint', 3], // focus ring on a link in a bubble
];

describe('poe colours meet WCAG AA', () => {
  for (const [theme, vars] of [['light', light], ['dark', dark]] as const) {
    for (const [fg, bg, min] of PAIRS) {
      it(`${theme}: --${fg} on --${bg} >= ${min}`, () => {
        expect(contrast(resolve(vars, fg), resolve(vars, bg))).toBeGreaterThanOrEqual(min);
      });
    }
  }
});

describe('poe.css contracts', () => {
  it('uses the same phone breakpoint as ui.ts', async () => {
    const { PHONE_QUERY } = await import('../src/poe/ui.js');
    expect(PHONE_QUERY).toBe('(max-width: 639.98px)');
    expect(poe).toContain('@media (max-width: 639.98px)');
  });

  it('turns off rising, sliding and bouncing under reduced motion', () => {
    const start = poe.indexOf('@media (prefers-reduced-motion: reduce)');
    expect(start).toBeGreaterThan(0);
    const section = poe.slice(start, poe.indexOf('/* ---------- forced colors', start));
    expect(section).toMatch(/transition: none !important/);
    expect(section).toMatch(/transform: none !important/);
    expect(section).toMatch(/animation: none !important/);
    for (const sel of ['.poe-potato:hover', '.poe-panel', '.poe-dots i', '.poe[data-busy] .poe-panel__potato', '.poe-potato__arm', '.poe-potato__img', '.poe-potato__zzz i']) expect(section).toContain(sel);
  });

  it('waves for as long as idle.ts holds the wave face', async () => {
    const { WAVE_MS } = await import('../src/poe/idle.js');
    const duration = /animation:\s*poe-wave\s+([\d.]+)s/.exec(poe)?.[1];
    expect(Number(duration) * 1000).toBe(WAVE_MS);
  });

  it('startles for as long as idle.ts holds the wow face', async () => {
    const { WAKE_MS } = await import('../src/poe/idle.js');
    const duration = /animation:\s*poe-startle\s+([\d.]+)s/.exec(poe)?.[1];
    expect(Number(duration) * 1000).toBe(WAKE_MS);
  });

  it('cheers for as long as idle.ts holds the happy face', async () => {
    const { CHEER_MS } = await import('../src/poe/idle.js');
    const duration = /animation:\s*poe-cheer\s+([\d.]+)s/.exec(poe)?.[1];
    expect(Number(duration) * 1000).toBe(CHEER_MS);
  });

  it('stacks on the shared z-index token', () => {
    expect(poe).toContain('z-index: var(--z-poe)');
    expect(poe).not.toMatch(/z-index:\s*\d{3,}/);
  });
});

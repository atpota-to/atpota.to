/**
 * Renders the Open Graph cards (scripts/og-cards.html) to 1200x630 PNGs, one per card.
 * The cards take their copy from the pages as the dev server serves them (og-cards.ts),
 * and use the site's tokens, mascot SVGs and Eigerdals through the Adobe Fonts kit (which
 * serves localhost), so they are screenshotted in a real browser.
 *
 *   npm run og                         render every card into public/og (the committed copies)
 *   npm run og -- home blog            only these
 *   npm run og -- --out dist/og --soft what the Vercel build runs (vercel.json): render into
 *                                      the build, and on any failure warn and keep the
 *                                      committed copies the build already holds
 *
 * Needs a Chromium for Playwright: `npx playwright install chromium-headless-shell` once.
 * On Vercel, scripts/og-browser.sh installs it and its system libraries.
 */

import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Browser } from 'playwright';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import type { CardStatus } from './og-cards.js';

export const OG_DIR = 'public/og';
export const OG_WIDTH = 1200;
export const OG_HEIGHT = 630;
const CARDS_PATH = '/scripts/og-cards.html';
const READY_TIMEOUT_MS = 60_000;

export interface OgArgs {
  out: string;
  soft: boolean;
  only: Set<string>;
}

export function parseArgs(args: string[]): OgArgs {
  const parsed: OgArgs = { out: OG_DIR, soft: false, only: new Set() };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--soft') parsed.soft = true;
    else if (arg === '--out') parsed.out = args[++i] ?? OG_DIR;
    else parsed.only.add(arg);
  }
  return parsed;
}

export async function main(args: string[]): Promise<number> {
  const opts = parseArgs(args);
  const root = process.cwd();
  const problems: string[] = [];

  const server = await createServer({ root, configFile: resolve(root, 'vite.config.ts'), logLevel: 'error' });
  let browser: Browser | undefined;
  try {
    await server.listen();
    const base = server.resolvedUrls?.local[0]?.replace(/\/$/, '');
    if (!base) throw new Error('the Vite server did not report a local URL');
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: OG_WIDTH + 80, height: OG_HEIGHT + 80 }, deviceScaleFactor: 1 });
    await page.goto(`${base}${CARDS_PATH}`);
    await page.waitForSelector('html[data-og-status]', { state: 'attached', timeout: READY_TIMEOUT_MS });
    const status = JSON.parse((await page.getAttribute('html', 'data-og-status')) ?? '[]') as CardStatus[];

    // fonts.check() is true for a family that was never declared, so look for loaded faces.
    const fontReady = await page.evaluate(() => {
      const loaded = [...document.fonts].filter((f) => f.family.replace(/"/g, '') === 'eigerdals' && f.status === 'loaded');
      return ['400', '700'].every((weight) => loaded.some((f) => f.weight === weight));
    });
    if (!fontReady) throw new Error("Eigerdals didn't load (the Adobe Fonts kit only serves the domains it allows)");

    mkdirSync(resolve(root, opts.out), { recursive: true });
    let written = 0;
    for (const card of status) {
      if (opts.only.size && card.name !== '*' && !opts.only.has(card.name)) continue;
      if (card.error) {
        problems.push(`${card.name}: ${card.error}`);
        continue;
      }
      if (!card.fits) {
        problems.push(`${card.name}: the text doesn't fit the card, even at the smallest size`);
        continue;
      }
      const section = page.locator(`[data-og="${card.name}"]`);
      const box = await section.boundingBox();
      if (box?.width !== OG_WIDTH || box.height !== OG_HEIGHT) {
        problems.push(`${card.name}: the card is ${box?.width}x${box?.height}, not ${OG_WIDTH}x${OG_HEIGHT}`);
        continue;
      }
      const file = `${opts.out}/${card.name}.png`;
      await section.screenshot({ path: resolve(root, file), animations: 'disabled' });
      console.log(`og: wrote ${file}`);
      written++;
    }
    if (!written && !problems.length) {
      problems.push(opts.only.size ? `no cards named ${[...opts.only].join(', ')}` : 'no cards to render');
    }
  } catch (err) {
    problems.push(err instanceof Error ? err.message : String(err));
  } finally {
    await browser?.close();
    await server.close();
  }

  if (!problems.length) return 0;
  for (const p of problems) console.warn(`og: ${p}`);
  if (!opts.soft) return 1;
  console.warn(`og: kept the committed copies (public/og) of anything not written above`);
  return 0;
}

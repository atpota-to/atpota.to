/**
 * Renders the Open Graph images in public/og/ from scripts/og-cards.html: one 1200x630
 * PNG per [data-og] card, named after it. The cards use the site's own tokens, mascot SVGs
 * and Eigerdals through the Adobe Fonts kit (which serves localhost), so they are
 * screenshotted in a real browser rather than drawn from a font file.
 *
 *   npm run og                 render every card
 *   npm run og -- home blog    render only these
 *
 * Needs Playwright and a Chromium for it, which the site itself does not depend on:
 *   npm install --no-save playwright && npx playwright install chromium
 *
 * To preview while editing, run `npm run dev` and open /scripts/og-cards.html.
 */

import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { createServer } from 'vite';

export const OG_DIR = 'public/og';
export const OG_WIDTH = 1200;
export const OG_HEIGHT = 630;
const CARDS_PATH = '/scripts/og-cards.html';

// The slice of Playwright used here, typed by hand so the site needs no types for it.
interface Card {
  getAttribute(name: string): Promise<string | null>;
  boundingBox(): Promise<{ width: number; height: number } | null>;
  screenshot(options: { path: string; animations?: 'disabled' }): Promise<unknown>;
}
interface Page {
  goto(url: string, options: { waitUntil: 'networkidle' }): Promise<unknown>;
  evaluate<T>(fn: () => T | Promise<T>): Promise<T>;
  locator(selector: string): { all(): Promise<Card[]> };
}
interface Browser {
  newPage(options: object): Promise<Page>;
  close(): Promise<void>;
}
interface Playwright {
  chromium: { launch(): Promise<Browser> };
}

// Node's require, not import(): scripts/run.mjs closes Vite's module runner once this
// module has loaded, so a dynamic import inside main() would fail.
function loadPlaywright(): Playwright | null {
  try {
    return createRequire(import.meta.url)('playwright') as Playwright;
  } catch {
    return null;
  }
}

export async function main(args: string[]): Promise<number> {
  const root = process.cwd();
  const only = new Set(args);
  const pw = loadPlaywright();
  if (!pw) {
    console.error('needs playwright: npm install --no-save playwright && npx playwright install chromium');
    return 1;
  }

  const server = await createServer({ root, configFile: false, logLevel: 'error' });
  let browser: Browser | undefined;
  try {
    await server.listen();
    const base = server.resolvedUrls?.local[0]?.replace(/\/$/, '');
    if (!base) throw new Error('the Vite server did not report a local URL');
    browser = await pw.chromium.launch();
    const page = await browser.newPage({ viewport: { width: OG_WIDTH + 80, height: OG_HEIGHT + 80 }, deviceScaleFactor: 1 });
    await page.goto(`${base}${CARDS_PATH}`, { waitUntil: 'networkidle' });
    // fonts.check() is true for a family that was never declared, so look for loaded faces.
    const fontReady = await page.evaluate(async () => {
      await document.fonts.ready;
      const loaded = [...document.fonts].filter((f) => f.family.replace(/"/g, '') === 'eigerdals' && f.status === 'loaded');
      return ['400', '700'].every((weight) => loaded.some((f) => f.weight === weight));
    });
    if (!fontReady) throw new Error("Eigerdals didn't load (the Adobe Fonts kit only serves the domains it allows)");

    mkdirSync(resolve(root, OG_DIR), { recursive: true });
    let written = 0;
    for (const card of await page.locator('[data-og]').all()) {
      const name = await card.getAttribute('data-og');
      if (!name || (only.size && !only.has(name))) continue;
      const box = await card.boundingBox();
      if (box?.width !== OG_WIDTH || box.height !== OG_HEIGHT) {
        throw new Error(`card "${name}" is ${box?.width}x${box?.height}, not ${OG_WIDTH}x${OG_HEIGHT}`);
      }
      const file = `${OG_DIR}/${name}.png`;
      await card.screenshot({ path: resolve(root, file), animations: 'disabled' });
      console.log(`wrote ${file}`);
      written++;
    }
    if (!written) throw new Error(only.size ? `no cards named ${[...only].join(', ')}` : 'no [data-og] cards found');
    return 0;
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    return 1;
  } finally {
    await browser?.close();
    await server.close();
  }
}

/**
 * Shared entry for every page (<script type="module" src="/src/scripts/main.ts">).
 *
 * 1. theme toggle wiring, header nav (phone menu sheet), mascot expression swapping
 * 2. the page module picked by <body data-page>: "home" -> ./home.ts, "guide" -> ./guide.ts,
 *    "blog" -> ./blog.ts (dynamic import; each page module exports `init()`, called once)
 * 3. mountPoe() from src/poe/index.ts (the corner widget, on every page)
 *
 * Page CSS is linked from each page's <head>, not imported here, so it never flashes.
 */

import { mountPoe } from '../poe/index';
import { initMascots } from './mascot';
import { initNav } from './nav';
import { initTheme } from './theme';

type PageModule = { init?: () => void | Promise<void> };

const PAGE_MODULES: Record<string, () => Promise<PageModule>> = {
  home: () => import('./home'),
  guide: () => import('./guide'),
  blog: () => import('./blog'),
};

function safely(label: string, fn: () => void): void {
  try {
    fn();
  } catch (error) {
    console.error(`[atpotato] ${label} failed`, error);
  }
}

async function initPage(): Promise<void> {
  const page = document.body.dataset.page ?? '';
  const load = PAGE_MODULES[page];
  if (!load) return;
  try {
    const mod = await load();
    await mod.init?.();
  } catch (error) {
    console.error(`[atpotato] page module "${page}" failed`, error);
  }
}

safely('theme', initTheme);
safely('nav', () => initNav());
safely('mascot', () => initMascots());
void initPage();
safely('poe', mountPoe);

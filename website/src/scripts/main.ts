/**
 * Shared entry for every page (<script type="module" src="/src/scripts/main.ts">).
 *
 * 1. theme toggle wiring, header nav (phone menu sheet), mascot expression swapping,
 *    the tab title that asks you to come back, the footer's changing tagline, and the
 *    header's account button (./account.ts, which also opens sign-in for Poe's panel)
 * 2. the page module picked by <body data-page>: "home" -> ./home.ts, "guide" -> ./guide.ts,
 *    "blog" -> ./blog.ts, "garden" -> ./garden-page.ts, "settings" -> ./settings.ts,
 *    "weather" -> ./weather-page.ts (dynamic import; each page module
 *    exports `init()`, called once)
 * 3. mountPoe() from src/poe/index.ts (the corner widget, on every page)
 * 4. the weather in the sky behind the header's wordmark (./nav-weather.ts), loaded once
 *    the page is idle: it's decoration, and the home page and the weather report have
 *    their own reading to share with it by then
 *
 * Page CSS is linked from each page's <head>, not imported here, so it never flashes.
 */

import { mountPoe } from '../poe/index';
import { mountAccount } from './account';
import { initMascots } from './mascot';
import { initNav } from './nav';
import { initTabTitle } from './tab';
import { initTagline } from './tagline';
import { initTheme } from './theme';

type PageModule = { init?: () => void | Promise<void> };

const PAGE_MODULES: Record<string, () => Promise<PageModule>> = {
  home: () => import('./home'),
  guide: () => import('./guide'),
  blog: () => import('./blog'),
  garden: () => import('./garden-page'),
  weather: () => import('./weather-page'),
  settings: () => import('./settings'),
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
safely('account', () => mountAccount());
safely('mascot', () => initMascots());
safely('tab', () => initTabTitle());
safely('tagline', () => initTagline());
void initPage();
safely('poe', mountPoe);

const idle = (window as Window & { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number }).requestIdleCallback;
const navWeather = () =>
  void import('./nav-weather').then(
    (m) => safely('nav weather', () => m.initNavWeather()),
    (error) => console.error('[atpotato] nav weather failed', error),
  );
if (idle) idle(navWeather, { timeout: 2000 });
else window.setTimeout(navWeather, 300);

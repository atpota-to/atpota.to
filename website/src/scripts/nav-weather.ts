/**
 * The sky behind the header's wordmark: a pill of the weather tile's sky with the weather
 * in it, kept quiet. The little sun at its end (a moon by night) turns its rays faster when
 * the network is busy, a cloud or two drifts by as the diversity index climbs, and a storm
 * greys the sky (components.css, .site-header__sky). Hovering the wordmark says it in words.
 *
 * It takes its readings from the rest of the page where it can: the last one this tab saw
 * (storedReading), and each new one the home page or the weather report gets
 * (READING_EVENT). Only when none has come by for NAV_REFRESH_MS, with the tab visible,
 * does it ask by itself, through readAtmosphere so it shares any request just made.
 * Until a reading comes, and without JS, it's a clear sky.
 */

import { CONDITION_TEXT, READING_EVENT, readAtmosphere, recordsPerSecond, spinRays, STORE_MS, storedReading, type Reading } from './weather';
import { cloudCount, renderClouds } from './weather-sky';

/** The pill is small: a few clouds already make it overcast. */
export const MAX_NAV_CLOUDS = 3;
/** How long it waits for the page's own reading before asking for one. */
export const FIRST_ASK_MS = 2500;
/** How often it asks while nothing else on the page does. */
export const NAV_REFRESH_MS = STORE_MS;

/** "the atmosphere right now: breezy. a usual day in the atmosphere. 452 new records a second" */
export function navSkyTitle(r: Reading): string {
  return `the atmosphere right now: ${CONDITION_TEXT[r.condition]}. ${Math.round(recordsPerSecond(r)).toLocaleString('en-US')} new records a second`;
}

export function renderNavSky(brand: HTMLElement, r: Reading): void {
  const sky = brand.querySelector<HTMLElement>('[data-nav-sky]');
  if (!sky) return;
  sky.dataset.condition = r.condition;
  spinRays(sky, recordsPerSecond(r));
  const clouds = sky.querySelector<HTMLElement>('[data-weather-sky]');
  if (clouds && r.diversity) renderClouds(clouds, Math.min(MAX_NAV_CLOUDS, cloudCount(r.diversity.index)));
  brand.title = navSkyTitle(r);
}

export function initNavWeather(root: Document = document, fetchImpl: typeof fetch = fetch): void {
  const brand = root.querySelector<HTMLElement>('[data-nav-brand]');
  if (!brand?.querySelector('[data-nav-sky]') || brand.dataset.skyBound === 'true') return;
  brand.dataset.skyBound = 'true';
  const started = Date.now();
  // the last time a reading came by, or it asked for one (so a sky that can't be read isn't asked again and again)
  let freshAt = -Infinity;
  const show = (r: Reading) => {
    freshAt = Date.now();
    renderNavSky(brand, r);
  };
  window.addEventListener(READING_EVENT, (e) => show((e as CustomEvent<Reading>).detail));
  // the last page's reading until a fresh one comes; it may be a couple of minutes old, so it still asks
  const stored = storedReading();
  if (stored) renderNavSky(brand, stored);
  const ask = () => {
    if (document.visibilityState === 'hidden') return;
    freshAt = Date.now();
    void readAtmosphere(fetchImpl).then((r) => r && show(r));
  };
  window.setTimeout(() => {
    if (freshAt < started) ask();
    window.setInterval(() => {
      if (Date.now() - freshAt >= NAV_REFRESH_MS) ask();
    }, NAV_REFRESH_MS / 4);
  }, FIRST_ASK_MS);
}

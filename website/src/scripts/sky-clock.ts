/**
 * The reader's clock, as a sky shows it: the time of day and the season. Poe's hill on the
 * home page (scene.ts) and the weather report's header (weather-hero.ts) both go by it, so
 * a reader sees the same golden hour on both. It's on its own so the weather report can
 * have the clock without the hill's drawings. The inline script at the top of the hill in
 * index.html keeps its own copy of these rules (tests/home-scene.test.ts keeps them in step).
 */

import type { Theme } from './theme';

export const TIMES = ['dawn', 'day', 'golden', 'night'] as const;
export const SEASONS = ['plain', 'spring', 'summer', 'autumn', 'winter'] as const;

export type TimeOfDay = (typeof TIMES)[number];
export type Season = (typeof SEASONS)[number];

/** dawn 5–8, day 8–17, golden hour 17–19:30, night after that; the dark theme is always night. */
export function timeOfDay(date: Date, theme: Theme = 'light'): TimeOfDay {
  if (theme === 'dark') return 'night';
  const h = date.getHours() + date.getMinutes() / 60;
  if (h >= 5 && h < 8) return 'dawn';
  if (h >= 8 && h < 17) return 'day';
  if (h >= 17 && h < 19.5) return 'golden';
  return 'night';
}

const MONTH_SEASONS: readonly Season[] = ['winter', 'winter', 'spring', 'spring', 'spring', 'summer', 'summer', 'summer', 'autumn', 'autumn', 'autumn', 'winter'];

/** Meteorological seasons, north of the equator. */
export function seasonOf(date: Date): Season {
  return MONTH_SEASONS[date.getMonth()] ?? 'plain';
}

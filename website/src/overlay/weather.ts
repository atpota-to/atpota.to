/**
 * The weather on the overlay: the card (the home page's "atmospheric conditions" tile, made
 * for a stream) and the strip (the same in one slim bar). Both have the same markup hooks
 * (data-weather-*), so weather.ts renderReading draws the numbers, the sun, the sparkline,
 * the clouds and the diversity index; this adds the apps outside Bluesky in turn, one
 * every APP_MS, busiest first.
 */

import { formatRate, renderReading, renderWeatherError, type Reading } from '../scripts/weather';

export const APP_MS = 6000;
/** How many of the busiest apps take turns. */
export const APP_TURNS = 5;

/** The apps that take turns on the card, busiest first. */
export function appTurns(r: Reading): Array<{ domain: string; rate: string }> {
  return (r.apps ?? []).slice(0, APP_TURNS).map((a) => ({ domain: a.domain, rate: `${formatRate(a.perSecond)}/sec` }));
}

export interface WeatherCard {
  render(r: Reading): void;
  /** No reading this time: a card that never had one says so, one that did keeps it. */
  failed(): void;
}

export function mountWeatherCard(card: HTMLElement, win: Window = window): WeatherCard {
  const app = card.querySelector<HTMLElement>('[data-ov-app]');
  const domain = card.querySelector<HTMLElement>('[data-ov-app-domain]');
  const rate = card.querySelector<HTMLElement>('[data-ov-app-rate]');
  let turns: ReturnType<typeof appTurns> = [];
  let turn = 0;

  const showTurn = () => {
    if (!app || !domain || !rate) return;
    app.hidden = turns.length === 0;
    const t = turns[turn % Math.max(1, turns.length)];
    if (!t) return;
    domain.textContent = t.domain;
    rate.textContent = t.rate;
    // restart the fade-in
    app.classList.remove('is-turning');
    void app.offsetWidth;
    app.classList.add('is-turning');
  };
  win.setInterval(() => {
    if (turns.length < 2) return;
    turn = (turn + 1) % turns.length;
    showTurn();
  }, APP_MS);

  return {
    render(r) {
      renderReading(card, r);
      card.dataset.condition = r.condition;
      const fresh = appTurns(r);
      // the same apps in a new order shouldn't jump the turn back to the start
      if (fresh.map((t) => t.domain).join() !== turns.map((t) => t.domain).join()) turn = 0;
      turns = fresh;
      showTurn();
    },
    failed() {
      renderWeatherError(card);
    },
  };
}

/**
 * The weather widgets on the overlay, each a <section data-ov-widget="kind"> in
 * overlay/index.html that layout.ts puts in its slot:
 *
 *   card      the home page's "atmospheric conditions" tile, made for a stream
 *   strip     the same in one slim bar, along the top or the bottom
 *   badge     just the sun, records a second and the sky in a word
 *   apps      the busiest apps outside Bluesky, with bars
 *   forecast  the next FORECAST_HOURS hours (/api/weather-forecast), and the words for them
 *   pulse     the station's last 60 seconds as a big line, under the rate
 *
 * The card, strip and badge share the markup hooks (data-weather-*), so weather.ts
 * renderReading draws their numbers, sun, sparkline, clouds and diversity index; the card
 * and strip add the apps outside Bluesky in turn, one every APP_MS, busiest first. App
 * names are other people's text and only reach the page through textContent.
 */

import { fetchForecast, FORECAST_REFRESH_MS, forecastWords, hourLabel, iconFor, type Forecast } from '../scripts/weather-forecast';
import { renderSparkline } from '../scripts/weather-spark';
import { countTo, formatRate, recordsPerSecond, renderReading, renderWeatherError, type Reading } from '../scripts/weather';
import type { WidgetKind } from './config';

export const APP_MS = 6000;
/** How many of the busiest apps take turns on the card and strip, and stand in the apps widget. */
export const APP_TURNS = 5;
export const FORECAST_HOURS = 6;

/** The apps that take turns, busiest first. */
export function appTurns(r: Reading): Array<{ domain: string; rate: string }> {
  return (r.apps ?? []).slice(0, APP_TURNS).map((a) => ({ domain: a.domain, rate: `${formatRate(a.perSecond)}/sec` }));
}

export interface WeatherCard {
  render(r: Reading): void;
  /** No reading this time: a widget that never had one says so, one that did keeps it. */
  failed(): void;
}

/** The card, the strip or the badge. */
export function mountWeatherCard(card: HTMLElement, win: Window = window): WeatherCard {
  const app = card.querySelector<HTMLElement>('[data-ov-app]');
  const domain = card.querySelector<HTMLElement>('[data-ov-app-domain]');
  const rate = card.querySelector<HTMLElement>('[data-ov-app-rate]');
  const word = card.querySelector<HTMLElement>('[data-ov-cond-word]');
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
  if (app) {
    win.setInterval(() => {
      if (turns.length < 2) return;
      turn = (turn + 1) % turns.length;
      showTurn();
    }, APP_MS);
  }

  return {
    render(r) {
      renderReading(card, r);
      card.dataset.condition = r.condition;
      if (word) word.textContent = r.condition === 'light' ? 'light breeze' : r.condition;
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

/** The apps widget: a row each, a bar for its share of the busiest. */
export function mountApps(el: HTMLElement): WeatherCard {
  const list = el.querySelector<HTMLElement>('[data-ov-apps]')!;
  const empty = el.querySelector<HTMLElement>('[data-ov-apps-empty]');
  return {
    render(r) {
      const apps = (r.apps ?? []).slice(0, APP_TURNS);
      const top = Math.max(...apps.map((a) => a.perSecond), 0.1);
      const doc = el.ownerDocument;
      list.replaceChildren(
        ...apps.map((a) => {
          const li = doc.createElement('li');
          const name = doc.createElement('span');
          name.className = 'ov-apps__name';
          name.textContent = a.domain;
          const rate = doc.createElement('span');
          rate.className = 'ov-apps__rate';
          rate.textContent = `${formatRate(a.perSecond)}/sec`;
          const bar = doc.createElement('span');
          bar.className = 'ov-apps__bar';
          bar.style.setProperty('--share', String(Math.max(0.04, a.perSecond / top)));
          li.append(name, rate, bar);
          return li;
        }),
      );
      if (empty) empty.hidden = apps.length > 0;
      el.dataset.state = 'ready';
    },
    failed() {
      if (el.dataset.state !== 'ready') el.dataset.state = 'error';
    },
  };
}

/** The pulse widget: the rate, and the station's last 60 seconds as a big line. */
export function mountPulse(el: HTMLElement): WeatherCard {
  const line = el.querySelector<HTMLElement>('[data-ov-pulse-line]')!;
  const rate = el.querySelector<HTMLElement>('[data-ov-pulse-rate]');
  const note = el.querySelector<HTMLElement>('[data-ov-pulse-note]');
  return {
    render(r) {
      if (rate) countTo(rate, recordsPerSecond(r));
      const series = r.series ?? [];
      const values = series.map((p) => p?.creates ?? null);
      const live = r.source === 'station' && values.filter((v) => v !== null).length >= 2;
      line.hidden = !live;
      if (note) note.textContent = live ? 'new records a second, the last minute' : 'new records a second';
      if (live) {
        const last = series.findLastIndex((p) => p !== null);
        renderSparkline(line, values, last >= 0 ? series[last]!.t + (series.length - 1 - last) : undefined);
      }
      el.dataset.state = 'ready';
    },
    failed() {
      if (el.dataset.state !== 'ready') el.dataset.state = 'error';
    },
  };
}

const nightAt = (iso: string) => {
  const h = new Date(iso).getHours();
  return h >= 20 || h < 6;
};

/** The forecast widget: its own reading, every FORECAST_REFRESH_MS while it's shown. */
export function mountForecast(el: HTMLElement, fetchImpl: typeof fetch = fetch, win: Window = window): { show(on: boolean): void } {
  const hoursEl = el.querySelector<HTMLElement>('[data-ov-fc-hours]')!;
  const words = el.querySelector<HTMLElement>('[data-ov-fc-words]');
  const doc = el.ownerDocument;
  let timer: number | undefined;
  let shown = false;

  const draw = (f: Forecast) => {
    const hours = f.hours.slice(0, FORECAST_HOURS);
    if (words) words.textContent = f.learning || hours.length === 0 ? "still learning the sky's habits" : forecastWords(hours);
    hoursEl.replaceChildren(
      ...hours.map((h) => {
        const li = doc.createElement('li');
        const time = doc.createElement('span');
        time.className = 'ov-fc__time';
        time.textContent = hourLabel(h.t);
        const icon = doc.createElement('span');
        icon.className = 'ov-fc__icon';
        // static markup from weather-forecast.ts
        icon.innerHTML = iconFor(h.condition, nightAt(h.t));
        const rate = doc.createElement('span');
        rate.className = 'ov-fc__rate';
        rate.textContent = String(Math.round(h.perSecond));
        li.append(time, icon, rate);
        return li;
      }),
    );
    el.dataset.state = 'ready';
  };
  const check = async () => {
    win.clearTimeout(timer);
    const f = await fetchForecast(fetchImpl);
    if (f) draw(f);
    else if (el.dataset.state !== 'ready') el.dataset.state = 'error';
    if (shown) timer = win.setTimeout(() => void check(), FORECAST_REFRESH_MS);
  };
  return {
    show(on) {
      if (on && !shown) {
        shown = true;
        void check();
      } else if (!on) {
        shown = false;
        win.clearTimeout(timer);
      }
    },
  };
}

export interface Widgets {
  render(r: Reading): void;
  failed(): void;
  /** The forecast only asks while it's on screen. */
  showing(kinds: Set<WidgetKind>): void;
}

/** Every widget on the page, mounted once; layout.ts decides which show. */
export function mountWidgets(root: ParentNode, win: Window = window): Widgets {
  const find = (kind: WidgetKind) => root.querySelector<HTMLElement>(`[data-ov-widget="${kind}"]`);
  const readers: WeatherCard[] = [];
  for (const kind of ['card', 'strip', 'badge'] as const) {
    const el = find(kind);
    if (el) readers.push(mountWeatherCard(el, win));
  }
  const apps = find('apps');
  if (apps) readers.push(mountApps(apps));
  const pulse = find('pulse');
  if (pulse) readers.push(mountPulse(pulse));
  const fcEl = find('forecast');
  const forecast = fcEl ? mountForecast(fcEl, fetch, win) : null;
  return {
    render: (r) => readers.forEach((w) => w.render(r)),
    failed: () => readers.forEach((w) => w.failed()),
    showing: (kinds) => forecast?.show(kinds.has('forecast')),
  };
}

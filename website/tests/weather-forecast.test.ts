// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  chanceWords,
  fetchForecast,
  forecastWords,
  hourLabel,
  iconFor,
  readForecast,
  renderForecast,
  skillWords,
  STORM_SAID,
  timeLabel,
  type Forecast,
  type ForecastHour,
} from '../src/scripts/weather-forecast.js';
import { EXPLAINERS } from '../src/scripts/weather-page.js';

// The forecast tile on /weather: the next 12 hours, the network's sunrise and sunset, and how well it's been doing.

const PAGE = readFileSync(resolve(process.cwd(), 'weather/index.html'), 'utf8');
const MAIN = PAGE.slice(PAGE.indexOf('<main'), PAGE.indexOf('</main>') + '</main>'.length);
const TZ = 'America/New_York';
// 1:20 pm in New York
const NOW = Date.parse('2026-11-03T18:20:00.000Z');
const HOUR = 3_600_000;

const hour = (k: number, perSecond: number, condition: ForecastHour['condition'], storm = 0): ForecastHour => ({
  t: new Date(Date.parse('2026-11-03T18:00:00.000Z') + k * HOUR).toISOString(),
  perSecond,
  low: perSecond * 0.9,
  high: perSecond * 1.1,
  condition,
  chance: { gusts: Math.max(storm, perSecond >= 500 ? 0.6 : 0.1), storm },
});

const FORECAST: Forecast = {
  madeAt: new Date(NOW).toISOString(),
  basis: { hours: 330, days: 13 },
  now: { t: '2026-11-03T18:00:00.000Z', perSecond: 455.2, seconds: 1200, condition: 'breezy' },
  hours: [hour(1, 470, 'breezy'), hour(2, 480, 'breezy', 0.1), hour(3, 520, 'gusty', 0.32), hour(4, 505, 'gusty', 0.2), hour(5, 430, 'breezy'), hour(6, 380, 'light')],
  sun: [
    { kind: 'settles', at: '2026-11-04T01:05:00.000Z' },
    { kind: 'wakes', at: '2026-11-04T12:40:00.000Z' },
    { kind: 'settles', at: '2026-11-05T01:05:00.000Z' },
  ],
  skill: { lead: 1, hours: 66, error: 0.043, usualError: 0.05 },
};

let tile: HTMLElement;

beforeEach(() => {
  document.body.innerHTML = MAIN;
  tile = document.querySelector<HTMLElement>('[data-f-forecast]')!;
});

describe('reading the forecast', () => {
  it('keeps what checks out and drops the rest', () => {
    const body = JSON.parse(JSON.stringify(FORECAST));
    body.hours.push({ t: 'nope', perSecond: 1, low: 1, high: 1, condition: 'breezy', chance: { gusts: 0, storm: 0 } });
    body.hours.push({ ...body.hours[0], condition: 'hurricane' });
    body.hours.push({ ...body.hours[0], chance: { gusts: 2, storm: 0 } });
    body.sun.push({ kind: 'noon', at: body.sun[0].at });
    const f = readForecast(body)!;
    expect(f.hours).toHaveLength(FORECAST.hours.length);
    expect(f.sun).toHaveLength(3);
    expect(f.now).toEqual(FORECAST.now);
    expect(f.skill).toEqual(FORECAST.skill);
    expect(readForecast({ madeAt: FORECAST.madeAt, basis: { hours: 20, days: 0 }, learning: true })).toMatchObject({ learning: true, hours: [] });
    expect(readForecast({ basis: {} })).toBeNull();
    expect(readForecast('nope')).toBeNull();
  });

  it("asks /api/weather-forecast, and is null when it can't", async () => {
    const asked: string[] = [];
    const ok = (async (url: string) => (asked.push(url), Response.json(FORECAST))) as typeof fetch;
    expect((await fetchForecast(ok))?.hours).toHaveLength(6);
    expect(asked).toEqual(['/api/weather-forecast']);
    expect(await fetchForecast((async () => new Response('', { status: 503 })) as typeof fetch)).toBeNull();
    expect(await fetchForecast((async () => Promise.reject(new Error('offline'))) as typeof fetch)).toBeNull();
  });
});

describe('the forecast in words', () => {
  it("says hours and times in the reader's zone", () => {
    expect(hourLabel('2026-11-03T21:00:00.000Z', TZ)).toBe('4 pm');
    expect(hourLabel('2026-11-03T21:00:00.000Z', 'Asia/Kolkata')).toBe('2:30 am');
    expect(timeLabel('2026-11-04T12:40:00.000Z', TZ)).toBe('7:40 am');
  });

  it('says how it starts, the first change, and a storm with a fair chance', () => {
    expect(forecastWords(FORECAST.hours, TZ)).toBe('breezy until about 4 pm, then picking up to gusty. a 30% chance of a storm around 4 pm.');
    expect(forecastWords([hour(1, 380, 'light'), hour(2, 300, 'light')], TZ)).toBe('a light breeze for the next 2 hours.');
    expect(forecastWords([hour(1, 520, 'gusty'), hour(2, 430, 'breezy')], TZ)).toBe('gusty until about 3 pm, then calming down to breezy.');
    // under STORM_SAID it doesn't bring it up
    expect(forecastWords([hour(1, 520, 'gusty', STORM_SAID - 0.01)], TZ)).toBe('gusty for the next hour.');
    expect(forecastWords([], TZ)).toBe('');
  });

  it('says a chance like a weather app: to the nearest 10%, never 0 or 100', () => {
    expect(chanceWords(0.32)).toBe('30%');
    expect(chanceWords(0.01)).toBe('10%');
    expect(chanceWords(0.99)).toBe('90%');
  });

  it("says how well it's been doing, or what it's made from while it can't", () => {
    expect(skillWords(FORECAST)).toBe('made from 13 days of readings. lately its forecasts for the next hour have been off by about 4% on a typical hour, against 5% going by usual alone.');
    expect(skillWords({ ...FORECAST, basis: { hours: 30, days: 1 }, skill: undefined })).toMatch(/^made from 30 hours of readings\. once it has a few days/);
  });

  it('Poe explains it in its own voice', () => {
    for (const key of ['forecast', 'readouts'] as const) {
      const said = EXPLAINERS[key];
      expect(said, key).toBeTruthy();
      expect(JSON.stringify(said)).not.toMatch(/[–—]/);
    }
  });
});

describe('the forecast tile', () => {
  it('draws now and the hours to come, the band, the sun cards and the note', () => {
    renderForecast(tile, FORECAST, NOW, TZ);
    expect(tile.dataset.state).toBe('ready');
    const items = [...tile.querySelectorAll('[data-f-hours] > li')];
    expect(items).toHaveLength(7);
    expect(items[0]!.textContent).toContain('now');
    expect(items[1]!.textContent).toContain('2 pm');
    expect(tile.querySelector<HTMLElement>('[data-f-hours]')!.style.getPropertyValue('--hours')).toBe('7');
    expect(tile.querySelector('[data-f-band] svg')).not.toBeNull();
    const sun = tile.querySelector<HTMLElement>('[data-f-sun]')!;
    expect(sun.hidden).toBe(false);
    // soonest first: tonight's sunset, then tomorrow's sunrise
    expect(sun.textContent).toMatch(/network sunset[\s\S]*8:05 pm[\s\S]*network sunrise[\s\S]*7:40 am/);
    expect(tile.querySelector('[data-f-note]')!.textContent).toBe(skillWords(FORECAST));
  });

  it("drops hours that have gone by", () => {
    renderForecast(tile, FORECAST, NOW + 2 * HOUR, TZ);
    expect(tile.querySelectorAll('[data-f-hours] > li')).toHaveLength(6);
  });

  it('says it is still learning, and hides the sun, until it can forecast', () => {
    renderForecast(tile, { madeAt: FORECAST.madeAt, basis: { hours: 20, days: 0 }, learning: true, hours: [], sun: [] }, NOW, TZ);
    expect(tile.dataset.state).toBe('learning');
    expect(tile.querySelector('[data-f-lede]')!.textContent).toContain('20 hours so far');
    expect(tile.querySelector<HTMLElement>('[data-f-sun]')!.hidden).toBe(true);
  });

  it('has an icon for every condition, by day and night', () => {
    for (const c of ['calm', 'light', 'breezy', 'gusty', 'stormy'] as const) {
      expect(iconFor(c, false), c).toMatch(/^<svg/);
      expect(iconFor(c, true), c).toMatch(/^<svg/);
    }
    expect(iconFor('calm', true)).toContain('wf-moon');
    expect(iconFor('stormy', false)).toContain('wf-rain');
  });
});

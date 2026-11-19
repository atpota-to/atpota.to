// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { healthOf } from '../server/atmosphere.js';
import { fetchReading, resetSharedReading, type Reading } from '../src/scripts/weather.js';
import { renderStation, stationStatus } from '../src/scripts/weather-station.js';

// How the weather station is doing, as a line under the report's title.

const PAGE = readFileSync(resolve(process.cwd(), 'weather/index.html'), 'utf8');
const MAIN = PAGE.slice(PAGE.indexOf('<main'), PAGE.indexOf('</main>') + '</main>'.length);

const live = (health?: Reading['health']): Reading => ({ perSecond: { posts: 1, likes: 1, reposts: 1, follows: 1 }, condition: 'calm', source: 'station', ...(health ? { health } : {}) });

describe('stationStatus', () => {
  it('healthy when live, current and whole', () => {
    const s = stationStatus(live({ ok: true, lagSeconds: 0.2, covered60: 60, missing: 0, lost: 0, repairing: null }));
    expect(s.level).toBe('ok');
    expect(s.label).toBe('station healthy');
  });

  it('filling in what it missed, and when', () => {
    const s = stationStatus(live({ ok: true, lagSeconds: 0.2, covered60: 60, missing: 212, lost: 3, repairing: { from: '2026-10-22T20:21:00.000Z', to: '2026-10-22T22:21:00.000Z' } }));
    expect(s.level).toBe('mending');
    expect(s.label).toBe('filling in 212 minutes');
    expect(s.detail).toMatch(/right now it's on .+ to .+\. the trends show them as gaps/);
    expect(s.detail).toMatch(/3 minutes from the last day or so are gone for good/);
  });

  it('catching up when it is behind, with how far', () => {
    const s = stationStatus(live({ ok: false, lagSeconds: 42.4, covered60: 18 }));
    expect(s.level).toBe('behind');
    expect(s.detail).toMatch(/heard 18 of the last 60 seconds, 42 seconds behind/);
  });

  it('offline on a sample, unreachable with nothing, live from a station that says nothing of its health', () => {
    expect(stationStatus({ ...live(), source: 'sample' }).level).toBe('sample');
    expect(stationStatus(null).level).toBe('down');
    expect(stationStatus(live()).label).toBe('station live');
  });
});

describe('the station health on the way through', () => {
  it('the API keeps what checks out', () => {
    expect(healthOf({ ok: true, lagSeconds: 0.1, covered60: 60, missing: 4, lost: 0, repairing: { from: '2026-10-22T20:21:00Z', to: '2026-10-22T22:21:00Z' }, extra: 'x' })).toEqual({
      ok: true,
      lagSeconds: 0.1,
      covered60: 60,
      missing: 4,
      lost: 0,
      repairing: { from: '2026-10-22T20:21:00.000Z', to: '2026-10-22T22:21:00.000Z' },
    });
    expect(healthOf({ ok: 'yes', covered60: 60 })).toBeNull();
    expect(healthOf({ ok: false, lagSeconds: null, covered60: 99 })).toEqual({ ok: false, lagSeconds: null, covered60: 60 });
  });

  it('the page keeps it from the reading', async () => {
    resetSharedReading();
    const body = { ...live(), health: { ok: false, lagSeconds: 30, covered60: 12, repairing: { from: 'nope', to: 'nope' } } };
    const r = await fetchReading(async () => Response.json(body));
    expect(r?.health).toEqual({ ok: false, lagSeconds: 30, covered60: 12 });
  });
});

describe('renderStation', () => {
  beforeEach(() => {
    document.body.innerHTML = MAIN;
  });

  it('shows the line with its level, label and what it says when opened', () => {
    const el = document.querySelector<HTMLElement>('[data-station]')!;
    expect(el.hidden).toBe(true);
    renderStation(document, { ...live(), source: 'sample' });
    expect(el.hidden).toBe(false);
    expect(el.dataset.level).toBe('sample');
    expect(el.querySelector('[data-station-label]')!.textContent).toBe('station offline');
    expect(el.querySelector('[data-station-detail]')!.textContent).toMatch(/isn't answering/);
  });
});

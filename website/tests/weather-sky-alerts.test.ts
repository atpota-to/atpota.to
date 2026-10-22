// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PoeLine, PoeSpeech } from '../src/poe/say.js';
import { ALERT_MS, ALERTS_KEY, ARRIVAL_MIN, alertsFor, COOLDOWN_MS, createAlertDesk, GAP_MS, newAppAlert, recordAlert, RETRY_MS, STALE_MS, watchHosts, type AlertDesk, type WeatherAlert } from '../src/scripts/weather-alerts.js';
import { smoothPath } from '../src/scripts/weather-chart.js';
import { watchNewApps } from '../src/scripts/weather-page.js';
import { cloudCount, MAX_CLOUDS, renderClouds } from '../src/scripts/weather-sky.js';
import { renderReading, type Reading } from '../src/scripts/weather.js';

// The cloudy sky, the weather alerts, and the smooth lines on /weather.

const READING: Reading = {
  perSecond: { posts: 40, likes: 300, reposts: 50, follows: 20 },
  condition: 'stormy',
  source: 'station',
  records: { perSecond: 450, bluesky: 449, elsewhere: 1 },
  diversity: { index: 0.22, level: 'low', apps: 3, collections: 20 },
  apps: [
    { domain: 'tangled.sh', perSecond: 0.5, count: 30, collections: ['sh.tangled.repo'] },
    { domain: 'delve.town', perSecond: 0.2, count: 12, collections: ['town.delve.feed.post'] },
  ],
};

afterEach(() => {
  vi.useRealTimers();
  localStorage.clear();
});

describe('the sky gets cloudier with the diversity index', () => {
  it('is clear with no diversity, and fills up as it climbs', () => {
    expect(cloudCount(0)).toBe(0);
    expect(cloudCount(0.05)).toBe(1);
    expect(cloudCount(1)).toBe(2);
    expect(cloudCount(3)).toBe(4);
    expect(cloudCount(11)).toBe(MAX_CLOUDS);
    expect(cloudCount(40)).toBe(MAX_CLOUDS);
    const counts = [0.1, 0.5, 1, 2, 4, 8, 11].map(cloudCount);
    expect(counts).toEqual([...counts].sort((a, b) => a - b));
  });

  it('adds and takes away clouds at the end, keeping the rest where they are', () => {
    vi.useFakeTimers();
    const layer = document.createElement('div');
    renderClouds(layer, 3);
    const first = layer.querySelector('.weather-sky__drift')!;
    expect(layer.querySelectorAll('.weather-sky__drift')).toHaveLength(3);
    renderClouds(layer, 5);
    expect(layer.querySelector('.weather-sky__drift')).toBe(first);
    expect(layer.querySelectorAll('.weather-sky__drift')).toHaveLength(5);
    renderClouds(layer, 2);
    expect(layer.querySelectorAll('.weather-sky__drift.is-going')).toHaveLength(3);
    vi.advanceTimersByTime(1300);
    expect(layer.querySelectorAll('.weather-sky__drift')).toHaveLength(2);
    expect(layer.dataset.clouds).toBe('2');
  });

  it('the home tile and the weather report both bring the clouds', () => {
    const INDEX = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');
    const start = INDEX.indexOf('<a class="tile tile--link home-weather"');
    document.body.innerHTML = INDEX.slice(start, INDEX.indexOf('</a>\n', INDEX.indexOf('home-weather__go', start)) + 4);
    const tile = document.querySelector<HTMLElement>('[data-weather-tile]')!;
    renderReading(tile, READING);
    expect(tile.querySelector('[data-weather-sky]')!.getAttribute('aria-hidden')).toBe('true');
    expect(tile.querySelectorAll('[data-weather-sky] .weather-sky__drift')).toHaveLength(cloudCount(0.22));
    expect(readFileSync(resolve(process.cwd(), 'weather/index.html'), 'utf8')).toContain('data-weather-sky');
  });
});

describe('what makes a weather alert', () => {
  const app = (domain: string, count: number) => ({ domain, perSecond: count / 60, count, collections: [`${domain.split('.').reverse().join('.')}.thing`] });

  it('the first reading only sets the scene', () => {
    const { alerts, watch } = alertsFor(null, READING);
    expect(alerts).toEqual([]);
    expect([...watch.seen]).toEqual(['tangled.sh', 'delve.town']);
  });

  it('an app this visit has not heard blows in, once', () => {
    const first = alertsFor(null, READING).watch;
    const next: Reading = { ...READING, apps: [...READING.apps!, { domain: 'teal.fm', perSecond: 0.1, count: ARRIVAL_MIN, collections: ['fm.teal.feed.play'] }] };
    const { alerts, watch } = alertsFor(first, next);
    expect(alerts).toEqual([{ kind: 'arrival', label: 'weather alert', text: 'teal.fm just blew in', sub: `${ARRIVAL_MIN} records in the last minute: fm.teal.feed.play` }]);
    expect(alertsFor(watch, next).alerts).toEqual([]);
  });

  it('a record or two drifting through is not news, nor is an app already about getting busier', () => {
    const first = alertsFor(null, READING).watch;
    const drift = alertsFor(first, { ...READING, apps: [...READING.apps!, app('mado.blue', ARRIVAL_MIN - 1)] });
    expect(drift.alerts).toEqual([]);
    // mado.blue was heard (quietly), and tangled.sh was here from the start
    expect(alertsFor(drift.watch, { ...READING, apps: [app('mado.blue', 40), app('tangled.sh', 90)] }).alerts).toEqual([]);
  });

  it('a storm rolling in, and the sky getting more mixed', () => {
    const calm = alertsFor(null, { ...READING, condition: 'breezy' }).watch;
    const { alerts } = alertsFor(calm, { ...READING, diversity: { index: 3.4, level: 'moderate', apps: 9, collections: 30 } });
    expect(alerts.map((a) => a.kind)).toEqual(['storm', 'mixed']);
    expect(alerts[0]!.sub).toBe('450 new records a second. somebody said something.');
    expect(alerts[1]!.text).toBe("the sky's getting mixed: moderate");
  });

  it('a sampled reading never brings arrivals (it is only a few seconds long)', () => {
    const first = alertsFor(null, { ...READING, source: 'sample' }).watch;
    expect(alertsFor(first, { ...READING, source: 'sample', apps: [app('x.y', 50)] }).alerts).toEqual([]);
  });

  it('apps the station has never heard before get their own alert, after the first look', () => {
    const pushed: WeatherAlert[] = [];
    const watch = watchNewApps({ push: (a) => pushed.push(a), hushed: false, hush() {}, unhush() {}, onHushChange() {} }, 'UTC');
    const fresh = (domain: string) => ({ domain, firstSeen: '2026-11-03T16:46:00.000Z', creates: 1, collections: [] });
    const almanac = (apps: ReturnType<typeof fresh>[]) => ({ tz: 'UTC', newApps: { historyStart: null, readyAt: null, warmingUp: false, heard: 9, apps } });
    watch(almanac([fresh('a.app')]));
    expect(pushed).toEqual([]);
    watch(almanac([fresh('b.app'), fresh('a.app')]));
    expect(pushed).toEqual([newAppAlert('b.app', '4:46 pm')]);
    expect(pushed[0]!.text).toBe('b.app is brand new here (◕‿◕)');
  });
});

describe('alerts from where the atmosphere lives', () => {
  const census = (measuredAt: string, independent: number) => ({
    measuredAt, listed: 6442, active: independent + 90, bluesky: 90, independent, writing: null,
    accounts: { bluesky: 1, independent: 1 }, diversity: { index: 7.48, share: 1.51, spread: 24.5 }, top: [],
  });

  it('a new census with more independent hosts says so; the same census, or fewer, does not', () => {
    const first = alertsFor(null, { ...READING, hosts: census('2026-10-22T14:00:00Z', 1799) });
    expect(alertsFor(first.watch, { ...READING, hosts: census('2026-10-22T14:00:00Z', 1799) }).alerts.filter((a) => a.kind === 'host')).toEqual([]);
    const more = alertsFor(first.watch, { ...READING, hosts: census('2026-10-22T14:10:00Z', 1801) });
    expect(more.alerts.find((a) => a.kind === 'host')).toMatchObject({ text: '2 more independent hosts just came online', sub: '1,801 independent pds hosts now, 1,891 in all.' });
    expect(alertsFor(more.watch, { ...READING, hosts: census('2026-10-22T14:20:00Z', 1800) }).alerts.filter((a) => a.kind === 'host')).toEqual([]);
    // a reading without the census keeps the last one to compare with
    expect(alertsFor(first.watch, READING).watch.independentHosts).toBe(1799);
  });

  it('new hosts by name, and accounts moving house, after the first look', () => {
    const pushed: WeatherAlert[] = [];
    const see = watchHosts({ push: (a) => pushed.push(a) });
    const day = (movedOut: number, movedIn: number) => ({ day: '2026-10-22', ops: 1, createdBluesky: 1, createdIndependent: 1, createdUnlisted: 1, createdCustomHandle: 0, movedOut, movedIn, movedBetween: 0, deleted: 0, destinations: [] });
    const history = (names: string[], movedOut: number, movedIn = 0) => ({
      bucket: 'hour' as const, since: '2026-10-08', points: [], newHosts: names.length, growing: [], daily: [],
      new: names.map((hostname) => ({ hostname, accounts: 3, first: '2026-10-22' })),
      identities: [day(movedOut, movedIn)],
    });
    see(history(['old.example'], 10));
    expect(pushed).toEqual([]);
    see(history(['old.example', 'fresh.example'], 12));
    expect(pushed.map((a) => [a.kind, a.text])).toEqual([
      ['newhost', 'fresh.example just joined the atmosphere (◕‿◕)'],
      ['moving', '2 accounts just moved out of bluesky to an independent host'],
    ]);
    see(history(['old.example', 'fresh.example'], 12, 1));
    expect(pushed.at(-1)).toMatchObject({ kind: 'moving', text: 'someone just moved back to bluesky', sub: 'today so far: 12 out, 1 back in.' });
    see(undefined);
    expect(pushed).toHaveLength(3);
  });
});

describe('Poe says the alerts', () => {
  const alert = (text: string, kind: WeatherAlert['kind'] = 'arrival'): WeatherAlert => ({ kind, label: 'weather alert', text, sub: 'sub' });

  /** A stand-in for the corner Poe: one line at a time, none while busy. */
  function fakePoe() {
    const said: PoeLine[] = [];
    let showing: PoeLine | null = null;
    const poe = {
      said,
      busy: false,
      get showing() {
        return showing?.text ?? null;
      },
      speak(line: PoeLine): PoeSpeech | null {
        if (poe.busy || showing) return null;
        showing = line;
        said.push(line);
        return { close: () => poe.done() };
      },
      /** The bubble goes (its time is up, or the reader closed it). */
      done() {
        const line = showing;
        showing = null;
        line?.onGone?.();
      },
    };
    return poe;
  }

  let poe: ReturnType<typeof fakePoe>;
  let desk: AlertDesk;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    poe = fakePoe();
    desk = createAlertDesk(window, poe.speak);
  });
  const advance = (ms: number) => vi.advanceTimersByTime(ms);

  it('says one at a time, a minute apart at least, with a face for each', () => {
    desk.push(alert('tangled.sh just blew in'));
    expect(poe.showing).toBe('tangled.sh just blew in');
    expect(poe.said[0]).toMatchObject({ label: 'weather alert', sub: 'sub', face: 'kawaii', ms: ALERT_MS });
    desk.push(alert('teal.fm just blew in'));
    advance(ALERT_MS);
    poe.done();
    expect(poe.showing).toBeNull();
    advance(GAP_MS - ALERT_MS - 50);
    expect(poe.showing).toBeNull();
    advance(50);
    expect(poe.showing).toBe('teal.fm just blew in');
  });

  it('keeps the most important ones when lots happen at once', () => {
    desk.push(alert('first'));
    advance(GAP_MS - 20_000);
    desk.push(alert('a.app'));
    desk.push(alert('b.app'));
    desk.push(alert('storm', 'storm'));
    for (let i = 0; i < 3; i++) {
      poe.done();
      advance(GAP_MS);
    }
    expect(poe.said.map((l) => l.text)).toEqual(['first', 'storm', 'b.app']);
    expect(poe.said[1]!.face).toBe('wow');
  });

  it('lets go of what has waited too long to still be news', () => {
    desk.push(alert('first'));
    desk.push(alert('a.app'));
    desk.push(alert('b.app'));
    for (let i = 0; i < 3; i++) {
      poe.done();
      advance(GAP_MS);
    }
    // b.app would be two minutes late by its turn
    expect(poe.said.map((l) => l.text)).toEqual(['first', 'a.app']);
  });

  it('a storm or a more mixed sky only once every so often', () => {
    desk.push(alert('storm', 'storm'));
    poe.done();
    advance(GAP_MS);
    desk.push(alert('storm again', 'storm'));
    desk.push(alert('mixed', 'mixed'));
    expect(poe.showing).toBe('mixed');
    poe.done();
    advance(COOLDOWN_MS);
    desk.push(alert('a real new storm', 'storm'));
    expect(poe.said.map((l) => l.text)).toEqual(['storm', 'mixed', 'a real new storm']);
  });

  it('a brand new app gets leaves and a happy Poe', () => {
    desk.push(newAppAlert('b.app', '4:46 pm'));
    expect(poe.said[0]).toMatchObject({ face: 'happy', burst: 'leaves' });
  });

  it('waits while Poe is busy or the tab is hidden, and lets go of old news', () => {
    poe.busy = true;
    desk.push(alert('one'));
    advance(RETRY_MS * 3);
    expect(poe.said).toEqual([]);
    poe.busy = false;
    advance(RETRY_MS);
    expect(poe.showing).toBe('one');
    poe.done();

    const hidden = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    advance(GAP_MS);
    desk.push(alert('two'));
    advance(RETRY_MS * 2);
    expect(poe.showing).toBeNull();
    advance(STALE_MS);
    hidden.mockRestore();
    advance(RETRY_MS);
    expect(poe.said.map((l) => l.text)).toEqual(['one']);
  });

  it('can be hushed from the bubble, and stays hushed in this browser', () => {
    desk.push(alert('one'));
    poe.said[0]!.action!.run();
    expect(desk.hushed).toBe(true);
    expect(poe.showing).toBeNull();
    expect(localStorage.getItem(ALERTS_KEY)).toBe('off');
    const again = createAlertDesk(window, poe.speak);
    again.push(alert('two'));
    advance(GAP_MS);
    expect(poe.said).toHaveLength(1);
    again.unhush();
    expect(localStorage.getItem(ALERTS_KEY)).toBeNull();
  });

  it('hushing from the page takes the line away too', () => {
    desk.push(alert('one'));
    desk.push(alert('two'));
    desk.hush();
    expect(poe.showing).toBeNull();
    advance(GAP_MS * 2);
    expect(poe.said).toHaveLength(1);
  });
});

describe('smooth lines', () => {
  const ys = (d: string) => [...d.matchAll(/-?\d+(?:\.\d+)?/g)].map((m) => Number(m[0])).filter((_, i) => i % 2 === 1);

  it('curves through every point', () => {
    const d = smoothPath([
      [0, 10],
      [10, 30],
      [20, 20],
      [30, 25],
    ]);
    expect(d.startsWith('M0,10C')).toBe(true);
    expect(d.endsWith(',30,25')).toBe(true);
    expect(d.match(/C/g)).toHaveLength(3);
  });

  it('never overshoots: every control point stays inside its stretch', () => {
    const pts: Array<[number, number]> = [
      [0, 0],
      [10, 100],
      [20, 100],
      [30, 0],
      [40, 50],
    ];
    const d = smoothPath(pts);
    const all = ys(d);
    expect(Math.max(...all)).toBeLessThanOrEqual(100);
    expect(Math.min(...all)).toBeGreaterThanOrEqual(0);
  });

  it('keeps one or two points simple', () => {
    expect(smoothPath([])).toBe('');
    expect(smoothPath([[1, 2]])).toBe('M1,2');
    expect(smoothPath([
      [0, 0],
      [10, 5],
    ])).toBe('M0,0L10,5');
  });
});

describe('record highs and storms clearing', () => {
  it('a live minute past the record is a record high, and only a live one', () => {
    const live: Reading = { ...READING, records: { perSecond: 642.6, bluesky: 640, elsewhere: 2.6 } };
    expect(recordAlert(600, live)).toEqual({
      kind: 'record',
      label: 'record high',
      text: "a record high! the busiest minute i've ever heard",
      sub: '643 new records a second, past the old record of 600.',
    });
    expect(recordAlert(700, live)).toBeNull();
    expect(recordAlert(642.6, live)).toBeNull();
    expect(recordAlert(null, live)).toBeNull();
    expect(recordAlert(600, { ...live, source: 'sample' })).toBeNull();
  });

  it('a storm passing brings out a rainbow; easing to gusty does not', () => {
    const storm = alertsFor(null, READING).watch;
    const { alerts } = alertsFor(storm, { ...READING, condition: 'breezy', records: { perSecond: 452, bluesky: 450, elsewhere: 2 } });
    expect(alerts).toEqual([{ kind: 'clear', label: 'weather alert', text: "the storm's passed. look up, a rainbow (◕‿◕)", sub: 'back down to 452 new records a second.' }]);
    expect(alertsFor(storm, { ...READING, condition: 'gusty' }).alerts).toEqual([]);
  });
});

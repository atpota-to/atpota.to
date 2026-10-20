// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  aturiFor,
  bigNumber,
  changeText,
  daypart,
  fetchAlmanac,
  gaugeAt,
  heatStep,
  hourWords,
  rangeAt,
  readAlmanac,
  renderHeatmap,
  renderNewApps,
  renderToday,
  roughly,
  summarizeHeat,
  USUAL_EDGES,
  usualText,
  type Almanac,
} from '../src/scripts/weather-almanac.js';
import { appChange } from '../src/scripts/weather-page.js';

// The almanac tiles on /weather: today so far, new in the atmosphere, when the sky is busiest.

const PAGE = readFileSync(resolve(process.cwd(), 'weather/index.html'), 'utf8');
const MAIN = PAGE.slice(PAGE.indexOf('<main'), PAGE.indexOf('</main>') + '</main>'.length);
const TZ = 'America/New_York';
// a tuesday, 1 pm in New York
const NOW = Date.parse('2026-11-03T18:00:00.000Z');
const S = (posts: number, seconds = 3600, creates = posts * 9, elsewhere = Math.round(creates * 0.004)) => ({ seconds, posts, creates, elsewhere });

const ALMANAC: Almanac = {
  tz: TZ,
  today: { start: '2026-11-03T05:00:00.000Z', ...S(2_000_000, 46_800, 16_000_000, 52_000), high: { minute: '2026-11-03T20:14:00.000Z', perSecond: 642.2 }, low: { minute: '2026-11-03T09:02:00.000Z', perSecond: 262.9 } },
  normal: { historyStart: '2026-10-20T16:50:00.000Z', now: S(187_200), days: { ...S(158_400 * 6, 3600 * 6), windows: 6 }, weeks: { ...S(158_400 * 2, 7200), windows: 2 } },
  newApps: { historyStart: '2026-10-20T16:50:00.000Z', readyAt: '2026-10-27T16:50:00.000Z', warmingUp: false, heard: 90, apps: [{ domain: 'mu.social', firstSeen: '2026-11-03T16:46:00.000Z', creates: 4, collections: ['social.mu.newsFeedPrefs'] }] },
  heatmap: {
    seconds: 4 * 7 * 86_400,
    cells: [
      { dow: 2, hour: 13, seconds: 14_400, posts: 14_400 * 52, creates: 14_400 * 520 },
      { dow: 7, hour: 5, seconds: 14_400, posts: 14_400 * 30, creates: 14_400 * 300 },
      { dow: 3, hour: 3, seconds: 100, posts: 100 * 99, creates: 100 * 990 }, // too little heard to count
    ],
  },
};

let root: HTMLElement;
const text = (sel: string) => root.querySelector(sel)!.textContent;

beforeEach(() => {
  document.body.innerHTML = MAIN;
  root = document.querySelector<HTMLElement>('[data-weather-report]')!;
});

describe('compared to usual', () => {
  it('compares with the same weekday once it has heard one', () => {
    const u = usualText(ALMANAC.normal!, NOW, TZ);
    expect(u.headline).toBe('busier than usual for a tuesday afternoon');
    expect(u.detail).toBe('468 new records a second over the last hour; usually about 396 at this hour (the last 2 tuesdays).');
  });

  it('falls back to the same hour on other days, and says when it will know more', () => {
    const u = usualText({ ...ALMANAC.normal!, weeks: { ...S(0, 0), windows: 0 }, days: { ...S(187_200 * 0.7), windows: 1 } }, NOW, TZ);
    expect(u.headline).toBe('much busier than usual for this time of day');
    expect(u.detail).toMatch(/\(yesterday\)\. in a week it'll compare with tuesdays\.$/);
  });

  it('says it is still learning in the first day', () => {
    const u = usualText({ historyStart: '2026-11-03T15:00:00.000Z', now: S(100_000), days: { ...S(0, 0), windows: 0 }, weeks: { ...S(0, 0), windows: 0 } }, NOW, TZ);
    expect(u.headline).toBe('the station is still learning what usual looks like');
    expect(u.detail).toMatch(/^it's been listening for 3 hours\./);
  });

  it('names parts of the day', () => {
    expect([6, 13, 18, 23, 2].map(daypart)).toEqual(['morning', 'afternoon', 'evening', 'night', 'night']);
  });
});

describe('today so far', () => {
  it("shows the high, the low and the totals, in the reader's time", () => {
    renderToday(root.querySelector('[data-a-today]')!, ALMANAC, NOW, TZ);
    expect(text('[data-a-high]')).toBe('642');
    expect(text('[data-a-high-at]')).toBe('high at 3:14 pm');
    expect(text('[data-a-low]')).toBe('263');
    expect(text('[data-a-low-at]')).toBe('low at 4:02 am');
    expect(text('[data-a-total]')).toBe('16.0 million');
    expect(text('[data-a-else-share]')).toBe('0.33%');
    expect(text('[data-a-else-total]')).toBe('52,000 new records');
    expect(text('[data-a-usual]')).toBe('busier than usual for a tuesday afternoon');
  });

  it('puts the last hour on the range between the low and the high, and says it in words', () => {
    renderToday(root.querySelector('[data-a-today]')!, ALMANAC, NOW, TZ);
    // 468 a second, between 262.9 and 642.2
    expect(text('[data-a-now]')).toBe('last hour 468');
    expect(root.querySelector<HTMLElement>('[data-a-now]')!.hidden).toBe(false);
    expect(root.querySelector<HTMLElement>('[data-a-range]')!.style.getPropertyValue('--at')).toBe('0.541');
    expect(text('[data-a-range-said]')).toBe("today's low was 263 new records a second, at 4:02 am, and the high 642, at 3:14 pm. the last hour averaged 468.");
  });

  it('leaves the dot off until it has a low and a high', () => {
    renderToday(root.querySelector('[data-a-today]')!, { ...ALMANAC, today: { ...ALMANAC.today!, high: null, low: null } }, NOW, TZ);
    expect(text('[data-a-high]')).toBe('–');
    expect(text('[data-a-low-at]')).toBe('low');
    expect(root.querySelector<HTMLElement>('[data-a-now]')!.hidden).toBe(true);
    expect(root.querySelector<HTMLElement>('[data-a-now-dot]')!.hidden).toBe(true);
    expect(text('[data-a-range-said]')).toBe('no whole minute heard yet today.');
  });

  it('turns the barometer to the last hour against usual', () => {
    const tile = root.querySelector<HTMLElement>('[data-a-today]')!;
    renderToday(tile, ALMANAC, NOW, TZ);
    const gauge = tile.querySelector<HTMLElement>('[data-a-gauge]')!;
    expect(gauge.dataset.state).toBe('ready');
    expect(gauge.querySelectorAll('.weather-gauge__zone')).toHaveLength(5);
    // 468 over 396 is 18% busier: right of usual, short of "much busier"
    expect(gauge.querySelector('.weather-gauge__change')!.textContent).toBe('+18%');
    const turn = parseFloat(gauge.style.getPropertyValue('--turn'));
    expect(turn).toBeGreaterThan((gaugeAt(USUAL_EDGES[2]) - 0.5) * 180);
    expect(turn).toBeLessThan((gaugeAt(USUAL_EDGES[3]) - 0.5) * 180);
    // drawn once: another reading only moves the needle
    renderToday(tile, ALMANAC, NOW, TZ);
    expect(gauge.querySelectorAll('svg')).toHaveLength(1);
  });

  it('keeps the barometer still while it learns what usual looks like', () => {
    const tile = root.querySelector<HTMLElement>('[data-a-today]')!;
    renderToday(tile, { ...ALMANAC, normal: { ...ALMANAC.normal!, days: { ...S(0, 0), windows: 0 }, weeks: { ...S(0, 0), windows: 0 } } }, NOW, TZ);
    const gauge = tile.querySelector<HTMLElement>('[data-a-gauge]')!;
    expect(gauge.dataset.state).toBe('learning');
    expect(gauge.querySelector('.weather-gauge__change')!.textContent).toBe('');
  });

  it('spaces the barometer evenly either side of usual', () => {
    expect(gaugeAt(1)).toBe(0.5);
    expect(gaugeAt(2)).toBe(1);
    expect(gaugeAt(0.5)).toBe(0);
    expect(gaugeAt(0.1)).toBe(0);
    expect(gaugeAt(0)).toBe(0);
    expect(gaugeAt(1.25) - 0.5).toBeCloseTo(0.5 - gaugeAt(0.8), 5);
    expect(changeText(1.184)).toBe('+18%');
    expect(changeText(0.93)).toBe('−7%');
    expect(changeText(1.001)).toBe('±0%');
    expect(rangeAt(5, 0, 10)).toBe(0.5);
    expect(rangeAt(20, 0, 10)).toBe(1);
    expect(rangeAt(7, 7, 7)).toBe(0.5);
  });

  it('words big numbers and lengths of time', () => {
    expect(bigNumber(171_986)).toBe('171,986');
    expect(bigNumber(1_592_941)).toBe('1.6 million');
    expect(roughly(3 * 86_400_000 + 5)).toBe('3 days');
    expect(roughly(59_000)).toBe('under a minute');
    expect(hourWords(0)).toBe('12 am');
    expect(hourWords(15)).toBe('3 pm');
  });
});

describe('new in the atmosphere', () => {
  it('lists apps heard for the first time as a cloud, each a link to its lexicons in aturi', () => {
    renderNewApps(root.querySelector('[data-a-new]')!, ALMANAC, NOW, TZ);
    expect(text('[data-a-new-lede]')).toBe('one app blew in for the first time in the last 24 hours.');
    const link = root.querySelector<HTMLAnchorElement>('[data-a-new-list] li a')!;
    expect(link.querySelector('.weather-new__domain')!.textContent).toBe('mu.social');
    expect(link.href).toBe('https://aturi.to/explore/lexicons/group/social.mu');
    expect(link.target).toBe('_blank');
    expect(link.rel).toBe('noopener');
    // the hover card's details, in words for screen readers too
    expect(link.dataset.heard).toBe('first heard at 11:46 am · 4 records');
    expect(link.textContent).toBe('mu.social, first heard at 11:46 am · 4 records: social.mu.newsFeedPrefs. opens aturi in a new tab');
    expect(root.querySelector<HTMLElement>('[data-a-new-note]')!.hidden).toBe(false);
  });

  it('sizes names by their records, biggest for the busiest', () => {
    const app = (domain: string, creates: number) => ({ domain, firstSeen: '2026-11-03T16:46:00.000Z', creates, collections: [] });
    renderNewApps(root.querySelector('[data-a-new]')!, { ...ALMANAC, newApps: { ...ALMANAC.newApps!, apps: [app('a.one', 1), app('b.two', 10), app('c.three', 100)] } }, NOW, TZ);
    const sizes = [...root.querySelectorAll<HTMLElement>('[data-a-new-list] li')].map((li) => li.style.getPropertyValue('--w'));
    expect(sizes).toEqual(['0.00', '0.50', '1.00']);
  });

  it('reads an app\'s namespace off its domain', () => {
    expect(aturiFor('mado.blue')).toBe('https://aturi.to/explore/lexicons/group/blue.mado');
  });

  it('says it is warming up during the first week', () => {
    renderNewApps(root.querySelector('[data-a-new]')!, { ...ALMANAC, newApps: { ...ALMANAC.newApps!, warmingUp: true, apps: [] } }, Date.parse('2026-10-24T16:50:00.000Z'), TZ);
    expect(text('[data-a-new-lede]')).toMatch(/after a week of listening it can tell a new app from a quiet one: 3 days to go\./);
    expect(root.querySelectorAll('[data-a-new-list] li')).toHaveLength(0);
    expect(root.querySelector<HTMLElement>('[data-a-new-note]')!.hidden).toBe(true);
  });

  it('puts app names on the page as text, never markup', () => {
    renderNewApps(root.querySelector('[data-a-new]')!, { ...ALMANAC, newApps: { ...ALMANAC.newApps!, apps: [{ domain: 'x.y', firstSeen: '2026-11-03T16:46:00.000Z', creates: 1, collections: ['<img src=x>'] }] } }, NOW, TZ);
    expect(root.querySelector('[data-a-new-list] img')).toBeNull();
  });
});

describe('when the sky is busiest', () => {
  it('colours every hour of the week it has heard enough of, and marks now', () => {
    renderHeatmap(root.querySelector('[data-a-heat]')!, ALMANAC, NOW, TZ);
    const rows = root.querySelectorAll('[data-a-heat-grid] tbody tr');
    expect(rows).toHaveLength(7);
    const tue1pm = rows[1]!.querySelectorAll('td')[13]!;
    expect(tue1pm.className).toContain('weather-heat__cell--5');
    expect(tue1pm.className).toContain('weather-heat__cell--now');
    expect(tue1pm.title).toBe('tuesdays at 1 pm: 520 new records a second');
    expect(rows[2]!.querySelectorAll('td')[3]!.className).toContain('--empty');
    expect(text('[data-a-heat-lede]')).toBe('busiest on tuesdays around 1 pm, quietest on sundays around 5 am.');
    expect(root.querySelector('[data-a-heat-grid] caption')).not.toBeNull();
  });

  it('waits a few weeks before naming the busiest hour', () => {
    renderHeatmap(root.querySelector('[data-a-heat]')!, { ...ALMANAC, heatmap: { ...ALMANAC.heatmap!, seconds: 2 * 86_400 } }, NOW, TZ);
    expect(text('[data-a-heat-lede]')).toBe("filling in: 2 of the week's 168 hours heard so far. the pattern settles after about 3 weeks of listening (2 days in).");
  });

  it('steps rates between the quietest and busiest hours', () => {
    const s = summarizeHeat(ALMANAC.heatmap!);
    expect([s.min, s.max, s.heard]).toEqual([300, 520, 2]);
    expect(heatStep(300, 300, 520)).toBe(1);
    expect(heatStep(520, 300, 520)).toBe(5);
    expect(heatStep(410, 300, 520)).toBe(3);
    expect(heatStep(40, 40, 40)).toBe(3);
  });
});

describe('reading the almanac', () => {
  it('keeps the parts that check out', async () => {
    const answer = (body: unknown, status = 200) => (async () => Response.json(body, { status })) as typeof fetch;
    expect(await fetchAlmanac(TZ, answer(ALMANAC))).toEqual(ALMANAC);
    const odd = readAlmanac({ ...ALMANAC, today: { start: 'x' }, newApps: { ...ALMANAC.newApps, apps: [{ domain: '<b>', firstSeen: 'x' }] } })!;
    expect(odd.today).toBeUndefined();
    expect(odd.newApps!.apps).toEqual([]);
    expect(await fetchAlmanac(TZ, answer({ error: 'unavailable' }, 503))).toBeNull();
  });
});

describe('rising and falling apps', () => {
  const compare = { seconds: 3600, prevSeconds: 1800, lagMs: 86_400_000 };
  it('compares rates, since the station may have heard more of one window', () => {
    // 600 in an hour against 200 in half an hour: 0.167/s against 0.111/s
    expect(appChange({ domain: 'a.b', creates: 600, prevCreates: 200, collections: [] }, compare, 'the day before')).toEqual({ text: '↑ 50%', words: 'up 50% on the day before', trend: 'up' });
    expect(appChange({ domain: 'a.b', creates: 100, prevCreates: 200, collections: [] }, compare, 'the day before')).toMatchObject({ text: '↓ 75%', trend: 'down' });
    expect(appChange({ domain: 'a.b', creates: 400, prevCreates: 200, collections: [] }, compare, 'the day before')).toMatchObject({ text: '→', trend: 'steady' });
    expect(appChange({ domain: 'a.b', creates: 5, prevCreates: 0, collections: [] }, compare, 'the day before')).toMatchObject({ text: 'new', trend: 'new' });
  });

  it('says nothing when the earlier window is too thin, or missing', () => {
    expect(appChange({ domain: 'a.b', creates: 5, prevCreates: 1, collections: [] }, { ...compare, prevSeconds: 600 }, 'x')).toBeNull();
    expect(appChange({ domain: 'a.b', creates: 5, collections: [] }, compare, 'x')).toBeNull();
    expect(appChange({ domain: 'a.b', creates: 5, prevCreates: 1, collections: [] }, undefined, 'x')).toBeNull();
  });
});

describe('the mix against usual', () => {
  it('mentions a more (or less) mixed sky when both sides have enough to say', () => {
    const base = { ...S(158_400 * 2, 7200), windows: 2 };
    const mixed = usualText({ ...ALMANAC.normal!, now: { ...S(187_200), elsewhere: 15_000 }, weeks: base }, NOW, TZ);
    expect(mixed.detail).toMatch(/ a more mixed sky than usual, too\.$/);
    const plain = usualText({ ...ALMANAC.normal!, now: { ...S(187_200), elsewhere: 2000 }, weeks: base }, NOW, TZ);
    expect(plain.detail).toMatch(/ a little less mixed than usual\.$/);
  });
});

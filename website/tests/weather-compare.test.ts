// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { lagFor, RANGES } from '../server/weather-history.js';
import { stretches, versusOf } from '../server/weather-span.js';
import { dockParts } from '../src/scripts/weather-dock.js';
import { bindLens, compareOf, createLens, earlierWords, LENS_KEY } from '../src/scripts/weather-lens.js';
import { fetchHistory, skyOfHistory, type History } from '../src/scripts/weather-page.js';
import { changesOf, fetchSpan, spanNote, type Figures } from '../src/scripts/weather-span.js';

// What every arrow compares with: the stretch right before, or the same stretch a cycle ago.

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const PAGE = readFileSync(resolve(process.cwd(), 'weather/index.html'), 'utf8');

describe('the endpoints: the stretch before, or a cycle ago', () => {
  const now = Date.parse('2026-11-12T16:25:30Z');

  it('sets the last hour against the same hour yesterday, and the last 24 against the same 24 a week ago', () => {
    const hour = stretches('hour', now, 'cycle');
    expect(hour.before).toEqual([hour.now[0] - DAY, hour.now[1] - DAY]);
    const day = stretches('day', now, 'cycle');
    expect(day.before).toEqual([day.now[0] - 7 * DAY, day.now[1] - 7 * DAY]);
    // the default is the stretch right before
    const before = stretches('hour', now);
    expect(before.before[1]).toBe(before.now[0]);
  });

  it('has no cycle for a week or 30 days: the week before already is one', () => {
    expect(versusOf('cycle', 'week')).toBe('before');
    expect(versusOf('cycle', 'month')).toBe('before');
    expect(versusOf('cycle', 'minute')).toBe('cycle');
    expect(versusOf('sideways', 'hour')).toBe('before');
    expect(lagFor('hour', 'cycle')).toBe(DAY);
    expect(lagFor('day', 'cycle')).toBe(7 * DAY);
    expect(lagFor('week', 'cycle')).toBe(RANGES.week.lagMs);
    expect(lagFor('hour', null)).toBe(RANGES.hour.lagMs);
  });
});

describe('the page: the lens, the dock, and the words', () => {
  beforeEach(() => localStorage.removeItem(LENS_KEY));
  afterEach(() => history.replaceState(null, '', '/'));

  it('only makes a cycle comparison where the window has one, and keeps the choice for when it comes back', () => {
    expect(compareOf({ window: 'hour', compare: 'cycle' })).toBe('cycle');
    expect(compareOf({ window: 'week', compare: 'cycle' })).toBe('before');
    expect(earlierWords('hour', 'cycle')).toBe('the same hour yesterday');
    expect(earlierWords('day', 'cycle')).toBe('the same 24 hours last week');
    expect(earlierWords('month', 'cycle')).toBe('the 30 days before');
  });

  it("names each choice for the window, hides it where there's no cycle, and the strip says it when it isn't the usual", () => {
    const root = document.createElement('div');
    root.innerHTML = PAGE.slice(PAGE.indexOf('<div class="weather-dock__panel"'), PAGE.indexOf('<button type="button" class="weather-dock__strip"'));
    const lens = createLens('?vs=cycle');
    bindLens(root, lens);
    const [before, cycle] = [...root.querySelectorAll<HTMLButtonElement>('[data-lens-compare]')];
    const group = root.querySelector<HTMLElement>('[data-lens-compare-group]')!;
    expect([before!.textContent, cycle!.textContent]).toEqual(['hour before', 'yesterday']);
    expect(cycle!.getAttribute('aria-pressed')).toBe('true');
    expect(cycle!.getAttribute('aria-label')).toBe('compare with the same hour yesterday');
    expect(dockParts(root, lens.get()).map(([, w]) => w)).toEqual(['1h', 'accounts', 'vs yesterday']);
    lens.set({ window: 'day' });
    expect([before!.textContent, cycle!.textContent]).toEqual(['day before', 'last week']);
    lens.set({ window: 'week' });
    expect(group.hidden).toBe(true);
    expect(dockParts(root, lens.get()).map(([, w]) => w)).toEqual(['7d', 'accounts']);
    // back to an hour, the cycle's still chosen
    lens.set({ window: 'hour' });
    expect(group.hidden).toBe(false);
    expect(cycle!.getAttribute('aria-pressed')).toBe('true');
    before!.click();
    expect(lens.get().compare).toBe('before');
  });

  it('asks the endpoints for a cycle only when it means one', async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => (urls.push(url), { ok: false, json: async () => ({}) })) as unknown as typeof fetch;
    await fetchHistory('hour', fetchImpl, 'cycle');
    await fetchHistory('hour', fetchImpl);
    await fetchSpan('day', fetchImpl, 'cycle');
    expect(urls).toEqual(['/api/weather-history?range=hour&vs=cycle', '/api/weather-history?range=hour', '/api/weather-span?span=day&vs=cycle']);
  });

  it('words every arrow with what it compares with', () => {
    const h = { range: 'hour', vs: 'cycle', points: [], total: { t: '2026-11-12T16:00:00Z', seconds: 3600, creates: 1, bluesky: 1, elsewhere: 0, posts: 0, likes: 0, reposts: 0, follows: 0, updates: 0, deletes: 0, identity: 0, account: 0 } } as unknown as History;
    expect(skyOfHistory(h).earlier).toBe('the same hour yesterday');
    expect(skyOfHistory({ ...h, vs: undefined }).earlier).toBe('the hour before');
    const f = (posts: number): Figures => ({ seconds: 3600, posts, gust: null, humidity: null, apps: null, heard: 0, active: null, activeSeconds: 0, events: null }) as unknown as Figures;
    expect(changesOf(f(60), f(50), 'hour', 'cycle').posts?.words).toBe('up 20% on the same hour yesterday');
    expect(spanNote('hour', f(60), f(50), false, 'cycle')).toBe('arrows compare with the same hour yesterday.');
  });
});

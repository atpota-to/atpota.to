import { describe, expect, it } from 'vitest';
import * as api from '../api/weather-forecast.js';
import {
  CACHE,
  center,
  createForecastHandlers,
  fit,
  forecast,
  FORECAST_HOURS,
  hoursPath,
  HISTORY_MS,
  median,
  MIN_NOW_SECONDS,
  MIN_SECONDS,
  seeded,
  skillOf,
  SKILL_LEAD,
  sunEvents,
  toObs,
  type Obs,
} from '../server/weather-forecast.js';

// /api/weather-forecast against a made-up sky: a day that wakes at 8 and settles at 20 (UTC),
// days that run a little busy or quiet for a few hours at a time, and some noise.

const HOUR = 3_600_000;
const NOW = Date.parse('2026-11-03T17:20:00.000Z');
const CURRENT = Math.floor(NOW / HOUR) * HOUR;

/** ln(new records a second) usually at the hour starting t: 450 a second on average, busiest at 14:00. */
const usualAt = (t: number) => Math.log(450) + 0.3 * Math.sin((2 * Math.PI * (new Date(t).getUTCHours() + 0.5 - 8)) / 24);

/** `days` of hours up to the one going on at NOW (part heard), each running `phi` of the hour before's difference. */
function sky(days: number, phi = 0.6, seed = 7): Array<{ hour: string; seconds_covered: number; creates: number }> {
  const random = seeded(seed);
  const normal = () => Math.sqrt(-2 * Math.log(random() || 1e-9)) * Math.cos(2 * Math.PI * random());
  const rows = [];
  let x = 0;
  for (let t = CURRENT - days * 24 * HOUR; t <= CURRENT; t += HOUR) {
    x = phi * x + 0.05 * normal();
    const seconds = t === CURRENT ? 1200 : 3600;
    rows.push({ hour: new Date(t).toISOString(), seconds_covered: seconds, creates: Math.round(Math.exp(usualAt(t) + x) * seconds) });
  }
  return rows;
}

function supabase(rows: unknown, ok = true) {
  const asked: string[] = [];
  const fetch = (async (url: string) => {
    asked.push(url);
    return ok ? Response.json(rows) : new Response('nope', { status: 500 });
  }) as typeof globalThis.fetch;
  return { asked, fetch };
}

const quiet = () => {};
const get = (h: ReturnType<typeof createForecastHandlers>) => h.GET(new Request('https://atpota.to/api/weather-forecast'));

describe('the forecast model', () => {
  it('reads hours heard well enough, and the hour going on now from less', () => {
    const obs = toObs(
      [
        { hour: '2026-11-03T15:00:00+00:00', seconds_covered: 3600, creates: 3600 * 450 },
        { hour: '2026-11-03T14:00:00+00:00', seconds_covered: MIN_SECONDS - 1, creates: 900_000 },
        { hour: '2026-11-03T16:00:00+00:00', seconds_covered: '3000', creates: '1350000' },
        { hour: '2026-11-03T17:00:00+00:00', seconds_covered: MIN_NOW_SECONDS, creates: 270_000 },
        { hour: 'nope', seconds_covered: 3600, creates: 1 },
        { hour: '2026-11-03T13:00:00+00:00', seconds_covered: 3600, creates: 0 },
        null,
      ],
      NOW,
    );
    expect(obs.map((o) => new Date(o.t).toISOString())).toEqual(['2026-11-03T15:00:00.000Z', '2026-11-03T16:00:00.000Z', '2026-11-03T17:00:00.000Z']);
    expect(Math.exp(obs[0]!.v)).toBeCloseTo(450);
    expect(obs[2]!.seconds).toBe(MIN_NOW_SECONDS);
    expect(toObs('nope', NOW)).toEqual([]);
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
  });

  it("won't forecast until each hour of the day has been heard on a couple of days", () => {
    expect(fit(toObs(sky(1), NOW), NOW)).toBeNull();
    expect(fit(toObs(sky(3), NOW), NOW)).not.toBeNull();
    // nor from hours that have gone quiet
    expect(fit(toObs(sky(10), NOW), NOW + 5 * HOUR)).toBeNull();
  });

  it("learns the usual day, and how long a busy spell lasts", () => {
    const m = fit(toObs(sky(21), NOW), NOW)!;
    for (const h of [2, 8, 14, 20]) {
      const t = Date.UTC(2026, 10, 4, h);
      expect(Math.abs(m.usual(t)! + m.level - usualAt(t)), `hour ${h}`).toBeLessThan(0.08);
    }
    expect(m.phi).toBeGreaterThan(0.35);
    expect(m.phi).toBeLessThanOrEqual(0.95);
    expect(m.start.t).toBe(CURRENT);
  });

  it('eases a busy hour back toward usual, a little less each hour ahead', () => {
    const rows = sky(21);
    // the last two hours ran 40% busy
    for (const r of rows.slice(-2)) r.creates = Math.round(r.creates * 1.4);
    const m = fit(toObs(rows, NOW), NOW)!;
    expect(m.away).toBeGreaterThan(0.2);
    const offs = [1, 2, 3, 6].map((k) => center(m, k)! - m.usual(m.start.t + k * HOUR)! - m.level);
    expect(offs[0]).toBeGreaterThan(0);
    expect(offs).toEqual([...offs].sort((a, b) => b - a));
    expect(offs[3]).toBeLessThan(offs[0]! / 4);
  });

  it('forecasts the next hours with a likely range and the chance of a gust or a storm, the same every time', () => {
    const m = fit(toObs(sky(21), NOW), NOW)!;
    const hours = forecast(m);
    expect(hours).toHaveLength(FORECAST_HOURS);
    hours.forEach((h, i) => {
      expect(Date.parse(h.t)).toBe(CURRENT + (i + 1) * HOUR);
      expect(h.low).toBeLessThanOrEqual(h.perSecond);
      expect(h.high).toBeGreaterThanOrEqual(h.perSecond);
      expect(h.chance.storm).toBeLessThanOrEqual(h.chance.gusts);
      expect(h.chance.gusts).toBeGreaterThanOrEqual(0);
      expect(h.chance.gusts).toBeLessThanOrEqual(1);
    });
    // 14:00 to 15:00 tomorrow is the busiest the made-up day gets, and still under the gusty line
    expect(hours.every((h) => h.condition !== 'stormy')).toBe(true);
    expect(forecast(m)).toEqual(hours);
    // a sky running hot gets a fair chance of a storm
    const hot = { ...m, level: m.level + Math.log(1.35) };
    expect(Math.max(...forecast(hot).map((h) => h.chance.storm))).toBeGreaterThan(0.25);
  });

  it("finds the network's sunrise and sunset in the usual day", () => {
    const m = fit(toObs(sky(21), NOW), NOW)!;
    const events = sunEvents(m);
    expect(events.length).toBeGreaterThanOrEqual(4);
    for (const e of events) {
      const d = new Date(e.at);
      const minutes = d.getUTCHours() * 60 + d.getUTCMinutes();
      const expected = e.kind === 'wakes' ? 8 * 60 : 20 * 60;
      expect(Math.abs(minutes - expected), e.at).toBeLessThanOrEqual(40);
      expect(d.getUTCMinutes() % 5).toBe(0);
    }
    // wakes and settles take turns
    expect(events.every((e, i) => i === 0 || e.kind !== events[i - 1]!.kind)).toBe(true);
  });

  it('checks itself against the hours since, and beats usual alone when busy spells last', () => {
    const obs: Obs[] = toObs(sky(21), NOW);
    const skill = skillOf(obs, NOW)!;
    expect(skill.lead).toBe(SKILL_LEAD);
    expect(skill.hours).toBeGreaterThan(48);
    expect(skill.error).toBeLessThan(skill.usualError);
    // with no memory in the sky it can't do better than usual by much
    const flat = skillOf(toObs(sky(21, 0, 3), NOW), NOW)!;
    expect(flat.error).toBeGreaterThan(skill.error);
    expect(skillOf(toObs(sky(2), NOW), NOW)).toBeNull();
  });
});

describe('/api/weather-forecast', () => {
  it('reads four weeks of hours from atmosphere_hour', () => {
    const path = hoursPath(NOW);
    expect(path).toMatch(/^atmosphere_hour\?/);
    const q = new URLSearchParams(path.split('?')[1]);
    expect(q.get('select')).toBe('hour,seconds_covered,creates');
    expect(q.get('hour')).toBe(`gte.${new Date(NOW - HISTORY_MS).toISOString()}`);
  });

  it('answers the forecast, cached for a few minutes', async () => {
    const db = supabase(sky(21));
    const res = await get(createForecastHandlers({ fetch: db.fetch, now: () => NOW, env: () => ({}), log: quiet }));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe(CACHE);
    expect(db.asked[0]).toContain('/rest/v1/atmosphere_hour?');
    const body = (await res.json()) as Record<string, any>;
    expect(body.madeAt).toBe(new Date(NOW).toISOString());
    expect(body.basis.days).toBeGreaterThanOrEqual(13);
    expect(body.now.t).toBe(new Date(CURRENT).toISOString());
    expect(body.now.seconds).toBe(1200);
    expect(body.hours).toHaveLength(FORECAST_HOURS);
    expect(body.sun.length).toBeGreaterThan(0);
    expect(body.skill.lead).toBe(SKILL_LEAD);
    expect(body.learning).toBeUndefined();
  });

  it("says it's still learning without enough hours", async () => {
    const res = await get(createForecastHandlers({ fetch: supabase(sky(1)).fetch, now: () => NOW, env: () => ({}), log: quiet }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.learning).toBe(true);
    expect(body.hours).toBeUndefined();
  });

  it("answers 503 when Supabase can't be read, and 405 to anything but GET or HEAD", async () => {
    const logged: string[] = [];
    const res = await get(createForecastHandlers({ fetch: supabase([], false).fetch, now: () => NOW, env: () => ({}), log: (f) => logged.push(f.event) }));
    expect(res.status).toBe(503);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(logged).toEqual(['forecast_error']);
    const odd = await get(createForecastHandlers({ fetch: supabase({ not: 'rows' }).fetch, now: () => NOW, env: () => ({}), log: quiet }));
    expect(odd.status).toBe(503);
    const post = await api.POST(new Request('https://atpota.to/api/weather-forecast', { method: 'POST' }));
    expect(post.status).toBe(405);
  });
});

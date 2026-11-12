// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { activeShareWords, batchWords, destinationsOf, identityWhen, utcDayStartWords, originsOf, originsSpan, growingWords, hostBars, independentOf, identityView, identityViewWords, livelyBars, oddsWords, shareHeadline, hostRange, identityDayWords, newHostsWords, renderHostTrends, renderIdentities, signed, smogOf, sumDays, toHostHistory, type HostHistory, type IdentityDay } from '../src/scripts/weather-hosts.js';
import { fetchHistory, renderBars, renderHostCensus, topTenShare } from '../src/scripts/weather-page.js';
import { HOSTING_SCALE, HOSTING_SCALE_MAX, hostingLevelOf, hostingPosition } from '../src/scripts/weather.js';
import { HOSTING_LEVELS, hostingLevel } from '../server/atmosphere.js';

// Where accounts live, over time: the hosts tile's charts and lists.

const PAGE = readFileSync(resolve(process.cwd(), 'weather/index.html'), 'utf8');
const MAIN = PAGE.slice(PAGE.indexOf('<main'), PAGE.indexOf('</main>') + '</main>'.length);
const NOW = Date.parse('2026-10-29T12:00:00.000Z');

const point = (t: string, active: number, index = 7.48) => ({ t, active, bluesky: 90, independent: active - 90, writing: 700, accountsBluesky: 23767508, accountsIndependent: 363866, share: 1.51, spread: 24.54, index });

const HOSTS: HostHistory = {
  bucket: 'hour',
  since: '2026-10-24',
  points: [point('2026-10-22T13:00:00.000Z', 1887), point('2026-10-29T11:00:00.000Z', 1902, 7.6)],
  newHosts: 7,
  new: [
    { hostname: 'fresh.example', accounts: 40, people: 31, first: '2026-10-25' },
    { hostname: 'tiny.example', accounts: 2, people: 2, first: '2026-10-28' },
  ],
  // the relay's count went up 534, but 312 people arrived: the rest came some other way
  growing: [{ hostname: 'blacksky.app', accounts: 42900, prevAccounts: 42366, people: 312 }],
  daily: [
    { day: '2026-10-24', active: 1887, change: null, joined: null, left: null, estimated: true },
    { day: '2026-10-25', active: 1890, change: 3, joined: 5, left: 2 },
    { day: '2026-10-26', active: 1884, change: -6, joined: 1, left: 7 },
    { day: '2026-10-29', active: 1886, change: 0, joined: 0, left: 0 },
  ],
  identities: [],
};

const idDay = (day: string, extra: Partial<IdentityDay> = {}): IdentityDay => ({ day, ops: 170066, createdBluesky: 9946, createdIndependent: 4383, createdUnlisted: 150845, createdCustomHandle: 122, createdBulk: 0, bulk: [], createdUnnamed: 0, createdScripted: 0, scripted: [], movedOut: 19, movedIn: 0, movedBetween: 1, deleted: 1, destinations: [], moves: [], ...extra });

let part: HTMLElement;
const bars = (list: HTMLElement, b: Parameters<typeof renderBars>[1]) => renderBars(list, b, undefined);

beforeEach(() => {
  document.body.innerHTML = MAIN;
  part = document.querySelector<HTMLElement>('[data-h-trends]')!;
});

describe('where accounts live, over time', () => {
  it('shows a day for now and the last hour, and the lens window otherwise', () => {
    expect(hostRange('now')).toBe('day');
    expect(hostRange('hour')).toBe('day');
    expect(hostRange('week')).toBe('week');
    expect(hostRange('month')).toBe('month');
  });

  it('checks the history answer, dropping hostnames that do not check out', () => {
    const h = toHostHistory({ ...HOSTS, new: [...HOSTS.new, { hostname: '<b>x</b>.com', accounts: 1, people: 1, first: '2026-10-28' }], points: [...HOSTS.points, { t: 'nope' }] })!;
    expect(h.new.map((x) => x.hostname)).toEqual(['fresh.example', 'tiny.example']);
    // a host without the people who arrived on it (an answer from before they were counted) isn't listed
    expect(toHostHistory({ ...HOSTS, growing: [{ hostname: 'goodmkt.id', accounts: 11022, prevAccounts: 20 }] })!.growing).toEqual([]);
    expect(h.points).toHaveLength(2);
    expect(toHostHistory({ bucket: 'fortnight', points: [], new: [], growing: [] })).toBeNull();
    expect(toHostHistory(null)).toBeNull();
  });

  it('reads them from the history feed alongside the rest', async () => {
    const body = { range: 'week', points: [], total: { t: '2026-10-29T12:00:00.000Z', seconds: 1, creates: 0, bluesky: 0, elsewhere: 0, posts: 0, likes: 0, reposts: 0, follows: 0, updates: 0, deletes: 0, identity: 0, account: 0 }, hosts: HOSTS };
    const h = await fetchHistory('week', (async () => Response.json(body)) as typeof fetch);
    expect(h?.hosts?.newHosts).toBe(7);
  });

  it('stays hidden with nothing kept yet', () => {
    renderHostTrends(part, undefined, 'day', bars, NOW);
    expect(part.hidden).toBe(true);
    renderHostTrends(part, { ...HOSTS, points: [] }, 'day', bars, NOW);
    expect(part.hidden).toBe(true);
  });

  it('draws the charts and lists the new and growing hosts', () => {
    renderHostTrends(part, HOSTS, 'week', bars, NOW);
    expect(part.hidden).toBe(false);
    expect(part.querySelector('[data-h-range]')!.textContent).toBe('the last 7 days');
    expect(part.querySelector('[data-h-chart="active"] svg')).not.toBeNull();
    expect(part.querySelector('[data-h-chart="index"] svg')).not.toBeNull();
    expect([...part.querySelectorAll('[data-h-new] .weather-bars__label')].map((el) => el.textContent)).toEqual(['fresh.example', 'tiny.example']);
    expect(part.querySelector('[data-h-new-note]')!.textContent).toBe('7 new independent hosts in the last 7 days, the 2 with the most people arriving.');
    expect([...part.querySelectorAll('[data-h-new] .weather-bars__value')].map((el) => el.textContent)).toEqual(['31', '2']);
    // the people who arrived, not the relay's count
    expect(part.querySelector('[data-h-growing] .weather-bars__value')!.textContent).toBe('+312');
    expect(part.querySelector('[data-h-growing-note]')!.textContent).toBe("people who signed up or moved in over the last 7 days. accounts made in bulk, and identities with no handle, don't count.");
    // the week reaches back before the station kept hosts
    const since = part.querySelector<HTMLElement>('[data-h-since]')!;
    expect(since.hidden).toBe(false);
    expect(since.textContent).toMatch(/^i started keeping track of hosts on october 24/);
  });

  it('hides the day by day table without days', () => {
    renderHostTrends(part, { ...HOSTS, daily: [] }, 'day', bars, NOW);
    expect(part.querySelector<HTMLElement>('[data-h-days-wrap]')!.hidden).toBe(true);
  });

  it('says who is active on independent hosts, charts it by day, and lists the liveliest hosts', () => {
    // nothing counted yet: all of it stays hidden
    renderHostTrends(part, HOSTS, 'week', bars, NOW);
    expect(part.querySelector<HTMLElement>('[data-h-active-share]')!.hidden).toBe(true);
    expect(part.querySelector('[data-h-chart="active-share"]')!.closest<HTMLElement>('.weather-chart-card')!.hidden).toBe(true);
    expect(part.querySelector<HTMLElement>('[data-h-lively-wrap]')!.hidden).toBe(true);
    const counted: HostHistory = {
      ...HOSTS,
      activeDaily: [
        { day: '2026-10-27', independent: 40_000, all: 1_300_000 },
        { day: '2026-10-28', independent: 42_000, all: 1_200_000 },
        { day: '2026-10-29', independent: 20_000, all: 600_000 },
      ],
      liveliest: { day: '2026-10-28', soFar: false, hosts: [{ hostname: 'blacksky.app', active: 9000, accounts: 42_900 }, { hostname: 'tiny.example', active: 3, accounts: null }] },
    };
    renderHostTrends(part, counted, 'week', bars, NOW);
    // the latest finished day (the 28th is yesterday), against the share of accounts living on them
    expect(part.querySelector('[data-h-active-share]')!.textContent).toBe("yesterday, 3.50% of everyone active wrote from an independent host (42,000 accounts), though only 1.51% of accounts live on one: they're busier than most.");
    expect(part.querySelector('[data-h-chart="active-share"]')!.closest<HTMLElement>('.weather-chart-card')!.hidden).toBe(false);
    expect(part.querySelector<HTMLElement>('[data-h-lively-wrap]')!.hidden).toBe(false);
    expect(part.querySelector('[data-h-lively-title]')!.textContent).toBe('liveliest yesterday');
    expect([...part.querySelectorAll('[data-h-lively] .weather-bars__label')].map((el) => el.textContent)).toEqual(['blacksky.app', 'tiny.example']);
    expect(livelyBars(counted.liveliest!.hosts)[0]).toMatchObject({ value: '9k active', sub: '21% of its 42.9k accounts' });
    expect(livelyBars(counted.liveliest!.hosts)[1]!.sub).toBeUndefined();
    // a day without everyone's count says nothing
    expect(activeShareWords({ ...HOSTS, activeDaily: [{ day: '2026-10-28', independent: 5, all: null }] }, NOW)).toBe('');
  });

  it('goes day by day in a table, newest first', () => {
    renderHostTrends(part, HOSTS, 'week', bars, NOW);
    expect(part.querySelector<HTMLElement>('[data-h-days-wrap]')!.hidden).toBe(false);
    const rows = [...part.querySelectorAll('[data-h-days] tbody tr')].map((tr) => [...tr.children].map((c) => c.textContent));
    expect(rows).toHaveLength(4);
    expect(rows[0]![0]).toMatch(/\(so far\)$/); // the 29th is today
    // today's gone quiet waits for the day to end: every host not heard from yet would count
    expect(rows[0]!.slice(1)).toEqual(['1,886', '0', '0', '–']);
    expect(rows[1]!.slice(1)).toEqual(['1,884', '−6', '+1', '−7']);
    expect(rows[3]!.slice(1)).toEqual(['1,887', '–', '–', '–']);
    expect(rows[3]![0]).toMatch(/ ≈$/); // estimated
    expect(rows[1]![0]).not.toMatch(/≈/);
    expect(part.querySelector('[data-h-days] tbody tr:nth-child(2) td:nth-of-type(2)')!.getAttribute('data-trend')).toBe('down');
  });

  it('reads the daily rows, dropping ones that do not check out', () => {
    const h = toHostHistory({ ...HOSTS, daily: [...HOSTS.daily, { day: 'soon', active: 1 }, { day: '2026-10-30', active: -1, change: 0, joined: 0, left: 0 }] })!;
    expect(h.daily).toHaveLength(4);
    expect(toHostHistory({ ...HOSTS, daily: undefined })!.daily).toEqual([]);
    expect([signed(3), signed(-2), signed(0), signed(null)]).toEqual(['+3', '−2', '0', '–']);
  });

  it('says so when nothing is new', () => {
    expect(newHostsWords({ ...HOSTS, newHosts: 0 }, 'day')).toBe('no new independent hosts in the last 24 hours.');
    expect(newHostsWords({ ...HOSTS, newHosts: 1 }, 'day')).toBe('1 new independent host in the last 24 hours.');
    // new hosts nobody arrived on (a git server's, say) are counted, not listed
    const knots: HostHistory = { ...HOSTS, newHosts: 56, new: [{ hostname: 'knot.example', accounts: 23, people: 0, first: '2026-10-29' }] };
    expect(newHostsWords(knots, 'day')).toBe('56 new independent hosts in the last 24 hours. nobody has signed up on one or moved there yet.');
    expect(newHostsWords({ ...knots, new: [...knots.new, { hostname: 'pds.example', accounts: 4, people: 3, first: '2026-10-29' }] }, 'day')).toBe('56 new independent hosts in the last 24 hours, the one with the most people arriving.');
    renderHostTrends(part, knots, 'day', bars, NOW);
    expect(part.querySelectorAll('[data-h-new] li')).toHaveLength(0);
    expect(hostBars(HOSTS.growing, true)).toEqual([{ label: 'blacksky.app', perSecond: 312, count: 312, value: '+312' }]);
    expect(growingWords({ ...HOSTS, growing: [] }, 'day')).toBe('nobody has signed up on or moved to an independent host over the last 24 hours yet.');
  });
});

describe('where the atmosphere lives: the identity tiles', () => {
  let report: HTMLElement;
  beforeEach(() => {
    report = document.querySelector<HTMLElement>('[data-weather-report]')!;
  });
  const text = (sel: string) => report.querySelector(sel)!.textContent;

  it('stays hidden without a day, and fills all three from the last one', () => {
    renderIdentities(report, [], NOW);
    expect(report.querySelector<HTMLElement>('[data-p-arrivals]')!.hidden).toBe(true);
    renderIdentities(report, [idDay('2026-10-28', { movedOut: 30, movedIn: 2 }), idDay('2026-10-29')], NOW);
    for (const sel of ['[data-p-arrivals]', '[data-p-winds]', '[data-p-smog]']) expect(report.querySelector<HTMLElement>(sel)!.hidden).toBe(false);
    expect(text('[data-p-day]')).toBe('today so far (utc)');
    expect(text('[data-p-signups]')).toBe('14,329');
    expect(text('[data-p-indep]')).toBe('4,383');
    expect(text('[data-p-own]')).toBe('31% started on an independent host, and 122 with a handle on their own domain.');
    expect(report.querySelector('[data-p-chart="arrivals"] svg')).not.toBeNull();
    expect(report.querySelector('[data-p-chart="winds"] svg')).not.toBeNull();
    // all three kinds of move, so the destinations (which take in moves between hosts) add up
    expect(text('[data-p-week]')).toBe('over the last 2 days: 49 accounts moved out of bluesky, 2 moved back, and 2 moved from one independent host to another.');
    expect(text('[data-p-smog-level]')).toBe('thick smog');
    // identities, not sign-ups: counted, and set against the arrivals
    expect(text('[data-p-smog-words]')).toMatch(/^today, [\d,]+ new identities pointed at hosts no relay carries: [\d,]+ for every new account above\. nobody sees what's on them, so they're not counted as sign-ups\.$/);
    expect(text('[data-p-deleted]')).toBe('today, 1 account deleted itself.');
  });

  it('heads the trends with the share off bluesky and which way it went', () => {
    const up = { ...HOSTS, points: [{ ...point('2026-10-22T13:00:00.000Z', 1887), share: 1.46, accountsIndependent: 361000 }, point('2026-10-29T11:00:00.000Z', 1902)] };
    // without the plc directory's days, the relay's count is all there is
    expect(shareHeadline({ ...up, identities: [] }, 'week', NOW)).toBe("1.51% of accounts live off bluesky's servers, up from 1.46% a week ago: +2,866 accounts on independent hosts.");
    // with them, the people who arrived: 7 days of 40 signing up and 5 moving in from bluesky
    const week = Array.from({ length: 7 }, (_, i) => idDay(`2026-10-${23 + i}`, { createdIndependent: 40, movedOut: 5 }));
    expect(shareHeadline({ ...up, identities: week }, 'week', NOW)).toBe("1.51% of accounts live off bluesky's servers, up from 1.46% a week ago. about 315 people signed up on independent hosts or moved to one. the relay counts 2,866 more accounts on them, most of them made by scripts or ones it hadn't counted before.");
    // close to the relay's count: just the people
    const busy = week.map((d) => ({ ...d, createdIndependent: 400 }));
    expect(shareHeadline({ ...up, identities: busy }, 'week', NOW)).toBe("1.51% of accounts live off bluesky's servers, up from 1.46% a week ago. about 2,835 people signed up on independent hosts or moved to one.");
    expect(shareHeadline({ ...HOSTS, points: [point('2026-10-29T11:00:00.000Z', 1902)] }, 'day')).toBe("1.51% of accounts live off bluesky's servers.");
    expect(shareHeadline({ ...HOSTS, points: [] }, 'day')).toBe('');
  });

  it('adds up the window\'s days: today so far, or the last 7 or 30', () => {
    // the 8th to the 29th: 22 days, the last today
    const days = Array.from({ length: 22 }, (_, i) => idDay(`2026-10-${String(i + 8).padStart(2, '0')}`, { createdBluesky: 1000, createdIndependent: 50, movedOut: 2, deleted: 1 }));
    expect(identityView(days, 'day', NOW).map((d) => d.day)).toEqual(['2026-10-29']);
    expect(identityView(days, 'week', NOW).map((d) => d.day)).toEqual(['2026-10-23', '2026-10-24', '2026-10-25', '2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29']);
    expect(identityView(days, 'month', NOW)).toHaveLength(22);
    expect(identityViewWords(identityView(days, 'week', NOW), 'week', NOW)).toBe('the last 7 days (utc)');
    // fewer days kept than the window: since the first
    expect(identityViewWords(identityView(days, 'month', NOW), 'month', NOW)).toBe('since oct 8 (utc)');
    // a missing day isn't made up from one before the window
    expect(identityView([idDay('2026-10-20'), idDay('2026-10-28')], 'week', NOW).map((d) => d.day)).toEqual(['2026-10-28']);

    renderIdentities(report, days, NOW, bars, 'week');
    expect(text('[data-p-day]')).toBe('the last 7 days (utc)');
    expect(text('[data-p-signups]')).toBe('7,350');
    expect(text('[data-p-indep]')).toBe('350');
    expect(text('[data-p-out]')).toBe('14');
    expect(text('[data-p-deleted]')).toBe('over the last 7 days, 7 accounts deleted themselves.');
    // the week says it all itself: no line against the last 7 days
    expect(report.querySelector<HTMLElement>('[data-p-odds]')!.hidden).toBe(true);
    expect(text('[data-p-week]')).toBe('');
    renderIdentities(report, days, NOW, bars, 'month');
    expect(text('[data-p-signups]')).toBe('23,100');
    expect(text('[data-p-day]')).toBe('since oct 8 (utc)');
    // and back: today so far, set against the week
    renderIdentities(report, days, NOW, bars, 'day');
    expect(text('[data-p-signups]')).toBe('1,050');
    expect(text('[data-p-day]')).toBe('today so far (utc)');
    expect(report.querySelector<HTMLElement>('[data-p-odds]')!.hidden).toBe(false);
  });

  it('counts new accounts made in bulk apart, out of the numbers and without a line of their own', () => {
    const goodmkt = { hostname: 'goodmkt.id', accounts: 4615, bursts: 2, seconds: 1929 };
    const batch = idDay('2026-10-29', { createdBluesky: 9905, createdIndependent: 5561, createdCustomHandle: 50, createdBulk: 4615, bulk: [goodmkt] });
    renderIdentities(report, [idDay('2026-10-28', { createdBluesky: 18395, createdIndependent: 840 }), batch], NOW);
    expect(text('[data-p-signups]')).toBe('10,851');
    expect(text('[data-p-indep]')).toBe('946');
    expect(text('[data-p-own]')).toBe('8.7% started on an independent host, and 50 with a handle on their own domain.');
    // the tile doesn't spell out what it left out
    expect(report.querySelector('[data-p-arrivals]')!.textContent).not.toMatch(/made in bulk|left out/);
    // the week's odds leave them out too
    expect(text('[data-p-odds]')).toBe('over the last 2 days, 5.9% did.');
    // the air quality counts identities on hosts no relay carries, never calling them sign-ups
    expect(text('[data-p-smog-words]')).toMatch(/^today, [\d,]+ new identities pointed at hosts no relay carries/);

    // identities with no handle are left out too, and the ones the trends call scripted
    expect(independentOf({ ...batch, createdUnnamed: 340 })).toBe(5561 - 4615 - 340);
    expect(independentOf({ ...batch, createdUnnamed: 340, createdScripted: 600 })).toBe(5561 - 4615 - 340 - 600);
    // over days, each host's add up
    const leftover = { hostname: 'goodmkt.id', accounts: 603, why: 'bulk' as const };
    const two = sumDays([{ ...batch, createdScripted: 603, scripted: [leftover] }, { ...idDay('2026-10-28'), createdScripted: 527, scripted: [{ ...leftover, accounts: 527 }] }])!;
    expect([two.createdScripted, two.scripted]).toEqual([1130, [{ hostname: 'goodmkt.id', accounts: 1130, why: 'bulk' }]]);
    // over a week, each day's runs add up by host
    const week = sumDays([batch, idDay('2026-10-28', { createdBulk: 3903, bulk: [{ hostname: 'goodmkt.id', accounts: 3903, bursts: 2, seconds: 13_080 }] })])!;
    expect([week.createdBulk, week.bulk]).toEqual([8518, [{ hostname: 'goodmkt.id', accounts: 8518, bursts: 4, seconds: 15_009 }]]);
  });

  it('keeps the chart back with only one day', () => {
    renderIdentities(report, [idDay('2026-10-29')], NOW);
    expect(report.querySelector<HTMLElement>('[data-p-arrivals-card]')!.hidden).toBe(true);
  });

  it('reads the air in words', () => {
    expect(smogOf(idDay('d', { createdUnlisted: 0 })).level).toBe('clear');
    expect(smogOf(idDay('d', { createdUnlisted: 2000 })).level).toBe('hazy');
    expect(smogOf(idDay('d', { createdBluesky: 0, createdIndependent: 0, createdUnlisted: 0 })).share).toBe(0);
    expect(identityDayWords('2026-10-28', NOW)).toBe('yesterday (utc)');
  });

  it('says how many new accounts start outside bluesky, and where movers went', () => {
    expect(oddsWords([idDay('2026-10-28', { createdBluesky: 900, createdIndependent: 100 }), idDay('2026-10-29', { createdBluesky: 1100, createdIndependent: 100 })])).toBe('over the last 2 days, 9.1% did.');
    expect(oddsWords([idDay('2026-10-29', { createdIndependent: 0 })])).toBe('');
    const went = destinationsOf([
      idDay('2026-10-28', { destinations: [{ hostname: 'eurosky.social', accounts: 3 }, { hostname: 'blacksky.app', accounts: 2 }] }),
      idDay('2026-10-29', { destinations: [{ hostname: 'blacksky.app', accounts: 4 }] }),
    ]);
    expect(went).toEqual([{ hostname: 'blacksky.app', accounts: 6 }, { hostname: 'eurosky.social', accounts: 3 }]);
  });

  it('lists where movers went, as hosts to tap, only when it knows', () => {
    const days = [idDay('2026-10-28'), idDay('2026-10-29', { destinations: [{ hostname: 'eurosky.social', accounts: 3 }] })];
    renderIdentities(report, days, NOW);
    // without bars to draw with, it stays hidden
    expect(report.querySelector<HTMLElement>('[data-p-dest-wrap]')!.hidden).toBe(true);
    renderIdentities(report, days, NOW, bars);
    expect(report.querySelector<HTMLElement>('[data-p-dest-wrap]')!.hidden).toBe(false);
    expect([...report.querySelectorAll('[data-p-dest] .weather-bars__label')].map((el) => el.textContent)).toEqual(['eurosky.social']);
    expect(report.querySelector('[data-p-dest]')!.hasAttribute('data-host-list')).toBe(true);
    renderIdentities(report, [idDay('2026-10-29')], NOW, bars);
    expect(report.querySelector<HTMLElement>('[data-p-dest-wrap]')!.hidden).toBe(true);
  });

  it('lists the independent hosts movers left, when the station kept where they came from', () => {
    const days = [
      idDay('2026-10-28', { movedOut: 3, movedBetween: 2, moves: [{ from: 'bluesky', to: 'eurosky.social', accounts: 3 }, { from: 'pds.tophhie.cloud', to: 'blacksky.app', accounts: 2 }] }),
      idDay('2026-10-29', { movedOut: 4, movedIn: 1, movedBetween: 1, moves: [{ from: 'bluesky', to: 'blacksky.app', accounts: 4 }, { from: 'pds.tophhie.cloud', to: 'bluesky', accounts: 1 }, { from: 'pds.wsocial.network', to: 'eurosky.social', accounts: 1 }] }),
    ];
    // movers out of bluesky's own hosts aren't in it: they're the tile's first number
    expect(originsOf(days)).toEqual([{ hostname: 'pds.tophhie.cloud', accounts: 3 }, { hostname: 'pds.wsocial.network', accounts: 1 }]);
    expect(originsSpan(days)).toBe('over the last 2 days');
    expect(originsSpan(days.slice(-1))).toBe('today');
    // a day with moves and no pairs is from before they were kept: the list only covers from the first day that has them
    expect(originsSpan([idDay('2026-10-27', { movedOut: 9 }), ...days])).toBe('since oct 28');
    // but a day nobody moved doesn't cut it short
    expect(originsSpan([idDay('2026-10-27', { movedOut: 0, movedIn: 0, movedBetween: 0 }), ...days])).toBe('over the last 3 days');
    expect(originsSpan([idDay('2026-10-29')])).toBe('');
    // the week's days added up carry every pair
    expect(sumDays(days)!.moves[0]).toEqual({ from: 'bluesky', to: 'blacksky.app', accounts: 4 });
    expect(sumDays(days)!.moves).toHaveLength(5);

    renderIdentities(report, days, NOW);
    const wrap = report.querySelector<HTMLElement>('[data-p-from-wrap]')!;
    // without bars to draw with, it stays hidden
    expect(wrap.hidden).toBe(true);
    renderIdentities(report, days, NOW, bars);
    expect(wrap.hidden).toBe(false);
    expect([...report.querySelectorAll('[data-p-from] .weather-bars__label')].map((el) => el.textContent)).toEqual(['pds.tophhie.cloud', 'pds.wsocial.network']);
    expect(report.querySelector('[data-p-from-note]')!.textContent).toBe('accounts that left independent hosts, for bluesky or another host. tap one to see where they went.');
    // its window in its heading, since it can be shorter than the tile's
    expect(report.querySelector('[data-p-from-span]')!.textContent).toBe('over the last 2 days');
    // everyone came off bluesky's hosts, or the station didn't keep it: nothing to list
    renderIdentities(report, [idDay('2026-10-29', { moves: [{ from: 'bluesky', to: 'blacksky.app', accounts: 4 }] })], NOW, bars);
    expect(wrap.hidden).toBe(true);
    renderIdentities(report, [idDay('2026-10-29')], NOW, bars);
    expect(wrap.hidden).toBe(true);
    expect(report.querySelector('[data-p-from-note]')!.textContent).toBe('');
  });

  it('checks each day\'s moves in the history answer', () => {
    const day = { ...idDay('2026-10-29'), moves: [{ from: 'bluesky', to: 'eurosky.social', accounts: 3 }, { from: '<b>', to: 'eurosky.social', accounts: 1 }, { from: 'bluesky', to: 'bluesky', accounts: 1 }, { from: 'Bluesky', to: 'a.example', accounts: 1 }, { from: 'a.example', to: 'bluesky', accounts: 0 }] };
    expect(toHostHistory({ ...HOSTS, identities: [day] })!.identities[0]!.moves).toEqual([{ from: 'bluesky', to: 'eurosky.social', accounts: 3 }]);
    // an answer from before moves were kept
    const { moves: _moves, ...old } = idDay('2026-10-29');
    expect(toHostHistory({ ...HOSTS, identities: [old] })!.identities[0]!.moves).toEqual([]);
  });

  it('puts air quality on the new arrivals tile', () => {
    renderIdentities(report, [idDay('2026-10-29')], NOW);
    const chip = report.querySelector<HTMLElement>('[data-p-smog]')!;
    expect(chip.closest('[data-p-arrivals]')).not.toBeNull();
    expect(chip.hidden).toBe(false);
  });

  it('reads identity days from the history, dropping ones that do not check out', () => {
    const h = toHostHistory({ ...HOSTS, identities: [idDay('2026-10-29'), { day: '2026-10-30', ops: 'lots' }] })!;
    expect(h.identities).toHaveLength(1);
    expect(toHostHistory({ ...HOSTS, identities: undefined })!.identities).toEqual([]);
    const odd = toHostHistory({ ...HOSTS, identities: [{ ...idDay('2026-10-29'), destinations: [{ hostname: 'eurosky.social', accounts: 2 }, { hostname: '<b>', accounts: 1 }] }, { ...idDay('2026-10-28'), destinations: undefined }] })!;
    expect(odd.identities.map((d) => d.destinations)).toEqual([[{ hostname: 'eurosky.social', accounts: 2 }], []]);
    // an answer from before bulk sign-ups were counted has none; more than all the independent ones is held to them
    const { createdBulk: _, bulk: __, ...older } = idDay('2026-10-29');
    const bulk = toHostHistory({ ...HOSTS, identities: [older, idDay('2026-10-28', { createdBulk: 99_999, bulk: [{ hostname: 'goodmkt.id', accounts: 99_999, bursts: 1, seconds: 60 }, { hostname: '<b>', accounts: 5000, bursts: 1, seconds: 1 }] })] })!;
    expect(bulk.identities.map((d) => [d.createdBulk, d.bulk])).toEqual([[0, []], [4383, [{ hostname: 'goodmkt.id', accounts: 99_999, bursts: 1, seconds: 60 }]]]);
  });
});

describe('where the atmosphere lives: the census tiles', () => {
  const census = {
    measuredAt: '2026-10-29T11:50:00.000Z',
    listed: 6442,
    active: 1888,
    bluesky: 90,
    independent: 1798,
    writing: null,
    accounts: { bluesky: 23767508, independent: 363866 },
    diversity: { index: 7.48, share: 1.51, spread: 24.54 },
    top: [],
  };

  it('stays hidden without the census extras, and draws sizes, domains and the roll call with them', () => {
    const report = document.querySelector<HTMLElement>('[data-weather-report]')!;
    renderHostCensus(report, census);
    expect(report.querySelector<HTMLElement>('[data-p-sizes]')!.hidden).toBe(true);
    renderHostCensus(report, {
      ...census,
      statuses: { active: 1888, idle: 310, offline: 4174, throttled: 0, banned: 70, other: 0 },
      sizes: [8, 764, 737, 204, 58, 18, 9],
      tlds: [{ tld: 'com', hosts: 257, accounts: 7455 }, { tld: 'social', hosts: 110, accounts: 53643 }],
    });
    const labels = (sel: string) => [...report.querySelectorAll(`${sel} .weather-bars__label`)].map((el) => el.textContent);
    expect(labels('[data-p-size-list]')).toEqual(['just one person', 'a household (2 to 10)', 'a village (11 to 100)', 'a town (101 to 1,000)', 'a city (1,001 to 10,000)', 'a metropolis (10,000+)']);
    expect(report.querySelector('[data-p-solo]')!.textContent).toBe('764 independent hosts hold just one account: someone running their own.');
    expect(labels('[data-p-tld-list]')).toEqual(['.com', '.social']);
    expect(report.querySelector('[data-p-tld-lede]')!.textContent).toBe('.com is the most popular ending, on 257 of 1,798 independent hosts.');
    // throttled (0) is left out
    // the relay's "active" reads as online: active is for accounts that wrote something
    expect(labels('[data-p-roll-list]')).toEqual(['online', 'idle', 'offline', 'banned']);
    expect(report.querySelector<HTMLElement>('[data-p-rollcall]')!.hidden).toBe(false);
    expect(report.querySelector<HTMLElement>('[data-p-census]')!.hidden).toBe(false);
    expect(report.querySelector('[data-p-roll-lede]')!.textContent).toBe(`the relay has heard of ${census.listed.toLocaleString()} hosts. 1,888 are up and about right now.`);
    // tangled's knots aren't counted, and it says so
    renderHostCensus(report, { ...census, statuses: { active: 1888, idle: 310, offline: 4174, throttled: 0, banned: 70, other: 0 }, knots: 47 });
    expect(report.querySelector('[data-p-roll-lede]')!.textContent).toMatch(/1,888 are up and about right now\. that's leaving out 47 tangled knots: git servers, whose "accounts" are repositories\.$/);
  });

  it('weighs the sizes by accounts when the station sends them, and says what the top ten hold', () => {
    const report = document.querySelector<HTMLElement>('[data-weather-report]')!;
    const top = [{ hostname: 'eurosky.social', accounts: 38036 }, { hostname: 'blacksky.app', accounts: 42900 }];
    renderHostCensus(report, { ...census, top, sizes: [8, 764, 737, 204, 58, 18, 9], sizeAccounts: [0, 764, 3000, 7000, 20000, 60000, 273102] });
    const values = [...report.querySelectorAll('[data-p-size-list] .weather-bars__value')].map((el) => el.textContent);
    expect(values[0]).toBe('764 accounts');
    expect(values[5]).toBe('273.1k accounts');
    expect(report.querySelector('[data-p-top10]')!.textContent).toBe('the 2 biggest independent hosts hold 22% of the accounts on independent hosts; the other 1,796 share the rest.');
    expect(topTenShare({ ...census, top: [] })).toBeNull();
  });
});

describe('the hosting diversity scale', () => {
  it('starts each level where the server does', () => {
    expect(HOSTING_SCALE.slice(1).map(([name, from]) => [name, from]).reverse()).toEqual(HOSTING_LEVELS.map(([name, from]) => [name, from]));
    for (const v of [0, 7.5, 10, 24.9, 25, 74, 75, 199, 200, 1000]) expect(hostingLevelOf(v)).toBe(hostingLevel(v));
  });

  it('is logarithmic, from 0 to the top, and holds past the ends', () => {
    expect(hostingPosition(0)).toBe(0);
    expect(hostingPosition(HOSTING_SCALE_MAX)).toBe(1);
    expect(hostingPosition(HOSTING_SCALE_MAX * 4)).toBe(1);
    expect(hostingPosition(-3)).toBe(0);
    // each band starts where the css draws it (386fr 138fr 173fr 156fr 147fr)
    expect(HOSTING_SCALE.slice(1).map(([, from]) => Math.round(hostingPosition(from) * 1000))).toEqual([386, 524, 697, 853]);
  });
});

describe('a whole host moving house', () => {
  const day = (d: string, destinations: Array<{ hostname: string; accounts: number }>): IdentityDay =>
    ({ day: d, ops: 0, createdBluesky: 0, createdIndependent: 0, createdUnlisted: 0, createdCustomHandle: 0, createdBulk: 0, bulk: [], createdUnnamed: 0, createdScripted: 0, scripted: [], movedOut: 0, movedIn: 0, movedBetween: 0, deleted: 0, destinations, moves: [] });

  it('says the day when nearly all of a destination\'s movers came in one go, and nothing when they came spread out', () => {
    const week = [day('2026-11-06', [{ hostname: 'pds.techne.town', accounts: 304 }, { hostname: 'eurosky.social', accounts: 5 }]), day('2026-11-07', [{ hostname: 'eurosky.social', accounts: 32 }])];
    expect(batchWords('pds.techne.town', 304, week)).toBe('all on nov 6, in one go');
    expect(batchWords('eurosky.social', 37, week)).toBeNull();
    // fewer than BATCH_MOVERS is a few people, not a host
    expect(batchWords('small.host', 12, [day('2026-11-06', [{ hostname: 'small.host', accounts: 12 }]), day('2026-11-07', [])])).toBeNull();
    // most of them on one day still reads as one go
    expect(batchWords('pds.techne.town', 320, [...week, day('2026-11-08', [{ hostname: 'pds.techne.town', accounts: 16 }])])).toBe('304 on nov 6, in one go');
  });
});

describe("the plc directory's utc day, in the reader's time", () => {
  const at = Date.parse('2026-11-12T16:00:00.000Z');
  it('says when today began where the reader is, and nothing extra on utc', () => {
    expect(utcDayStartWords(at, 'America/New_York')).toBe('7 pm yesterday');
    // in tokyo it's already tomorrow at 16:00 utc; earlier in the utc day, the same day
    expect(utcDayStartWords(at, 'Asia/Tokyo')).toBe('9 am yesterday');
    expect(utcDayStartWords(Date.parse('2026-11-12T05:00:00.000Z'), 'Asia/Tokyo')).toBe('9 am');
    expect(utcDayStartWords(Date.parse('2026-11-12T05:00:00.000Z'), 'Asia/Kolkata')).toBe('5:30 am');
    expect(utcDayStartWords(at, 'UTC')).toBeNull();
    expect(identityDayWords('2026-11-12', at, 'America/New_York')).toBe('since 7 pm yesterday, your time');
    expect(identityDayWords('2026-11-12', at, 'UTC')).toBe('today so far (utc)');
    expect(identityWhen('2026-11-12', at, 'America/New_York')).toBe('since 7 pm yesterday');
    expect(identityWhen('2026-11-11', at, 'America/New_York')).toBe('yesterday');
  });
});

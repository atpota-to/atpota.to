// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { activeShareWords, bulkWords, destinationsOf, growingWords, hostBars, independentOf, identityView, identityViewWords, lastedWords, livelyBars, oddsWords, shareHeadline, hostRange, identityDayWords, newHostsWords, renderHostTrends, renderIdentities, signed, smogOf, sumDays, toHostHistory, type HostHistory, type IdentityDay } from '../src/scripts/weather-hosts.js';
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

const idDay = (day: string, extra: Partial<IdentityDay> = {}): IdentityDay => ({ day, ops: 170066, createdBluesky: 9946, createdIndependent: 4383, createdUnlisted: 150845, createdCustomHandle: 122, createdBulk: 0, bulk: [], createdUnnamed: 0, createdScripted: 0, scripted: [], movedOut: 19, movedIn: 0, movedBetween: 1, deleted: 1, destinations: [], ...extra });

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
    expect(rows[0]!.slice(1)).toEqual(['1,886', '0', '0', '0']);
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
    expect(text('[data-p-own]')).toBe('31% started outside bluesky, and 122 with a handle on their own domain.');
    expect(report.querySelector('[data-p-chart="arrivals"] svg')).not.toBeNull();
    expect(report.querySelector('[data-p-chart="winds"] svg')).not.toBeNull();
    expect(text('[data-p-week]')).toBe('over the last 2 days: 49 accounts moved out, 2 moved back.');
    expect(text('[data-p-smog-level]')).toBe('thick smog');
    expect(text('[data-p-smog-words]')).toMatch(/^9\d(\.\d)?% of all [\d,]+ sign-ups went to hosts no relay carries, so they're not in the new arrivals above\.$/);
    expect(text('[data-p-deleted]')).toBe('1 account deleted itself.');
  });

  it('heads the trends with the share off bluesky and which way it went', () => {
    const up = { ...HOSTS, points: [{ ...point('2026-10-22T13:00:00.000Z', 1887), share: 1.46, accountsIndependent: 361000 }, point('2026-10-29T11:00:00.000Z', 1902)] };
    expect(shareHeadline(up, 'week')).toBe("1.51% of accounts live off bluesky's servers, up from 1.46% over the last 7 days: +2,866 accounts on independent hosts.");
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
    expect(text('[data-p-deleted]')).toBe('7 accounts deleted themselves.');
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

  it('counts new accounts made in bulk apart, naming the host and how they came', () => {
    const goodmkt = { hostname: 'goodmkt.id', accounts: 4615, bursts: 2, seconds: 1929 };
    const batch = idDay('2026-10-29', { createdBluesky: 9905, createdIndependent: 5561, createdCustomHandle: 50, createdBulk: 4615, bulk: [goodmkt] });
    renderIdentities(report, [idDay('2026-10-28', { createdBluesky: 18395, createdIndependent: 840 }), batch], NOW);
    expect(text('[data-p-signups]')).toBe('10,851');
    expect(text('[data-p-indep]')).toBe('946');
    expect(text('[data-p-own]')).toBe('8.7% started outside bluesky, and 50 with a handle on their own domain.');
    const line = report.querySelector<HTMLElement>('[data-p-bulk]')!;
    expect(line.hidden).toBe(false);
    expect(line.textContent).toBe('plus 4,615 made in bulk on goodmkt.id (2 bursts, 32 minutes in all), left out above. they came the way scripts make accounts, at a steady pace switched on and off, or in floods out of nowhere again and again. people signing up build up and trail off.');
    // the week's odds leave them out too
    expect(text('[data-p-odds]')).toBe('over the last 2 days: 1 in 17 started outside bluesky.');
    // the air quality is against every sign-up, the bulk ones included
    expect(text('[data-p-smog-words]')).toContain('of all 166,311 sign-ups');
    // a day without any hides the line again
    renderIdentities(report, [idDay('2026-10-29')], NOW);
    expect(line.hidden).toBe(true);

    const oneBurst = { hostname: 'pds.1095.me', accounts: 38, bursts: 1, seconds: 37 };
    expect(bulkWords({ ...batch, createdBulk: 38, bulk: [oneBurst] })).toMatch(/^plus 38 made in bulk on pds\.1095\.me \(one burst, 37 seconds\), left out above\./);
    expect(bulkWords({ ...batch, bulk: [{ ...goodmkt, accounts: 4541 }, { ...oneBurst, accounts: 74, bursts: 2 }] })).toMatch(/^plus 4,615 made in bulk, left out above: 4,541 on goodmkt\.id and 74 on pds\.1095\.me\. they came the way scripts/);
    expect(bulkWords({ ...batch, bulk: [{ ...goodmkt, accounts: 4500 }, { ...oneBurst, accounts: 76 }, { ...oneBurst, hostname: 'a.example', accounts: 30 }, { ...oneBurst, hostname: 'b.example', accounts: 9 }] })).toMatch(/: 4,500 on goodmkt\.id, 76 on pds\.1095\.me and 39 on 2 other hosts\./);
    expect(bulkWords({ ...batch, createdBulk: 0, bulk: [] })).toBe('');
    // identities with no handle are left out too, and said so
    expect(bulkWords({ ...batch, createdBulk: 0, bulk: [], createdUnnamed: 1 })).toBe('plus 1 new identity with no handle, left out above: nobody signs in to one (a git server makes them for its repositories, say).');
    expect(bulkWords({ ...batch, createdUnnamed: 340 })).toMatch(/people signing up build up and trail off\. and 340 new identities with no handle, left out too: nobody signs in to one/);
    expect(independentOf({ ...batch, createdUnnamed: 340 })).toBe(5561 - 4615 - 340);
    // and the ones the trends call scripted, by host and why
    expect(independentOf({ ...batch, createdUnnamed: 340, createdScripted: 600 })).toBe(5561 - 4615 - 340 - 600);
    const leftover = { hostname: 'goodmkt.id', accounts: 603, why: 'bulk' as const };
    const stopped = { hostname: 'refpds.oyster.cafe', accounts: 1062, why: 'stopped' as const };
    expect(bulkWords({ ...batch, createdScripted: 603, scripted: [leftover] })).toMatch(/trail off\. and 603 more on goodmkt\.id, left out too: it made accounts in bulk in the last 30 days, so its other sign-ups count as a script's\.$/);
    expect(bulkWords({ ...batch, createdBulk: 0, bulk: [], createdScripted: 1062, scripted: [stopped] })).toBe("plus 1,062 on refpds.oyster.cafe, left out above: they all came in one day, then nobody for three days. a crowd keeps coming; a script stops dead.");
    expect(bulkWords({ ...batch, createdBulk: 0, bulk: [], createdScripted: 1665, scripted: [stopped, leftover], createdUnnamed: 2 })).toBe(
      'plus 1,665 a script made, by the shape of the hosts\' days, left out above: 1,062 on refpds.oyster.cafe (all in one day, then nobody for three days) and 603 on goodmkt.id (made accounts in bulk in the last 30 days). and 2 new identities with no handle, left out too: nobody signs in to one (a git server makes them for its repositories, say).',
    );
    // over days, each host's add up
    const two = sumDays([{ ...batch, createdScripted: 603, scripted: [leftover] }, { ...idDay('2026-10-28'), createdScripted: 527, scripted: [{ ...leftover, accounts: 527 }] }])!;
    expect([two.createdScripted, two.scripted]).toEqual([1130, [{ hostname: 'goodmkt.id', accounts: 1130, why: 'bulk' }]]);
    expect([lastedWords(1), lastedWords(75), lastedWords(1929), lastedWords(13_080)]).toEqual(['1 second', 'a minute', '32 minutes', '3.6 hours']);
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
    expect(oddsWords([idDay('2026-10-28', { createdBluesky: 900, createdIndependent: 100 }), idDay('2026-10-29', { createdBluesky: 1100, createdIndependent: 100 })])).toBe('over the last 2 days: 1 in 11 started outside bluesky.');
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
    expect(labels('[data-p-roll-list]')).toEqual(['active', 'idle', 'offline', 'banned']);
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

/**
 * Tap a host, see its own weather: any host named in a list marked [data-host-list] (the
 * biggest hosts, new ones, the fastest growing, where movers went and where they left) opens
 * a panel with its accounts day by day, and who moved to it and away from it, from
 * /api/weather-history?host= (server/weather-hosts.ts readHost).
 * Days from before the station kept count are the backfill's estimates, and say so.
 */

import { renderChart } from './weather-chart';
import { compactCount, formatCount } from './weather';

export interface OneHost {
  hostname: string;
  bluesky: boolean;
  /** `active`: the accounts that wrote anything that day, once the station counted them. */
  days: Array<{ day: string; accounts: number; estimated: boolean; active?: number }>;
  /** Who moved to this host and away from it, by the day and the other host (BLUESKY for any of Bluesky's own), oldest first. */
  moves: HostMoveDay[];
  /** The first day the station kept anyone's moves: without it, this host's aren't known. */
  movesSince?: string;
}

export interface HostMoveDay {
  day: string;
  arrived: Array<{ from: string; accounts: number }>;
  left: Array<{ to: string; accounts: number }>;
}

/** Bluesky's own hosts, as one place, where a move names the other host (server/weather-hosts.ts BLUESKY). */
const BLUESKY = 'bluesky';
/** How far back the panel adds up a host's moves. */
export const MOVES_DAYS = 30;
/** How many other hosts it names each way before "and N from M others". */
const MOVES_NAMED = 3;

const HOSTNAME_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const obj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const n = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 0;
const DAY_FORMAT = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
const dayWords = (day: string) => DAY_FORMAT.format(new Date(`${day}T00:00:00Z`)).toLowerCase();

const place = (x: unknown): x is string => x === BLUESKY || (typeof x === 'string' && HOSTNAME_RE.test(x));

/** One side of a day's moves, checked: [{ from | to, accounts }]. */
function side<K extends 'from' | 'to'>(x: unknown, key: K): Array<Record<K, string> & { accounts: number }> {
  return (Array.isArray(x) ? x : []).flatMap((m) => (obj(m) && place(m[key]) && n(m.accounts) && m.accounts > 0 ? [{ [key]: m[key], accounts: m.accounts } as Record<K, string> & { accounts: number }] : []));
}

/** The answer's host, checked, or null. */
export function toOneHost(x: unknown): OneHost | null {
  const h = obj(x) ? x.host : null;
  if (!obj(h) || typeof h.hostname !== 'string' || !HOSTNAME_RE.test(h.hostname) || !Array.isArray(h.days)) return null;
  return {
    hostname: h.hostname,
    bluesky: h.bluesky === true,
    days: h.days.filter((d): d is OneHost['days'][number] => obj(d) && typeof d.day === 'string' && DAY_RE.test(d.day) && n(d.accounts)).map((d) => ({ day: d.day, accounts: d.accounts, estimated: d.estimated === true, ...(n(d.active) ? { active: d.active } : {}) })),
    moves: (Array.isArray(h.moves) ? h.moves : []).flatMap((d) => (obj(d) && typeof d.day === 'string' && DAY_RE.test(d.day) ? [{ day: d.day, arrived: side(d.arrived, 'from'), left: side(d.left, 'to') }] : [])),
    ...(typeof h.movesSince === 'string' && DAY_RE.test(h.movesSince) ? { movesSince: h.movesSince } : {}),
  };
}

/** What the panel says under the host's name: its accounts now, since when, and how it's grown. */
export function hostStory(h: OneHost): string {
  const first = h.days[0];
  const last = h.days[h.days.length - 1];
  if (!first || !last) return "i haven't seen this host in a census yet.";
  const now = `${formatCount(last.accounts)} account${last.accounts === 1 ? '' : 's'} hosted on ${dayWords(last.day)}, active or not.`;
  if (first === last) return `${now} that's the only day i've seen it so far.`;
  const gained = last.accounts - first.accounts;
  const change = gained === 0 ? 'no change' : `${gained > 0 ? '+' : '−'}${formatCount(Math.abs(gained))}${first.accounts > 0 ? ` (${gained > 0 ? '+' : '−'}${(Math.abs(gained / first.accounts) * 100).toFixed(1)}%)` : ''}`;
  return `${now} ${change} since ${dayWords(first.day)}, the first day i have for it.`;
}

/** "1,204 of them wrote something on oct 22 (3.2%)", from the latest day with a count, or nothing before the station counted. */
export function activeStory(h: OneHost): string {
  const d = [...h.days].reverse().find((x) => x.active !== undefined);
  if (!d || d.active === undefined) return '';
  const share = d.accounts > 0 ? ` (${(Math.min(100, (d.active / d.accounts) * 100)).toFixed(1)}% of them)` : '';
  return `${formatCount(d.active)} account${d.active === 1 ? '' : 's'} wrote something on ${dayWords(d.day)}${share}.`;
}

/** "38 from bluesky's hosts, 2 from pds.tophhie.cloud and 3 from 2 other hosts": the other hosts added up, the most first. */
function others(lists: Array<Array<{ host: string; accounts: number }>>, word: 'from' | 'to'): string {
  const by = new Map<string, number>();
  for (const list of lists) for (const m of list) by.set(m.host, (by.get(m.host) ?? 0) + m.accounts);
  const all = [...by].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const named = all.slice(0, MOVES_NAMED).map(([host, accounts]) => `${formatCount(accounts)} ${word} ${host === BLUESKY ? "bluesky's hosts" : host}`);
  const rest = all.slice(MOVES_NAMED);
  if (rest.length) named.push(`${formatCount(rest.reduce((t, [, a]) => t + a, 0))} ${word} ${formatCount(rest.length)} other host${rest.length === 1 ? '' : 's'}`);
  return named.length > 1 ? `${named.slice(0, -1).join(', ')} and ${named[named.length - 1]}` : (named[0] ?? '');
}

/**
 * Who moved to the host and away from it over the last MOVES_DAYS days, or since the station
 * kept anyone's moves when that's later: "over the last 30 days, 41 accounts moved here (38 from
 * bluesky's hosts, 3 from pds.tophhie.cloud) and 2 moved away (2 to blacksky.app)." Nothing
 * for one of Bluesky's own hosts (they're one place for moves), or before any were kept.
 */
export function moveStory(h: OneHost, now = Date.now()): string {
  if (h.bluesky || !h.movesSince) return '';
  const from = new Date(now - (MOVES_DAYS - 1) * 86_400_000).toISOString().slice(0, 10);
  const days = h.moves.filter((d) => d.day >= from);
  const span = h.movesSince > from ? `since ${dayWords(h.movesSince)}` : `over the last ${MOVES_DAYS} days`;
  const arrived = days.flatMap((d) => d.arrived);
  const left = days.flatMap((d) => d.left);
  const total = (list: Array<{ accounts: number }>) => list.reduce((t, m) => t + m.accounts, 0);
  const [came, went] = [total(arrived), total(left)];
  if (came === 0 && went === 0) return `${span}, nobody moved here from another host, or away.`;
  const here = came > 0 ? `${formatCount(came)} account${came === 1 ? '' : 's'} moved here (${others([arrived.map((m) => ({ host: m.from, accounts: m.accounts }))], 'from')})` : 'nobody moved here';
  const away = went > 0 ? `${formatCount(went)} moved away (${others([left.map((m) => ({ host: m.to, accounts: m.accounts }))], 'to')})` : 'nobody moved away';
  return `${span}, ${here} and ${away}.`;
}

/** The note on estimated days, or nothing when every day was counted. */
export function estimatedWords(h: OneHost): string {
  const estimated = h.days.filter((d) => d.estimated);
  if (!estimated.length) return '';
  return `days up to ${dayWords(estimated[estimated.length - 1]!.day)} are estimated from the plc directory, from before i kept count of each host.`;
}

const $ = <T extends Element = HTMLElement>(root: ParentNode, sel: string) => root.querySelector<T>(sel);

function setText(root: ParentNode, sel: string, text: string): void {
  const el = $(root, sel);
  if (el) el.textContent = text;
}

/** Makes a list's rows something to tap or press: each opens its host's panel. */
function markRows(list: HTMLElement): void {
  for (const li of Array.from(list.children)) {
    if (!(li instanceof HTMLElement) || !li.dataset.key || !HOSTNAME_RE.test(li.dataset.key)) continue;
    if (li.tabIndex === 0) continue;
    li.tabIndex = 0;
    li.dataset.hostRow = '';
    li.setAttribute('aria-label', `${li.dataset.key}: see its history`);
  }
}

/** Fills the panel for a host: loading, then its story and chart, or an apology. */
export function renderHostPanel(dialog: HTMLElement, h: OneHost | null | 'loading', hostname: string): void {
  setText(dialog, '[data-hp-name]', hostname);
  // the host on aturi: its software, its terms, the accounts it holds
  const visit = $<HTMLAnchorElement>(dialog, '[data-hp-visit]');
  if (visit) visit.href = `https://aturi.to/explore/pds/${encodeURIComponent(hostname)}`;
  const chart = $(dialog, '[data-hp-chart]');
  const card = chart?.closest<HTMLElement>('.weather-chart-card');
  if (h === 'loading' || h === null) {
    setText(dialog, '[data-hp-story]', h === null ? "i couldn't read this host's history just now. try again in a bit." : 'reading its history…');
    setText(dialog, '[data-hp-estimated]', '');
    for (const c of Array.from(dialog.querySelectorAll<HTMLElement>('.weather-chart-card'))) c.hidden = true;
    const line = $(dialog, '[data-hp-active]');
    if (line) line.hidden = true;
    const movesLine = $(dialog, '[data-hp-moves]');
    if (movesLine) movesLine.hidden = true;
    return;
  }
  setText(dialog, '[data-hp-story]', hostStory(h));
  const lively = activeStory(h);
  const line = $(dialog, '[data-hp-active]');
  if (line) {
    line.hidden = !lively;
    line.textContent = lively;
  }
  const moved = moveStory(h);
  const movesLine = $(dialog, '[data-hp-moves]');
  if (movesLine) {
    movesLine.hidden = !moved;
    movesLine.textContent = moved;
  }
  const activeDays = h.days.filter((d) => d.active !== undefined);
  const activeChart = $(dialog, '[data-hp-active-chart]');
  const activeCard = activeChart?.closest<HTMLElement>('.weather-chart-card');
  if (activeCard) activeCard.hidden = activeDays.length < 2;
  if (activeChart && activeDays.length >= 2) {
    renderChart(activeChart, activeDays.map((d) => ({ t: Date.parse(`${d.day}T00:00:00Z`), v: d.active! })), {
      label: `accounts active on ${hostname} each day`,
      color: 'var(--weather-bsky)',
      format: formatCount,
      formatTick: compactCount,
      formatTime: (t) => DAY_FORMAT.format(new Date(t)).toLowerCase(),
      stepMs: 86_400_000,
    });
  }
  setText(dialog, '[data-hp-estimated]', estimatedWords(h));
  if (card) card.hidden = h.days.length < 2;
  if (chart && h.days.length >= 2) {
    renderChart(chart, h.days.map((d) => ({ t: Date.parse(`${d.day}T00:00:00Z`), v: d.accounts })), {
      label: `accounts on ${hostname} each day`,
      color: 'var(--weather-else)',
      format: formatCount,
      formatTick: compactCount,
      formatTime: (t) => DAY_FORMAT.format(new Date(t)).toLowerCase(),
      stepMs: 86_400_000,
      fromZero: false,
    });
  }
}

/** Binds the host lists in the report to the panel ([data-host-dialog]). */
export function initHostPanel(report: HTMLElement, fetchImpl: typeof fetch = fetch): void {
  const dialog = $<HTMLDialogElement>(document, '[data-host-dialog]');
  if (!dialog) return;
  const lists = Array.from(report.querySelectorAll<HTMLElement>('[data-host-list]'));
  for (const list of lists) {
    markRows(list);
    if (typeof MutationObserver === 'function') new MutationObserver(() => markRows(list)).observe(list, { childList: true });
  }
  const cache = new Map<string, Promise<OneHost | null>>();
  let shown = '';
  let opener: HTMLElement | null = null;
  const read = (hostname: string) => {
    let p = cache.get(hostname);
    if (!p) {
      p = fetchImpl(`/api/weather-history?host=${encodeURIComponent(hostname)}`, { headers: { accept: 'application/json' } })
        .then(async (res) => (res.ok ? toOneHost(await res.json()) : null))
        .catch(() => null);
      p.then((h) => {
        if (!h) cache.delete(hostname); // try again next time
      });
      cache.set(hostname, p);
    }
    return p;
  };
  const open = async (hostname: string, from: HTMLElement) => {
    shown = hostname;
    opener = from;
    renderHostPanel(dialog, 'loading', hostname);
    if (!dialog.open) {
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
    }
    const h = await read(hostname);
    if (shown === hostname && dialog.open) renderHostPanel(dialog, h, hostname);
  };
  const close = () => {
    if (typeof dialog.close === 'function') dialog.close();
    else dialog.removeAttribute('open');
  };
  dialog.addEventListener('close', () => {
    shown = '';
    opener?.focus();
  });
  $(dialog, '[data-hp-close]')?.addEventListener('click', close);
  // a tap on the backdrop closes it too
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) close();
  });
  const rowOf = (target: EventTarget | null) => (target instanceof Element ? target.closest<HTMLElement>('[data-host-list] > [data-host-row]') : null);
  report.addEventListener('click', (event) => {
    const row = rowOf(event.target);
    if (row?.dataset.key) void open(row.dataset.key, row);
  });
  report.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const row = rowOf(event.target);
    if (!row?.dataset.key || event.target !== row) return;
    event.preventDefault();
    void open(row.dataset.key, row);
  });
}

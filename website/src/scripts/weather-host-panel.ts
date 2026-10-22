/**
 * Tap a host, see its own weather: any host named in a list marked [data-host-list] (the
 * biggest hosts, new ones, the fastest growing, where movers went) opens a panel with its
 * accounts day by day, from /api/weather-history?host= (server/weather-hosts.ts readHost).
 * Days from before the station kept count are the backfill's estimates, and say so.
 */

import { renderChart } from './weather-chart';
import { compactCount, formatCount } from './weather';

export interface OneHost {
  hostname: string;
  bluesky: boolean;
  /** `active`: the accounts that wrote anything that day, once the station counted them. */
  days: Array<{ day: string; accounts: number; estimated: boolean; active?: number }>;
}

const HOSTNAME_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const obj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const n = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 0;
const DAY_FORMAT = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
const dayWords = (day: string) => DAY_FORMAT.format(new Date(`${day}T00:00:00Z`)).toLowerCase();

/** The answer's host, checked, or null. */
export function toOneHost(x: unknown): OneHost | null {
  const h = obj(x) ? x.host : null;
  if (!obj(h) || typeof h.hostname !== 'string' || !HOSTNAME_RE.test(h.hostname) || !Array.isArray(h.days)) return null;
  return {
    hostname: h.hostname,
    bluesky: h.bluesky === true,
    days: h.days.filter((d): d is OneHost['days'][number] => obj(d) && typeof d.day === 'string' && DAY_RE.test(d.day) && n(d.accounts)).map((d) => ({ day: d.day, accounts: d.accounts, estimated: d.estimated === true, ...(n(d.active) ? { active: d.active } : {}) })),
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
    return;
  }
  setText(dialog, '[data-hp-story]', hostStory(h));
  const lively = activeStory(h);
  const line = $(dialog, '[data-hp-active]');
  if (line) {
    line.hidden = !lively;
    line.textContent = lively;
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

/**
 * The atmosphere weather report (weather/index.html, /weather): the home page's
 * "atmospheric conditions" tile, at full size. One reading from /api/atmosphere
 * (server/atmosphere.ts) fills every tile: how busy Bluesky is, the diversity index (the
 * share of new records written outside Bluesky) on a UV-index-style scale, the split as a
 * bar, the busiest apps elsewhere, Bluesky's busiest collections, and every kind of event
 * on the wire. When the reading is the weather station's rolling 60 seconds it checks
 * again every 5 seconds (with a sparkline of those 60 seconds), otherwise once a minute,
 * always only while the tab is visible; a failed check keeps the last reading on screen.
 *
 * Trends come from /api/weather-history (server/weather-history.ts): the station's
 * minute rows for the last hour, 24 hours, 30 days or 12 months, as two charts
 * (weather-chart.ts) and a table.
 *
 * Collection names and app domains come from other people's records, so they only reach
 * the DOM through textContent (weather.ts has already dropped any that don't look right).
 *
 * States live on the report as data-state="loading" | "ready" | "error".
 */

import { renderChart, type ChartPoint } from './weather-chart';
import {
  CONDITION_TEXT,
  ERROR_TEXT,
  LEVEL_TEXT,
  REFRESH_MS,
  countTo,
  fetchReading,
  formatIndex,
  ratioText,
  renderRatio,
  spinRays,
  type Reading,
} from './weather';

export const LIVE_REFRESH_MS = 5_000;
export const HISTORY_ENDPOINT = '/api/weather-history';

/** Where the scale ends: "extreme" starts at 11 and gets two more points of room. */
export const SCALE_MAX = 13;

/** Plain names for Bluesky's collections; anything else shows its NSID. */
export const BLUESKY_NAMES: Record<string, string> = {
  'app.bsky.feed.like': 'likes',
  'app.bsky.feed.post': 'posts',
  'app.bsky.feed.repost': 'reposts',
  'app.bsky.graph.follow': 'follows',
  'app.bsky.graph.block': 'blocks',
  'app.bsky.feed.threadgate': 'who-can-reply settings',
  'app.bsky.feed.postgate': 'quote settings',
  'app.bsky.graph.listitem': 'people added to lists',
  'app.bsky.graph.list': 'new lists',
  'app.bsky.graph.listblock': 'lists blocked',
  'app.bsky.graph.starterpack': 'starter packs',
  'app.bsky.graph.verification': 'verifications',
  'app.bsky.feed.generator': 'new feeds',
  'app.bsky.actor.profile': 'new profiles',
  'app.bsky.actor.status': 'live statuses',
  'app.bsky.notification.declaration': 'notification settings',
  'chat.bsky.actor.declaration': 'chat settings',
};

/** Records a second as people read them: one decimal under 100, whole after that. */
export function formatRate(n: number): string {
  return n < 100 ? n.toLocaleString('en-US', { maximumFractionDigits: 1 }) : Math.round(n).toLocaleString('en-US');
}

function formatShare(part: number, whole: number): string {
  if (whole <= 0) return '';
  const pct = (part / whole) * 100;
  return `(${pct > 0 && pct < 0.01 ? '<0.01' : pct < 1 || pct > 99 ? pct.toFixed(2) : pct.toFixed(1)}%)`;
}

const $ = <T extends Element = HTMLElement>(root: ParentNode, sel: string) => root.querySelector<T>(sel);

function setText(root: ParentNode, sel: string, text: string): void {
  const el = $(root, sel);
  if (el) el.textContent = text;
}

function count(root: ParentNode, sel: string, value: number | undefined, format: (n: number) => string = formatRate): void {
  const el = $(root, sel);
  if (el && value !== undefined) countTo(el, value, format);
}

export interface Bar {
  label: string;
  /** Smaller text under the label: an NSID, or an app's collections. */
  sub?: string;
  perSecond: number;
  count: number;
  /** What to print beside the bar; default its rate a second. */
  value?: string;
}

/** A list of horizontal bars, each as long as its share of the busiest one, its value in words beside it. */
export function renderBars(list: HTMLElement, bars: Bar[], seconds: number | undefined): void {
  const max = Math.max(...bars.map((b) => b.perSecond), 0);
  list.replaceChildren(
    ...bars.map((b) => {
      const li = document.createElement('li');
      li.className = 'weather-bars__row';
      if (seconds) li.title = `${b.count.toLocaleString('en-US')} in ${seconds} seconds`;
      const label = document.createElement('span');
      label.className = 'weather-bars__label';
      label.textContent = b.label;
      const value = document.createElement('span');
      value.className = 'weather-bars__value';
      value.textContent = b.value ?? formatRate(b.perSecond);
      const track = document.createElement('span');
      track.className = 'weather-bars__track';
      track.setAttribute('aria-hidden', 'true');
      const fill = document.createElement('span');
      fill.className = 'weather-bars__fill';
      fill.style.width = `${max > 0 ? Math.max(1.5, (b.perSecond / max) * 100) : 0}%`;
      track.append(fill);
      li.append(label, value, track);
      if (b.sub) {
        const sub = document.createElement('span');
        sub.className = 'weather-bars__sub';
        sub.textContent = b.sub;
        li.append(sub);
      }
      return li;
    }),
  );
}

function timeOf(iso: string | undefined): string {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).toLowerCase();
}

export function renderReport(report: HTMLElement, r: Reading): void {
  // now
  count(report, '[data-r-posts]', r.perSecond.posts, (n) => String(Math.round(n)));
  setText(report, '[data-r-cond]', CONDITION_TEXT[r.condition]);
  const when = timeOf(r.measuredAt);
  const live = r.source === 'station';
  setText(
    report,
    '[data-r-when]',
    live ? `the last ${r.seconds ?? 60} seconds, live. updates every few seconds.` : when ? `read at ${when}${r.seconds ? `, from ${r.seconds} seconds of the firehose` : ''}. next reading in about a minute.` : '',
  );
  spinRays(report, r.perSecond.posts);
  const spark = $(report, '[data-r-spark]');
  if (spark) {
    const posts = (r.series ?? []).map((p) => p?.posts ?? null);
    spark.hidden = !live || posts.filter((p) => p !== null).length < 2;
    if (!spark.hidden) renderSparkline(spark, posts);
  }

  // diversity
  if (r.diversity) {
    count(report, '[data-r-index]', r.diversity.index, formatIndex);
    setText(report, '[data-r-level]', r.diversity.level);
    setText(report, '[data-r-level-text]', LEVEL_TEXT[r.diversity.level]);
    const marker = $(report, '[data-r-marker]');
    if (marker) marker.style.left = `${(Math.min(r.diversity.index, SCALE_MAX) / SCALE_MAX) * 100}%`;
    setText(report, '[data-r-collections]', r.diversity.collections.toLocaleString('en-US'));
  }

  // bluesky and everyone else
  if (r.records) {
    setText(report, '[data-r-ratio]', ratioText(r.records));
    renderRatio($(report, '[data-r-bar-bsky]'), $(report, '[data-r-bar-else]'), r.records);
    count(report, '[data-r-bsky]', r.records.bluesky);
    count(report, '[data-r-else]', r.records.elsewhere);
    count(report, '[data-r-total]', r.records.perSecond);
    setText(report, '[data-r-bsky-share]', formatShare(r.records.bluesky, r.records.perSecond));
    setText(report, '[data-r-else-share]', formatShare(r.records.elsewhere, r.records.perSecond));
  }

  // elsewhere
  const apps = r.apps ?? [];
  const appsList = $(report, '[data-r-apps]');
  if (appsList) renderBars(appsList, apps.map((a) => ({ label: a.domain, sub: a.collections.join(', '), perSecond: a.perSecond, count: a.count })), r.seconds);
  const empty = $(report, '[data-r-apps-empty]');
  if (empty) empty.hidden = apps.length > 0;
  const n = r.diversity?.apps ?? apps.length;
  setText(report, '[data-r-apps-count]', n === 0 ? '' : `${n} app${n === 1 ? '' : 's'} heard${n > apps.length ? `, top ${apps.length}` : ''}`);

  // bluesky
  const bskyList = $(report, '[data-r-bsky-list]');
  if (bskyList && r.bluesky) {
    renderBars(
      bskyList,
      r.bluesky.map((b) => ({ label: BLUESKY_NAMES[b.nsid] ?? b.nsid, sub: b.nsid, perSecond: b.perSecond, count: b.count })),
      r.seconds,
    );
  }

  // the wire
  if (r.events) for (const [key, value] of Object.entries(r.events)) count(report, `[data-r-event="${key}"]`, value);

  if (report.dataset.state !== 'ready') setText(report, '[data-r-status]', `${CONDITION_TEXT[r.condition]}. diversity index ${r.diversity ? `${formatIndex(r.diversity.index)}, ${r.diversity.level}` : 'unknown'}.`);
  report.dataset.state = 'ready';
}

/** A bare line of the last 60 seconds: decorative (aria-hidden), the reading says it in words. */
export function renderSparkline(host: HTMLElement, values: Array<number | null>): void {
  const w = 240;
  const h = 36;
  const max = Math.max(1, ...values.filter((v): v is number => v !== null));
  const step = values.length > 1 ? w / (values.length - 1) : w;
  let d = '';
  let pen = false;
  values.forEach((v, i) => {
    if (v === null) {
      pen = false;
      return;
    }
    d += `${pen ? 'L' : 'M'}${(i * step).toFixed(1)},${(h - 2 - (v / max) * (h - 4)).toFixed(1)}`;
    pen = true;
  });
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('focusable', 'false');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', d);
  path.setAttribute('vector-effect', 'non-scaling-stroke');
  svg.append(path);
  const caption = document.createElement('span');
  caption.className = 'weather-spark__caption';
  caption.textContent = 'posts a second, the last 60 seconds';
  host.replaceChildren(svg, caption);
}

// ---------- trends ----------

export type Range = 'hour' | 'day' | 'month' | 'year';

export interface HistoryPoint {
  t: string;
  seconds: number;
  creates: number;
  bluesky: number;
  elsewhere: number;
  posts: number;
}

export interface HistoryApp {
  domain: string;
  creates: number;
  minutes: number;
  collections: string[];
}

export interface History {
  range: Range;
  points: HistoryPoint[];
  total: HistoryPoint;
  /** The busiest apps outside Bluesky over the range, when the server could get them. */
  apps?: HistoryApp[];
}

export const RANGE_INFO: Record<Range, { spanMs: number; stepMs: number; words: string; time: Intl.DateTimeFormatOptions }> = {
  hour: { spanMs: 3600_000, stepMs: 60_000, words: 'the last hour', time: { hour: 'numeric', minute: '2-digit' } },
  day: { spanMs: 24 * 3600_000, stepMs: 3600_000, words: 'the last 24 hours', time: { weekday: 'short', hour: 'numeric', minute: '2-digit' } },
  month: { spanMs: 30 * 86_400_000, stepMs: 86_400_000, words: 'the last 30 days', time: { month: 'short', day: 'numeric' } },
  year: { spanMs: 366 * 86_400_000, stepMs: 32 * 86_400_000, words: 'the last 12 months', time: { month: 'short', year: 'numeric' } },
};

const RANGES = Object.keys(RANGE_INFO) as Range[];

function isPoint(p: unknown): p is HistoryPoint {
  const r = p as Record<string, unknown>;
  const n = (x: unknown) => typeof x === 'number' && Number.isFinite(x) && x >= 0;
  return typeof r === 'object' && r !== null && typeof r.t === 'string' && Number.isFinite(Date.parse(r.t)) && n(r.seconds) && n(r.creates) && n(r.bluesky) && n(r.elsewhere) && n(r.posts);
}

const APP_NAME_RE = /^[a-z0-9][a-z0-9.-]{0,252}$/i;

function isApp(a: unknown): a is HistoryApp {
  const r = a as Record<string, unknown>;
  const n = (x: unknown) => typeof x === 'number' && Number.isFinite(x) && x >= 0;
  return (
    typeof r === 'object' &&
    r !== null &&
    typeof r.domain === 'string' &&
    APP_NAME_RE.test(r.domain) &&
    n(r.creates) &&
    n(r.minutes) &&
    Array.isArray(r.collections) &&
    r.collections.every((c) => typeof c === 'string' && APP_NAME_RE.test(c))
  );
}

export async function fetchHistory(range: Range, fetchImpl: typeof fetch = fetch): Promise<History | null> {
  try {
    const res = await fetchImpl(`${HISTORY_ENDPOINT}?range=${range}`, { headers: { accept: 'application/json' } });
    if (!res.ok) return null;
    const body = (await res.json()) as { range?: unknown; points?: unknown; total?: unknown; apps?: unknown };
    if (body.range !== range || !Array.isArray(body.points) || !isPoint(body.total)) return null;
    const history: History = { range, points: body.points.filter(isPoint), total: body.total };
    if (Array.isArray(body.apps)) history.apps = body.apps.filter(isApp);
    return history;
  } catch {
    return null;
  }
}

/** Records a second and the diversity index of a point (null when it covers nothing). */
export function ratesOf(p: HistoryPoint): { records: number | null; posts: number | null; index: number | null } {
  if (p.seconds <= 0) return { records: null, posts: null, index: null };
  return { records: p.creates / p.seconds, posts: p.posts / p.seconds, index: p.creates > 0 ? (p.elsewhere / p.creates) * 100 : null };
}

/** How much of a range the station covered, in words: "13 minutes", "2 days". */
export function coverageWords(seconds: number): string {
  const units: Array<[string, number]> = [
    ['day', 86_400],
    ['hour', 3600],
    ['minute', 60],
  ];
  for (const [unit, size] of units) {
    const n = Math.floor(seconds / size);
    if (n >= 1) return `${n} ${unit}${n === 1 ? '' : 's'}`;
  }
  return 'under a minute';
}

export function trendSummary(h: History): string {
  const info = RANGE_INFO[h.range];
  const { records, index } = ratesOf(h.total);
  if (records === null) return `no readings yet for ${info.words}. the station fills this in as it goes.`;
  const covered = h.total.seconds < (info.spanMs / 1000) * 0.9 ? ` (from ${coverageWords(h.total.seconds)} of readings so far)` : '';
  const idx = index === null ? '' : `, diversity index ${formatIndex(index)}`;
  return `${info.words}${covered}: ${formatRate(records)} new records a second${idx}.`;
}

export function renderTrends(section: HTMLElement, h: History, now = Date.now()): void {
  const info = RANGE_INFO[h.range];
  const fmt = new Intl.DateTimeFormat(undefined, info.time);
  const formatTime = (t: number) => fmt.format(new Date(t)).toLowerCase();
  setText(section, '[data-t-summary]', trendSummary(h));
  const rows = h.points.map((p) => ({ t: Date.parse(p.t), ...ratesOf(p) }));
  // Start the axis where the range starts, so a station that's new shows as a gap, not a short range.
  const start = now - info.spanMs;
  const lead: Array<{ t: number; records: null; posts: null; index: null }> =
    h.range !== 'year' && (rows[0]?.t ?? now) - start > info.stepMs ? [{ t: start, records: null, posts: null, index: null }] : [];
  const series = [...lead, ...rows];
  const records = $(section, '[data-t-chart="records"]');
  const index = $(section, '[data-t-chart="index"]');
  const pts = (key: 'records' | 'index'): ChartPoint[] => series.map((r) => ({ t: r.t, v: r[key] }));
  if (records) renderChart(records, pts('records'), { label: 'new records a second', color: 'var(--weather-bsky)', format: formatRate, formatTime, stepMs: info.stepMs });
  if (index) renderChart(index, pts('index'), { label: 'diversity index', color: 'var(--weather-else)', format: formatIndex, formatTick: (v) => String(Number(v.toFixed(2))), formatTime, stepMs: info.stepMs });
  const body = $(section, '[data-t-rows]');
  if (body) {
    body.replaceChildren(
      ...rows
        .slice()
        .reverse()
        .map((r) => {
          const tr = document.createElement('tr');
          const cells = [formatTime(r.t), r.records === null ? '–' : formatRate(r.records), r.posts === null ? '–' : formatRate(r.posts), r.index === null ? '–' : formatIndex(r.index)];
          cells.forEach((text, i) => {
            const cell = document.createElement(i === 0 ? 'th' : 'td');
            if (i === 0) cell.setAttribute('scope', 'row');
            cell.textContent = text;
            tr.append(cell);
          });
          return tr;
        }),
    );
  }
  const wrap = $(section, '[data-t-apps-wrap]');
  const list = $(section, '[data-t-apps]');
  const apps = h.apps ?? [];
  if (wrap && list) {
    wrap.hidden = apps.length === 0 || h.total.seconds <= 0;
    setText(section, '[data-t-apps-title]', `busiest apps elsewhere, ${info.words}: new records`);
    if (!wrap.hidden) {
      renderBars(
        list,
        apps.map((a) => ({ label: a.domain, sub: a.collections.join(', '), perSecond: a.creates / h.total.seconds, count: a.creates, value: a.creates.toLocaleString('en-US') })),
        h.total.seconds,
      );
    }
  }
  section.dataset.state = 'ready';
}

/** The range buttons, the first load, and a refresh while the tab is visible (every minute for the last hour, else every 5). */
export function initTrends(section: HTMLElement, fetchImpl: typeof fetch = fetch): void {
  const buttons = [...section.querySelectorAll<HTMLButtonElement>('[data-range]')];
  let range: Range = (buttons.find((b) => b.getAttribute('aria-pressed') === 'true')?.dataset.range as Range) ?? 'day';
  let asked = 0;
  const load = async () => {
    const mine = ++asked;
    section.dataset.state = section.dataset.state === 'ready' ? 'refreshing' : 'loading';
    const history = await fetchHistory(range, fetchImpl);
    if (mine !== asked) return; // a newer range took over
    if (history) renderTrends(section, history);
    else {
      section.dataset.state = 'error';
      setText(section, '[data-t-summary]', 'the records are hard to read right now. try again in a bit.');
    }
  };
  for (const b of buttons) {
    b.addEventListener('click', () => {
      const next = b.dataset.range as Range;
      if (!RANGES.includes(next) || next === range) return;
      range = next;
      for (const other of buttons) other.setAttribute('aria-pressed', String(other === b));
      void load();
    });
  }
  void load();
  const tick = () =>
    window.setTimeout(
      () => {
        if (document.visibilityState !== 'hidden') void load();
        tick();
      },
      range === 'hour' ? 60_000 : 300_000,
    );
  tick();
}

export function renderReportError(report: HTMLElement): void {
  if (report.dataset.state === 'ready') return;
  setText(report, '[data-r-cond]', ERROR_TEXT);
  setText(report, '[data-r-status]', ERROR_TEXT);
  report.dataset.state = 'error';
}

export function init(root: ParentNode = document, fetchImpl: typeof fetch = fetch): void {
  const report = $(root, '[data-weather-report]');
  if (!report || report.dataset.weatherBound === 'true') return;
  report.dataset.weatherBound = 'true';
  let every = REFRESH_MS;
  const load = async () => {
    const reading = await fetchReading(fetchImpl);
    if (reading) renderReport(report, reading);
    else renderReportError(report);
    every = reading?.source === 'station' ? LIVE_REFRESH_MS : REFRESH_MS;
  };
  const tick = () =>
    window.setTimeout(async () => {
      if (document.visibilityState !== 'hidden') await load();
      tick();
    }, every);
  void load().then(tick);
  const trends = $(report, '[data-r-trends]');
  if (trends) initTrends(trends, fetchImpl);
}

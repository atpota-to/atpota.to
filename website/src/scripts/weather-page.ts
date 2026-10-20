/**
 * The atmosphere weather report (weather/index.html, /weather): the home page's
 * "atmospheric conditions" tile, at full size. One reading from /api/atmosphere
 * (server/atmosphere.ts) fills every tile: how busy Bluesky is, the diversity index (the
 * share of new records written outside Bluesky) on a UV-index-style scale, the split as a
 * bar, the busiest apps elsewhere, Bluesky's busiest collections, and every kind of event
 * on the wire. It checks again once a minute while the tab is visible; a failed check
 * keeps the last reading on screen.
 *
 * Collection names and app domains come from other people's records, so they only reach
 * the DOM through textContent (weather.ts has already dropped any that don't look right).
 *
 * States live on the report as data-state="loading" | "ready" | "error".
 */

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
      value.textContent = formatRate(b.perSecond);
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
  setText(report, '[data-r-when]', when ? `read at ${when}${r.seconds ? `, from ${r.seconds} seconds of the firehose` : ''}. next reading in about a minute.` : '');
  spinRays(report, r.perSecond.posts);

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
  const load = async () => {
    const reading = await fetchReading(fetchImpl);
    if (reading) renderReport(report, reading);
    else renderReportError(report);
  };
  void load();
  window.setInterval(() => {
    if (document.visibilityState !== 'hidden') void load();
  }, REFRESH_MS);
}

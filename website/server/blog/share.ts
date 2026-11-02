/**
 * "share this issue" in a post's comments header (or at the bottom of the post when comments
 * are off, pages.ts): one button that opens a menu of apps, each a compose-intent link that
 * opens that app's composer with the issue's title and address already written, so a reader
 * can post about it.
 *
 * The apps are Aturi's waypoints (aturi.to/api/waypoints?capability=compose): atmosphere
 * apps known to answer /intent/compose?text=, Bluesky first. The menu is a <details>, so it
 * opens without JavaScript; src/blog/share.ts closes it on a click outside or Escape, opens
 * it upward when there's no room below, and puts the app a reader last picked at the top.
 *
 * The list is read once an hour per instance under a short deadline. When Aturi doesn't
 * answer the page still gets Bluesky, which is built in (a plain link then, not a menu of
 * one), and asks again in a few minutes. Apps that open a composer but drop the text
 * (prefillsText: false) are left out, since they'd share nothing. Every template is checked
 * to be https before it's filled.
 */

import { TtlCache, type Fetch } from './atproto.js';
import { escapeAttr, escapeHtml, httpUrl } from './html.js';

export const WAYPOINTS_URL = 'https://aturi.to/api/waypoints?capability=compose';
export const WAYPOINTS_TTL_MS = 60 * 60_000;
/** After Aturi didn't answer: Bluesky alone, until it's asked again. */
export const WAYPOINTS_RETRY_MS = 5 * 60_000;
export const WAYPOINTS_DEADLINE_MS = 2000;
export const MAX_SHARE_APPS = 12;
/** Bluesky counts graphemes up to 300; the title gets what the name and address leave. */
export const MAX_SHARE_TITLE = 180;
const TEXT_SLOT = '{text}';

export interface ShareApp {
  /** Aturi's waypoint id, which src/blog/share.ts remembers. */
  id: string;
  /** Lowercase, like everything else on the site. */
  name: string;
  /** An https URL with one {text} where the encoded text goes. */
  template: string;
}

export const BLUESKY_APP: ShareApp = { id: 'bluesky', name: 'bluesky', template: `https://bsky.app/intent/compose?text=${TEXT_SLOT}` };

export const SHARE_COPY = {
  /** The button: "share this issue", just "share" on a phone (the rest is .post-share__long). */
  button: ['share', ' this issue'],
  single: (name: string) => `share on ${name}`,
  label: 'share on',
  fine: 'apps from',
} as const;

const ARROW =
  '<svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17L17 7M9 7h8v8"/></svg>';
const SHARE_ICON =
  '<svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15V4M7.5 8.5 12 4l4.5 4.5M5 13v5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5"/></svg>';
const CHEVRON =
  '<svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>';

/** One waypoint from Aturi as an app to share from, or null if it can't take the text. */
export function toShareApp(value: unknown): ShareApp | null {
  const w = value as { id?: unknown; name?: unknown; composeIntent?: { urlTemplate?: unknown; prefillsText?: unknown } | null };
  if (typeof w?.id !== 'string' || !/^[a-z0-9-]{1,40}$/.test(w.id)) return null;
  if (typeof w.name !== 'string' || !w.name.trim() || w.name.length > 40) return null;
  const template = w.composeIntent?.urlTemplate;
  if (w.composeIntent?.prefillsText !== true || typeof template !== 'string') return null;
  if (template.split(TEXT_SLOT).length !== 2) return null;
  const sample = httpUrl(template.replace(TEXT_SLOT, 'x'));
  if (!sample?.startsWith('https://')) return null;
  return { id: w.id, name: w.name.trim().toLowerCase(), template };
}

/** Bluesky first (Aturi's own entry for it when there is one), then the rest in Aturi's order. */
export function shareApps(body: unknown): ShareApp[] {
  const list = (body as { waypoints?: unknown })?.waypoints;
  const apps: ShareApp[] = [];
  const seen = new Set<string>();
  for (const item of Array.isArray(list) ? list : []) {
    const app = toShareApp(item);
    if (!app || seen.has(app.id)) continue;
    seen.add(app.id);
    apps.push(app);
  }
  const bluesky = apps.find((a) => a.id === BLUESKY_APP.id) ?? BLUESKY_APP;
  return [bluesky, ...apps.filter((a) => a !== bluesky)].slice(0, MAX_SHARE_APPS);
}

const cache = new TtlCache<Promise<ShareApp[]>>(WAYPOINTS_TTL_MS);
const retry = new TtlCache<ShareApp[]>(WAYPOINTS_RETRY_MS);

/** Test hook. */
export function resetShareCache(): void {
  cache.clear();
  retry.clear();
}

/** The apps to offer, never failing: Bluesky alone whenever Aturi can't be read. */
export function loadShareApps(doFetch: Fetch): Promise<ShareApp[]> {
  const fallback = retry.get('apps');
  if (fallback) return Promise.resolve(fallback);
  const cached = cache.get('apps');
  if (cached) return cached;
  const pending = (async () => {
    const res = await doFetch(WAYPOINTS_URL, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(WAYPOINTS_DEADLINE_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return shareApps(await res.json());
  })().catch(() => {
    cache.delete('apps');
    return retry.set('apps', [BLUESKY_APP]);
  });
  return cache.set('apps', pending);
}

/** What the composer opens with: the dispatch's name, the issue's title, and its address. */
export function shareText(siteName: string, title: string, url: string): string {
  const flat = title.replace(/\s+/g, ' ').trim();
  const clipped = [...flat].length > MAX_SHARE_TITLE ? `${[...flat].slice(0, MAX_SHARE_TITLE - 1).join('').trimEnd()}…` : flat;
  return `${siteName}: ${clipped}\n\n${url}`;
}

export function composeUrl(app: ShareApp, text: string): string {
  return app.template.replace(TEXT_SLOT, encodeURIComponent(text));
}

/**
 * The share menu. Every link opens in a new tab, so the issue
 * stays open. With only Bluesky to offer, it's a plain "share on bluesky" link instead.
 */
export function shareHtml(apps: readonly ShareApp[], text: string): string {
  const list = apps.length ? apps : [BLUESKY_APP];
  const link = (app: ShareApp, attrs: string, inner: string) =>
    `<a ${attrs} href="${escapeAttr(composeUrl(app, text))}" target="_blank" rel="noopener" data-share-app="${escapeAttr(app.id)}">${inner}</a>`;
  if (list.length === 1) {
    const only = list[0]!;
    return `<div class="post-share">${link(only, 'class="btn btn--outline btn--sm"', `${SHARE_ICON}${escapeHtml(SHARE_COPY.single(only.name))}${ARROW}`)}</div>`;
  }
  return (
    `<details class="post-share" data-blog-share>` +
    `<summary class="btn btn--outline btn--sm post-share__toggle">${SHARE_ICON}<span>${escapeHtml(SHARE_COPY.button[0])}<span class="post-share__long">${escapeHtml(SHARE_COPY.button[1])}</span></span><span class="post-share__chevron">${CHEVRON}</span></summary>` +
    `<div class="post-share__menu">` +
    `<p class="post-share__label" id="post-share-label">${escapeHtml(SHARE_COPY.label)}</p>` +
    `<ul class="post-share__list" role="list" aria-labelledby="post-share-label" data-share-list>` +
    list.map((app) => `<li>${link(app, 'class="post-share__app"', `${escapeHtml(app.name)}${ARROW}`)}</li>`).join('') +
    `</ul>` +
    `<p class="post-share__fine">${escapeHtml(SHARE_COPY.fine)} <a href="https://aturi.to">aturi</a></p>` +
    `</div>` +
    `</details>`
  );
}

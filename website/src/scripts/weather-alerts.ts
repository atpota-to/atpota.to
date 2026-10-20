/**
 * Weather alerts on the weather report (/weather): a card that slides up in the bottom
 * left corner (Poe lives in the bottom right) with a little burst of leaves, when
 * something happens in the sky:
 *
 *   arrival  an app outside Bluesky shows up in the live 60 seconds that this visit
 *            hasn't seen yet ("delve.town just blew in")
 *   new      the station hears an app for the very first time (the almanac's
 *            "new in the atmosphere", once the station has warmed up)
 *   storm    new records a second climb into "stormy"
 *   mixed    the diversity index climbs a level
 *
 * The first reading of a visit only sets the scene; alerts come from what changes after
 * it. One card at a time, at least GAP_MS apart, each gone after ALERT_MS (held while
 * it's hovered or focused); a small queue keeps the most important ones. The reader can
 * hush them, and that sticks in this browser (localStorage ALERTS_KEY).
 *
 * The cards sit in a polite live region, so screen readers hear them without losing
 * their place. Under reduced motion they just appear and go, with no leaves. App and
 * collection names are other people's text and only reach the DOM through textContent.
 */

import { burst, cheer } from './burst';
import { formatIndex, ratioText, recordsPerSecond, type DiversityLevel, type Reading } from './weather';

export const ALERT_MS = 7000;
export const GAP_MS = 15_000;
export const MAX_QUEUE = 2;
export const ALERTS_KEY = 'weather:alerts';
const LEAVE_MS = 260;

export type AlertKind = 'arrival' | 'new' | 'storm' | 'mixed';

export interface WeatherAlert {
  kind: AlertKind;
  eyebrow: string;
  title: string;
  sub: string;
}

/** Which alert wins a place in a full queue. */
const RANK: Record<AlertKind, number> = { storm: 3, new: 2, mixed: 1, arrival: 0 };
const LEVELS: DiversityLevel[] = ['low', 'moderate', 'high', 'very high', 'extreme'];

// ---------- what's worth an alert ----------

export interface Watch {
  /** Apps this visit has already seen in the live readings. */
  seen: Set<string>;
  condition: Reading['condition'];
  level: DiversityLevel | null;
}

/**
 * What changed between the last reading and this one, as alerts, busiest first, and the
 * state to compare the next reading with. `prev` null is the visit's first reading.
 */
export function alertsFor(prev: Watch | null, r: Reading): { watch: Watch; alerts: WeatherAlert[] } {
  const apps = r.source === 'station' ? (r.apps ?? []) : [];
  const watch: Watch = { seen: new Set(prev?.seen), condition: r.condition, level: r.diversity?.level ?? null };
  const fresh = apps.filter((a) => !watch.seen.has(a.domain));
  for (const a of apps) watch.seen.add(a.domain);
  if (!prev) return { watch, alerts: [] };
  const alerts: WeatherAlert[] = [];
  if (r.condition === 'stormy' && prev.condition !== 'stormy') {
    alerts.push({ kind: 'storm', eyebrow: 'storm warning', title: 'a storm just rolled in', sub: `${Math.round(recordsPerSecond(r))} new records a second. somebody said something.` });
  }
  const level = r.diversity?.level;
  if (level && prev.level && LEVELS.indexOf(level) > LEVELS.indexOf(prev.level) && r.records) {
    alerts.push({ kind: 'mixed', eyebrow: 'weather alert', title: `the sky's getting mixed: ${level}`, sub: `diversity index ${formatIndex(r.diversity!.index)}. ${ratioText(r.records)}.` });
  }
  const app = fresh[0];
  if (app) {
    const records = `${app.count.toLocaleString('en-US')} record${app.count === 1 ? '' : 's'} in the last minute`;
    alerts.push({ kind: 'arrival', eyebrow: 'weather alert', title: `${app.domain} just blew in`, sub: app.collections[0] ? `${records}: ${app.collections[0]}` : records });
  }
  return { watch, alerts };
}

/** An alert for an app the station has just heard for the very first time. */
export function newAppAlert(domain: string, at: string): WeatherAlert {
  return { kind: 'new', eyebrow: 'new in the atmosphere', title: `${domain} is brand new here`, sub: `the station heard it for the first time at ${at}.` };
}

// ---------- hushing ----------

export function alertsHushed(win: Window = window): boolean {
  try {
    return win.localStorage.getItem(ALERTS_KEY) === 'off';
  } catch {
    return false;
  }
}

export function setAlertsHushed(hushed: boolean, win: Window = window): void {
  try {
    if (hushed) win.localStorage.setItem(ALERTS_KEY, 'off');
    else win.localStorage.removeItem(ALERTS_KEY);
  } catch {
    // a private window: the hush lasts for this page only
  }
}

// ---------- the cards ----------

function reducedMotion(win: Window): boolean {
  return typeof win.matchMedia === 'function' && win.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

const SVG = 'http://www.w3.org/2000/svg';

function icon(doc: Document, kind: AlertKind): SVGSVGElement {
  const svg = doc.createElementNS(SVG, 'svg');
  svg.setAttribute('class', 'weather-alert__icon');
  svg.setAttribute('viewBox', '0 0 100 100');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const cloud = doc.createElementNS(SVG, 'path');
  cloud.setAttribute('class', 'weather-alert__cloud');
  cloud.setAttribute('d', 'M28 74 C16 74 10 66 10 58 C10 49 17 43 26 43 C28 32 38 25 49 25 C61 25 70 33 72 44 C81 44 88 51 88 59 C88 68 81 74 72 74 Z');
  svg.append(cloud);
  const mark = doc.createElementNS(SVG, 'path');
  mark.setAttribute('class', 'weather-alert__mark');
  // a bolt for a storm, a gust of wind for everything else
  mark.setAttribute('d', kind === 'storm' ? 'M52 52 L42 70 H54 L46 90' : 'M14 88 H58 a8 8 0 1 0 -8 -8 M24 96 H44');
  svg.append(mark);
  return svg;
}

export interface AlertDesk {
  push(alert: WeatherAlert): void;
  /** True once the reader has hushed alerts. */
  readonly hushed: boolean;
  hush(): void;
  unhush(): void;
  /** Called with the new state whenever it changes (the hush button follows it). */
  onHushChange(fn: (hushed: boolean) => void): void;
}

/** The cards, in `region` (a polite live region). `now` is for tests. */
export function createAlertDesk(region: HTMLElement, win: Window = window, now: () => number = () => Date.now()): AlertDesk {
  const doc = region.ownerDocument;
  let hushed = alertsHushed(win);
  let queue: WeatherAlert[] = [];
  let showing: HTMLElement | null = null;
  let lastShown = -Infinity;
  let wait: number | undefined;
  const listeners: Array<(hushed: boolean) => void> = [];

  const next = () => {
    if (showing || hushed || !queue.length) return;
    const delay = Math.max(0, lastShown + GAP_MS - now());
    win.clearTimeout(wait);
    if (delay > 0) {
      wait = win.setTimeout(next, delay);
      return;
    }
    show(queue.shift()!);
  };

  const dismiss = (card: HTMLElement) => {
    if (showing !== card) return;
    showing = null;
    if (reducedMotion(win)) card.remove();
    else {
      card.classList.add('is-leaving');
      win.setTimeout(() => card.remove(), LEAVE_MS);
    }
    next();
  };

  function show(a: WeatherAlert): void {
    lastShown = now();
    const card = doc.createElement('div');
    card.className = 'weather-alert';
    card.dataset.kind = a.kind;
    const pic = icon(doc, a.kind);
    const eyebrow = doc.createElement('p');
    eyebrow.className = 'weather-alert__eyebrow';
    eyebrow.textContent = a.eyebrow;
    const title = doc.createElement('p');
    title.className = 'weather-alert__title';
    title.textContent = a.title;
    const sub = doc.createElement('p');
    sub.className = 'weather-alert__sub';
    sub.textContent = a.sub;
    const quiet = doc.createElement('button');
    quiet.type = 'button';
    quiet.className = 'weather-alert__hush';
    quiet.textContent = 'hush alerts';
    quiet.addEventListener('click', () => desk.hush());
    const close = doc.createElement('button');
    close.type = 'button';
    close.className = 'weather-alert__close';
    close.setAttribute('aria-label', 'dismiss the alert');
    close.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M6 6l12 12M18 6L6 18"/></svg>';
    close.addEventListener('click', () => dismiss(card));
    card.append(pic, eyebrow, title, sub, quiet, close);
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') dismiss(card);
    });

    // Gone after ALERT_MS, but not while someone's reading it.
    let left = ALERT_MS;
    let started = now();
    let timer = win.setTimeout(() => dismiss(card), left);
    const hold = () => {
      win.clearTimeout(timer);
      left -= now() - started;
    };
    const go = () => {
      started = now();
      timer = win.setTimeout(() => dismiss(card), Math.max(1500, left));
    };
    card.addEventListener('pointerenter', hold);
    card.addEventListener('pointerleave', go);
    card.addEventListener('focusin', hold);
    card.addEventListener('focusout', (e) => {
      if (!card.contains(e.relatedTarget as Node | null)) go();
    });

    showing = card;
    region.append(card);
    burst(pic, 'leaves', win);
    if (a.kind === 'new') cheer(win);
  }

  const desk: AlertDesk = {
    push(alert) {
      if (hushed) return;
      queue.push(alert);
      // Keep the most important ones; among equals, the newest.
      queue = queue
        .map((a, i) => ({ a, i }))
        .sort((x, y) => RANK[y.a.kind] - RANK[x.a.kind] || y.i - x.i)
        .slice(0, MAX_QUEUE)
        .sort((x, y) => RANK[y.a.kind] - RANK[x.a.kind] || x.i - y.i)
        .map((x) => x.a);
      next();
    },
    get hushed() {
      return hushed;
    },
    hush() {
      hushed = true;
      setAlertsHushed(true, win);
      queue = [];
      win.clearTimeout(wait);
      if (showing) dismiss(showing);
      listeners.forEach((fn) => fn(true));
    },
    unhush() {
      hushed = false;
      setAlertsHushed(false, win);
      listeners.forEach((fn) => fn(false));
    },
    onHushChange(fn) {
      listeners.push(fn);
    },
  };
  return desk;
}
